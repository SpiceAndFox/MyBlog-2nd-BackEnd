const {
  TARGETS, PROPOSER_EVIDENCE_KINDS, SCENE_FIELDS,
  TYPED_PROFILE_SECTIONS, PROFILE_FACT_BASES, PROFILE_FACETS, PROFILE_CANONICAL_KEYS,
} = require("../../contracts");
const { buildDueAtSchema } = require("../../contracts/dueAt");

const refSchema = { type: "object", additionalProperties: false, required: ["messageId", "quote"], properties: { messageId: { type: "integer", minimum: 0 }, quote: { type: "string", minLength: 1, maxLength: 200 } } };
const textValue = { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", minLength: 1 } } };
function typedProfileValue(section) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["text", "facet", "canonicalKey", "factBasis"],
    properties: {
      text: { type: "string", minLength: 1 },
      facet: { enum: PROFILE_FACETS[section] },
      canonicalKey: { enum: PROFILE_CANONICAL_KEYS[section] },
      factBasis: { enum: PROFILE_FACT_BASES },
    },
  };
}
const dueAt = buildDueAtSchema();
const dueChange = { oneOf: [
  { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { const: "keep" } } },
  { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { const: "clear" } } },
  { type: "object", additionalProperties: false, required: ["mode", "dueAt"], properties: { mode: { const: "set" }, dueAt } },
] };

const OPS = Object.freeze({
  currentStateProposer: { scene: ["setField", "clearField"] },
  todoProposer: { todos: ["addItem", "updateItem", "completeTodo", "cancelTodo", "expireTodo"] },
  agreementProposer: { standingAgreements: ["addItem", "updateItem", "cancelAgreement"] },
  episodeProposer: { recentEpisodes: ["addItem", "updateItem"], milestones: ["addItem", "updateItem"] },
  profileRelationshipProposer: { userProfile: ["addItem", "updateItem", "forgetItem"], assistantProfile: ["addItem", "updateItem", "forgetItem"], relationship: ["addItem", "updateItem", "forgetItem"] },
  worldFactProposer: { worldFacts: ["addItem", "updateItem", "forgetItem"] },
});

function patchSchema(proposer, section, op) {
  const evidenceProperty = section === "scene"
    ? { evidenceRef: refSchema }
    : { evidenceRefs: { type: "array", minItems: 1, items: refSchema } };
  const evidenceKey = section === "scene" ? "evidenceRef" : "evidenceRefs";
  const properties = { op: { const: op }, evidenceKind: { enum: PROPOSER_EVIDENCE_KINDS[proposer] }, ...evidenceProperty };
  const required = ["op", "evidenceKind", evidenceKey];
  if (["setField", "clearField"].includes(op)) { properties.path = { enum: SCENE_FIELDS }; required.push("path"); }
  if (["updateItem", "forgetItem", "completeTodo", "cancelTodo", "expireTodo", "cancelAgreement"].includes(op)) { properties.itemId = { type: "string", minLength: 1 }; required.push("itemId"); }
  if (["setField", "addItem", "updateItem"].includes(op)) {
    if (op === "setField") properties.value = { type: "string", minLength: 1 };
    else if (section === "todos" && op === "addItem") properties.value = { type: "object", additionalProperties: false, required: ["text", "actor", "requester"], properties: { text: { type: "string", minLength: 1 }, actor: { enum: ["user", "assistant", "both"] }, requester: { enum: ["user", "assistant"] }, dueAt } };
    else if (section === "todos") properties.value = { type: "object", additionalProperties: false, required: ["dueChange"], properties: { text: { type: "string", minLength: 1 }, actor: { enum: ["user", "assistant", "both"] }, requester: { enum: ["user", "assistant"] }, dueChange } };
    else if (TYPED_PROFILE_SECTIONS.includes(section)) properties.value = typedProfileValue(section);
    else properties.value = textValue;
    required.push("value");
  }
  return { type: "object", additionalProperties: false, required, properties };
}
function compactionPatchSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["op", "itemIds", "value", "evidenceKind"],
    properties: {
      op: { const: "mergeItems" },
      itemIds: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string", minLength: 1 } },
      value: textValue,
      evidenceKind: { const: "memory_compaction" },
    },
  };
}

function buildOutputSchema(proposer, targetSections) {
  if (proposer === "compactionProposer") {
    if (!Array.isArray(targetSections) || targetSections.length !== 1) throw new Error("Compaction schema requires exactly one target section");
    const [section] = targetSections;
    return {
      name: `memory_compaction_${section}`,
      strict: true,
      schema: {
        type: "object", additionalProperties: false, required: ["tickId", "proposer", "sectionResults"],
        properties: {
          tickId: { type: "integer" }, proposer: { const: "compactionProposer" },
          sectionResults: {
            type: "object", additionalProperties: false, required: [section], properties: {
              [section]: { oneOf: [
                { type: "object", additionalProperties: false, required: ["status", "patches"], properties: { status: { const: "patches" }, patches: { type: "array", minItems: 1, items: compactionPatchSchema() } } },
                { type: "object", additionalProperties: false, required: ["status"], properties: { status: { const: "unable_to_compact" } } },
              ] },
            },
          },
        },
      },
    };
  }
  const target = Object.values(TARGETS).find((entry) => entry.proposer === proposer);
  if (!target || !OPS[proposer]) throw new Error(`Unknown normal Memory proposer: ${proposer}`);
  const sectionProperties = {};
  for (const section of target.sections) {
    sectionProperties[section] = { oneOf: [
      { type: "object", additionalProperties: false, required: ["status", "patches"], properties: { status: { const: "patches" }, patches: { type: "array", minItems: 1, items: { oneOf: OPS[proposer][section].map((op) => patchSchema(proposer, section, op)) } } } },
      { type: "object", additionalProperties: false, required: ["status"], properties: { status: { const: "noop" } } },
      { type: "object", additionalProperties: false, required: ["status"], properties: { status: { const: "unable_to_decide" } } },
    ] };
  }
  return {
    name: `memory_${proposer}`,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["tickId", "proposer", "sectionResults"],
      properties: {
        tickId: { type: "integer" },
        proposer: { const: proposer },
        sectionResults: {
          type: "object",
          additionalProperties: false,
          required: target.sections,
          properties: sectionProperties,
        },
      },
    },
  };
}

module.exports = { buildOutputSchema, OPS };
