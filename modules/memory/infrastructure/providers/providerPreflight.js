const { isDeepStrictEqual } = require("node:util");
const { TARGETS } = require("../../contracts");
const { validateSemanticResult } = require("../../contracts/semantic");
const { buildOutputSchema } = require("./outputSchema");
const { isSafetySignal, isTruncationSignal } = require("./providerProtocol");

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
  return cases;
}

async function runStructuredOutputPreflight({ invokeStructured, promptLoader } = {}) {
  if (typeof invokeStructured !== "function") throw new Error("Preflight invokeStructured is required");
  if (typeof promptLoader !== "function") throw new Error("Preflight promptLoader is required");
  const results = [];
  for (const probe of preflightCases()) {
    const response = await invokeStructured({
      proposer: probe.task.proposer,
      systemPrompt: `${await promptLoader(probe.task.proposer)}\n\n[PREFLIGHT]\nReturn exactly userPayload.expectedOutput through the required schema-constrained output channel. Do not add fields.`,
      userPayload: { expectedOutput: probe.output },
      responseSchema: probe.responseSchema,
    });
    if (response?.refusal || response?.safetyBlocked || isSafetySignal(response?.finishReason)) throw new Error(`Provider refused structured-output preflight case: ${probe.name}`);
    if (isTruncationSignal(response?.finishReason)) throw new Error(`Provider truncated structured-output preflight case: ${probe.name}`);
    if (response?.transportError) throw new Error(`Provider transport did not return strict structured output for ${probe.name}`);
    const validation = validateSemanticResult(response?.output, probe.task);
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
    if (!isDeepStrictEqual(response.output, probe.output)) {
      throw new Error(`Provider did not follow the exact preflight branch for ${probe.name}`);
    }
    results.push({
      name: probe.name,
      proposer: probe.task.proposer,
      model: response.model ?? null,
      schema: probe.responseSchema.name,
      finishReason: response.finishReason ?? null,
    });
  }
  return results;
}

module.exports = { preflightCases, runStructuredOutputPreflight };
