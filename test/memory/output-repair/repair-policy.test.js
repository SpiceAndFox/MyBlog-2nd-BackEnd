const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ISSUE_CODES,
  OUTPUT_REPAIR_POLICY_VERSION,
  createRepairFeedback,
  renderRepairInstruction,
  summarizeOutputShape,
} = require("../../../modules/memory/application/outputRepair");

test("repair feedback is versioned, coded, bounded, and contains no rejected output", () => {
  const feedback = createRepairFeedback({
    specialist: "relationshipProposer",
    errors: [
      {
        code: ISSUE_CODES.SECTION_RESULTS_NOT_OBJECT,
        path: "$.sectionResults",
        message: "must be an object",
      },
      {
        code: ISSUE_CODES.TEXT_LENGTH_EXCEEDED,
        path: "$.sectionResults.relationship.changes[0].text",
        message: "must contain at most 240 characters for relationship",
        meta: { limit: 240, actual: 292, section: "relationship" },
      },
    ],
    rawOutput: "must-not-persist",
  }, 1, {
    proposer: "profileRelationshipProposer",
    targetSections: ["userProfile", "assistantProfile", "relationship"],
  });

  assert.equal(feedback.policyVersion, OUTPUT_REPAIR_POLICY_VERSION);
  assert.equal(feedback.specialist, "relationshipProposer");
  assert.deepEqual(feedback.plan.issueCodes, [
    ISSUE_CODES.SECTION_RESULTS_NOT_OBJECT,
    ISSUE_CODES.TEXT_LENGTH_EXCEEDED,
  ]);
  assert.equal(JSON.stringify(feedback).includes("must-not-persist"), false);
});

test("repair instruction uses the actual specialist schema shape and positive constraints", () => {
  const feedback = createRepairFeedback({
    specialist: "relationshipProposer",
    errors: [
      {
        code: ISSUE_CODES.SECTION_RESULTS_NOT_OBJECT,
        path: "$.sectionResults",
        message: "must be an object",
      },
      {
        code: ISSUE_CODES.TEXT_LENGTH_EXCEEDED,
        path: "$.sectionResults.relationship.changes[0].text",
        message: "must contain at most 240 characters for relationship",
        meta: { limit: 240, actual: 292, section: "relationship" },
      },
    ],
  }, 1, {
    proposer: "profileRelationshipProposer",
    targetSections: ["userProfile", "assistantProfile", "relationship"],
  });
  const prompt = renderRepairInstruction("base", feedback, {
    proposer: "relationshipProposer",
    targetSections: ["relationship"],
  });

  assert.match(prompt, /\[SCHEMA_REPAIR_V1\]/);
  assert.match(prompt, /Unicode 字符数不得超过 240/);
  assert.match(prompt, /"proposer":"relationshipProposer"/);
  assert.match(prompt, /"relationship":"<complete section result>"/);
  assert.doesNotMatch(prompt, /userProfile|assistantProfile|profileRelationshipProposer/);
});

test("output-shape diagnostics expose structure without output values", () => {
  assert.deepEqual(summarizeOutputShape({
    tickId: 7,
    proposer: "todoProposer",
    sectionResults: { todos: "secret value" },
  }), {
    rootType: "object",
    topLevelKeys: ["proposer", "sectionResults", "tickId"],
    sectionResultsType: "object",
    sectionKeys: ["todos"],
  });
  const hostile = summarizeOutputShape({
    tickId: 7,
    "raw-secret-as-key": true,
    sectionResults: { todos: {}, "another-secret": {} },
  });
  assert.equal(JSON.stringify(hostile).includes("secret"), false);
  assert.equal(hostile.unexpectedTopLevelKeyCount, 1);
  assert.equal(hostile.unexpectedSectionKeyCount, 1);
});
