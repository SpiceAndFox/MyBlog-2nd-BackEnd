const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SAFE_NORMALIZATIONS,
  normalizeSemanticOutput,
} = require("../../../modules/memory/application/outputRepair");

test("empty changes deterministically normalize to noop without mutating provider output", () => {
  const source = {
    tickId: 1,
    proposer: "todoProposer",
    sectionResults: { todos: { status: "changes", changes: [] } },
  };
  const normalized = normalizeSemanticOutput(source);

  assert.deepEqual(normalized.output.sectionResults.todos, { status: "noop" });
  assert.deepEqual(source.sectionResults.todos, { status: "changes", changes: [] });
  assert.deepEqual(normalized.applied, [{
    code: SAFE_NORMALIZATIONS.EMPTY_CHANGES_TO_NOOP,
    section: "todos",
  }]);
});

test("empty source arrays are removed but no evidence is invented", () => {
  const normalized = normalizeSemanticOutput({
    tickId: 1,
    proposer: "worldFactProposer",
    sectionResults: {
      worldFacts: {
        status: "changes",
        changes: [{
          action: "add",
          text: "fact",
          evidenceMessageIds: [],
          supportRefs: [],
        }],
      },
    },
  });
  const [change] = normalized.output.sectionResults.worldFacts.changes;

  assert.equal(Object.hasOwn(change, "evidenceMessageIds"), false);
  assert.equal(Object.hasOwn(change, "supportRefs"), false);
  assert.equal(normalized.applied.length, 2);
});
