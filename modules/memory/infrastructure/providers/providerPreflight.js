const { isDeepStrictEqual } = require("node:util");
const {
  TARGETS,
  LIBRARIAN_PROPOSER,
  LIBRARIAN_SECTIONS,
  LIBRARIAN_TARGET_KEY,
} = require("../../contracts");
const { validateSemanticResult } = require("../../contracts/semantic");
const { usesTodoWireProtocol } = require("../../contracts/outputProtocol");
const { semanticToTodoWire, todoWireToSemantic } = require("./todoWireProtocol");
const { validateProviderWireOutput } = require("./validateProviderWireOutput");
const { buildOutputSchema } = require("./outputSchema");
const { bindOutputSchema } = require("./bindOutputSchema");
const { isSafetySignal, isTruncationSignal } = require("./providerProtocol");
const {
  flatWireToSemanticOutput,
  semanticOutputToFlatWire,
} = require("./flatWireProtocol");

const PROFILE_SPECIALISTS = Object.freeze([
  Object.freeze({ proposer: "userProfileProposer", section: "userProfile" }),
  Object.freeze({ proposer: "assistantProfileProposer", section: "assistantProfile" }),
  Object.freeze({ proposer: "relationshipProposer", section: "relationship" }),
]);

function normalCase(targetKey, definition, tickId) {
  const task = {
    targetKey,
    proposer: definition.proposer,
    targetSections: definition.sections,
    tickId,
    mode: "normal",
  };
  const output = {
    tickId,
    proposer: definition.proposer,
    sectionResults: Object.fromEntries(definition.sections.map((section) => [section, { status: "noop" }])),
  };
  return { name: targetKey, task, output, responseSchema: buildOutputSchema(definition.proposer, definition.sections) };
}

function todoPreflightCases() {
  // Synthetic probe limits, independent of production data and persistence.
  const task = { targetKey: "todos", targetSections: ["todos"], proposer: "todoProposer",
    tickId: 1, writeLimits: { todos: { maxItemChars: 200, maxSourceRefs: 4 } } };
  const probes = [
    ["noop", { status: "noop" }],
    ["add-relative", { status: "changes", changes: [{ action: "add", text: "归还图书", actor: "user", requester: "user", dueAt: { mode: "relative", days: 1 }, anchorMessageId: 101, evidenceMessageIds: [101] }] }],
    ["revise-keep", { status: "changes", changes: [{ action: "revise", ref: "T1", actor: "both", dueChange: { mode: "keep" }, evidenceMessageIds: [101] }] }],
    ["complete", { status: "changes", changes: [{ action: "complete", ref: "T1", evidenceMessageIds: [101] }] }],
  ];
  return probes.map(([name, result]) => ({ name: `todos:${name}`, task,
    output: { tickId: task.tickId, proposer: task.proposer, sectionResults: { todos: result } },
    responseSchema: bindOutputSchema(buildOutputSchema(task.proposer, task.targetSections), {
      publicInput: { task }, messageMeta: { 101: {} },
      refMap: { writable: { T1: { section: "todos" } }, readOnly: {} },
    }) }));
}

function preflightCases() {
  const cases = [];
  for (const [targetKey, definition] of Object.entries(TARGETS)) {
    if (targetKey !== "profileRelationship") {
      cases.push(normalCase(targetKey, definition, cases.length + 1));
      continue;
    }
    for (const specialist of PROFILE_SPECIALISTS) {
      cases.push(normalCase(targetKey, { proposer: specialist.proposer, sections: [specialist.section] }, cases.length + 1));
      cases.at(-1).name = `${targetKey}:${specialist.section}`;
    }
  }
  const tickId = cases.length + 1;
  const task = { targetKey: "todos", proposer: "compactionProposer", targetSections: ["todos"], tickId, mode: "maintenance" };
  cases.push({
    name: "compaction:todos",
    task,
    output: { tickId, proposer: "compactionProposer", sectionResults: { todos: { status: "unable_to_compact" } } },
    responseSchema: buildOutputSchema("compactionProposer", ["todos"]),
  });
  const librarianTickId = cases.length + 1;
  cases.push({
    name: "librarian",
    task: {
      targetKey: LIBRARIAN_TARGET_KEY,
      proposer: LIBRARIAN_PROPOSER,
      targetSections: LIBRARIAN_SECTIONS.slice(),
      tickId: librarianTickId,
      mode: "librarian",
    },
    output: { tickId: librarianTickId, proposer: LIBRARIAN_PROPOSER, status: "noop", operations: [] },
    responseSchema: buildOutputSchema(LIBRARIAN_PROPOSER),
  });
  return cases;
}

async function runStructuredOutputPreflight({ invokeStructured, promptLoader, todoOnly = false } = {}) {
  if (typeof invokeStructured !== "function") throw new Error("Preflight invokeStructured is required");
  if (typeof promptLoader !== "function") throw new Error("Preflight promptLoader is required");
  const results = [];
  for (const probe of todoOnly ? todoPreflightCases() : [...preflightCases(), ...todoPreflightCases().slice(1)]) {
    const expectedWireOutput = usesTodoWireProtocol(probe.task) ? semanticToTodoWire(probe.output) : semanticOutputToFlatWire(probe.output, probe.task);
    const response = await invokeStructured({
      proposer: probe.task.proposer,
      systemPrompt: `${await promptLoader(probe.task.proposer)}\n\n[PREFLIGHT]\nReturn exactly userPayload.expectedOutput through the required schema-constrained output channel. Do not add fields.`,
      userPayload: { expectedOutput: expectedWireOutput },
      responseSchema: probe.responseSchema,
    });
    if (response?.refusal || response?.safetyBlocked || isSafetySignal(response?.finishReason)) throw new Error(`Provider refused structured-output preflight case: ${probe.name}`);
    if (isTruncationSignal(response?.finishReason)) throw new Error(`Provider truncated structured-output preflight case: ${probe.name}`);
    if (response?.transportError) throw new Error(`Provider transport did not return strict structured output for ${probe.name}`);
    const wire = validateProviderWireOutput(probe.responseSchema, response?.output);
    if (!wire.ok) throw new Error(`Provider returned schema-invalid wire output for ${probe.name}: ${JSON.stringify(wire.errors)}`);
    const semanticOutput = usesTodoWireProtocol(probe.task) ? todoWireToSemantic(wire.output, probe.task) : flatWireToSemanticOutput(response?.output, probe.task);
    const validation = validateSemanticResult(semanticOutput, probe.task);
    if (!validation.ok) {
      const error = new Error(`Provider returned schema-invalid preflight output for ${probe.name}`);
      error.detail = {
        validationErrors: validation.errors,
        finishReason: response?.finishReason ?? null,
        transportError: response?.transportError ?? null,
        transportRecovery: response?.transportRecovery ?? null,
      };
      throw error;
    }
    if (!isDeepStrictEqual(response.output, expectedWireOutput)) {
      throw new Error(`Provider did not follow the exact preflight branch for ${probe.name}`);
    }
    results.push({
      name: probe.name,
      proposer: probe.task.proposer,
      model: response.model ?? null,
      schema: probe.responseSchema.name,
      finishReason: response.finishReason ?? null,
      outputChannel: response.outputChannel ?? null,
      usage: response.usage ?? null,
    });
  }
  return results;
}

module.exports = { preflightCases, todoPreflightCases, runStructuredOutputPreflight };
