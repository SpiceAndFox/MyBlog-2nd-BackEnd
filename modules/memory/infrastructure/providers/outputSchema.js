const {
  TARGETS, PROPOSER_EVIDENCE_KINDS, SCENE_FIELDS, SEMANTIC_NORMAL_PROPOSERS,
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

const semanticSourceProperties = Object.freeze({
  evidenceMessageIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", minimum: 1 } },
  supportRefs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
});

function semanticTextItemChangeSchema(action) {
  const properties = {
    action: { const: action },
    ...semanticSourceProperties,
  };
  const required = ["action"];
  if (action !== "add") {
    properties.ref = { type: "string", minLength: 1 };
    required.push("ref");
  }
  if (action !== "forget") {
    properties.text = { type: "string", minLength: 1 };
    required.push("text");
  }
  return {
    type: "object",
    additionalProperties: false,
    required,
    anyOf: [{ required: ["evidenceMessageIds"] }, { required: ["supportRefs"] }],
    properties,
  };
}

function semanticTextItemResultSchema({ maxItems } = {}) {
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["status", "changes"],
        properties: {
          status: { const: "changes" },
          changes: {
            type: "array",
            minItems: 1,
            ...(maxItems ? { maxItems } : {}),
            items: { oneOf: ["add", "update", "correct", "forget"].map(semanticTextItemChangeSchema) },
          },
        },
      },
      { type: "object", additionalProperties: false, required: ["status"], properties: { status: { const: "noop" } } },
      { type: "object", additionalProperties: false, required: ["status"], properties: { status: { const: "unable_to_decide" } } },
    ],
  };
}

function buildTextItemSemanticOutputSchema(proposer, sections, { maxItemsBySection = {} } = {}) {
  return {
    name: `memory_${proposer}_semantic`,
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
          required: sections,
          properties: Object.fromEntries(sections.map((section) => [section, semanticTextItemResultSchema({
            maxItems: maxItemsBySection[section],
          })])),
        },
      },
    },
  };
}

function buildEpisodeSemanticOutputSchema() {
  return buildTextItemSemanticOutputSchema(
    "episodeProposer",
    ["recentEpisodes", "milestones"],
    { maxItemsBySection: { recentEpisodes: 3 } },
  );
}

function buildProfileRelationshipSemanticOutputSchema() {
  return buildTextItemSemanticOutputSchema(
    "profileRelationshipProposer",
    ["userProfile", "assistantProfile", "relationship"],
  );
}

function semanticChangeSchema(action, { ref = action !== "add", text = !["forget", "clear", "complete", "cancel", "expire"].includes(action), properties = {}, required = [] } = {}) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", ...(ref ? ["ref"] : []), ...(text ? ["text"] : []), ...required],
    anyOf: [{ required: ["evidenceMessageIds"] }, { required: ["supportRefs"] }],
    properties: {
      action: { const: action },
      ...(ref ? { ref: { type: "string", minLength: 1 } } : {}),
      ...(text ? { text: { type: "string", minLength: 1 } } : {}),
      ...semanticSourceProperties,
      ...properties,
    },
  };
}

function semanticSectionResultSchema(changes) {
  return {
    oneOf: [
      { type: "object", additionalProperties: false, required: ["status", "changes"], properties: { status: { const: "changes" }, changes: { type: "array", minItems: 1, items: { oneOf: changes } } } },
      { type: "object", additionalProperties: false, required: ["status"], properties: { status: { const: "noop" } } },
      { type: "object", additionalProperties: false, required: ["status"], properties: { status: { const: "unable_to_decide" } } },
    ],
  };
}

function buildSingleSectionSemanticOutputSchema(proposer, section, changes) {
  return {
    name: `memory_${proposer}_semantic`,
    strict: true,
    schema: {
      type: "object", additionalProperties: false, required: ["tickId", "proposer", "sectionResults"],
      properties: {
        tickId: { type: "integer" }, proposer: { const: proposer },
        sectionResults: { type: "object", additionalProperties: false, required: [section], properties: { [section]: semanticSectionResultSchema(changes) } },
      },
    },
  };
}

function buildWorldFactSemanticOutputSchema() {
  return buildSingleSectionSemanticOutputSchema("worldFactProposer", "worldFacts", ["add", "update", "correct", "forget"].map(semanticTextItemChangeSchema));
}

function buildAgreementSemanticOutputSchema() {
  return buildSingleSectionSemanticOutputSchema("agreementProposer", "standingAgreements", [
    ...["add", "update", "correct", "forget"].map(semanticTextItemChangeSchema),
    semanticChangeSchema("cancel"),
  ]);
}

function buildTodoSemanticOutputSchema() {
  const actorRequester = { actor: { enum: ["user", "assistant", "both"] }, requester: { enum: ["user", "assistant"] } };
  const anchor = { anchorMessageId: { type: "integer", minimum: 1 } };
  return buildSingleSectionSemanticOutputSchema("todoProposer", "todos", [
    semanticChangeSchema("add", { ref: false, properties: { ...actorRequester, dueAt, ...anchor }, required: ["actor", "requester"] }),
    ...["update", "correct"].map((action) => semanticChangeSchema(action, { text: false, properties: { text: { type: "string", minLength: 1 }, ...actorRequester, dueChange, ...anchor }, required: ["dueChange"] })),
    ...["forget", "complete", "cancel", "expire"].map((action) => semanticChangeSchema(action)),
  ]);
}

function buildCurrentStateSemanticOutputSchema() {
  return buildSingleSectionSemanticOutputSchema("currentStateProposer", "scene", [
    ...["set", "correct"].map((action) => semanticChangeSchema(action)),
    ...["clear", "forget"].map((action) => semanticChangeSchema(action)),
  ]);
}

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
function compactionChangeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "refs", "text"],
    properties: {
      action: { const: "merge" },
      refs: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string", minLength: 1 } },
      text: { type: "string", minLength: 1 },
    },
  };
}

function buildOutputSchema(proposer, targetSections, { semantic = SEMANTIC_NORMAL_PROPOSERS.includes(proposer) } = {}) {
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
                { type: "object", additionalProperties: false, required: ["status", "changes"], properties: { status: { const: "changes" }, changes: { type: "array", minItems: 1, items: compactionChangeSchema() } } },
                { type: "object", additionalProperties: false, required: ["status"], properties: { status: { const: "unable_to_compact" } } },
              ] },
            },
          },
        },
      },
    };
  }
  if (semantic) {
    if (proposer === "episodeProposer") return buildEpisodeSemanticOutputSchema();
    if (proposer === "profileRelationshipProposer") return buildProfileRelationshipSemanticOutputSchema();
    if (proposer === "worldFactProposer") return buildWorldFactSemanticOutputSchema();
    if (proposer === "agreementProposer") return buildAgreementSemanticOutputSchema();
    if (proposer === "todoProposer") return buildTodoSemanticOutputSchema();
    if (proposer === "currentStateProposer") return buildCurrentStateSemanticOutputSchema();
    throw new Error(`Semantic output schema is not implemented for Memory proposer: ${proposer}`);
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

module.exports = {
  buildOutputSchema,
  buildEpisodeSemanticOutputSchema,
  buildProfileRelationshipSemanticOutputSchema,
  buildWorldFactSemanticOutputSchema,
  buildAgreementSemanticOutputSchema,
  buildTodoSemanticOutputSchema,
  buildCurrentStateSemanticOutputSchema,
  OPS,
};
