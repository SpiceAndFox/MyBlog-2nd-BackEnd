const { isDeepStrictEqual } = require("node:util");
const { TARGETS, SEMANTIC_NORMAL_PROPOSERS } = require("../../contracts");
const { validateProposerOutput } = require("../../contracts/proposal");
const { validateSemanticResult } = require("../../contracts/semantic");
const { buildOutputSchema } = require("./outputSchema");
const { normalizeProviderOutput } = require("./memoryProviderAdapter");
const { isSafetySignal, isTruncationSignal } = require("./providerProtocol");

function normalCase(targetKey, definition, tickId) {
  const task = {
    targetKey,
    proposer: definition.proposer,
    targetSections: definition.sections,
    tickId,
    mode: "normal",
  };
  const output = targetKey === "scene"
    ? {
      tickId,
      proposer: definition.proposer,
      sectionResults: { scene: { status: "patches", patches: [{
        op: "setField",
        path: "location",
        value: "屋顶",
        evidenceKind: "scene_change",
        evidenceRef: { messageId: 1, quote: "来到屋顶" },
      }] } },
    }
    : {
      tickId,
      proposer: definition.proposer,
      sectionResults: Object.fromEntries(definition.sections.map((section) => [section, { status: "noop" }])),
    };
  return { name: targetKey, task, output, responseSchema: buildOutputSchema(definition.proposer, definition.sections) };
}

function preflightCases() {
  const cases = Object.entries(TARGETS).map(([targetKey, definition], index) => normalCase(targetKey, definition, index + 1));
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
    const normalized = normalizeProviderOutput(response?.output, probe.task);
    const validation = SEMANTIC_NORMAL_PROPOSERS.includes(probe.task.proposer)
      ? validateSemanticResult(normalized, probe.task)
      : validateProposerOutput(normalized, probe.task);
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
    results.push({ name: probe.name, schema: probe.responseSchema.name, finishReason: response.finishReason ?? null });
  }
  return results;
}

module.exports = { preflightCases, runStructuredOutputPreflight };
