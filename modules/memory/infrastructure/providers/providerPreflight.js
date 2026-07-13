const { isDeepStrictEqual } = require("node:util");
const { TARGETS } = require("../../contracts");
const { validateProposerOutput } = require("../../contracts/proposal");
const { buildOutputSchema } = require("./outputSchema");

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
    if (response?.refusal || response?.safetyBlocked) throw new Error(`Provider refused structured-output preflight case: ${probe.name}`);
    if (["length", "max_tokens", "max_output_tokens"].includes(response?.finishReason)) throw new Error(`Provider truncated structured-output preflight case: ${probe.name}`);
    const validation = validateProposerOutput(response?.output, probe.task);
    if (!validation.ok) {
      const error = new Error(`Provider returned schema-invalid preflight output for ${probe.name}`);
      error.detail = validation.errors;
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
