const { buildTodoOutputSchema } = require("./todoWireProtocol");
const {
  LIBRARIAN_PROPOSER,
  LIBRARIAN_SECTIONS,
} = require("../../../contracts/constants");
const {
  buildFlatWireOutputSchema,
  isFlatWireProposer,
} = require("./flatWireProtocol");

const semanticSourceProperties = Object.freeze({
  evidenceMessageIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", minimum: 1 } },
  supportRefs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
});

function semanticTextItemChangeSchema(action, { maxTextLength } = {}) {
  const properties = { action: { const: action }, ...semanticSourceProperties };
  const required = ["action"];
  if (action !== "add") {
    properties.ref = { type: "string", minLength: 1 };
    required.push("ref");
  }
  if (action !== "forget") {
    properties.text = { type: "string", minLength: 1, ...(maxTextLength ? { maxLength: maxTextLength } : {}) };
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

function semanticTextItemResultSchema({ maxItems, maxTextLength, actions = ["add", "revise", "correct", "forget"] } = {}) {
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
            items: { oneOf: actions.map((action) => semanticTextItemChangeSchema(action, { maxTextLength })) },
          },
        },
      },
      { type: "object", additionalProperties: false, required: ["status"], properties: { status: { const: "noop" } } },
      { type: "object", additionalProperties: false, required: ["status"], properties: { status: { const: "unable_to_decide" } } },
    ],
  };
}

function buildTextItemSemanticOutputSchema(proposer, sections, { maxItemsBySection = {}, maxTextLengthBySection = {} } = {}) {
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
            actions: require("../../../contracts/sectionPolicy").SECTION_ACTIONS[section],
            maxItems: maxItemsBySection[section],
            maxTextLength: maxTextLengthBySection[section],
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

const PROFILE_SPECIALIST_SECTIONS = Object.freeze({
  userProfileProposer: "userProfile",
  assistantProfileProposer: "assistantProfile",
  relationshipProposer: "relationship",
});

function semanticChangeSchema(action, {
  ref = action !== "add",
  text = !["forget", "clear", "complete", "cancel", "expire"].includes(action),
  properties = {},
  required = [],
} = {}) {
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
      type: "object",
      additionalProperties: false,
      required: ["tickId", "proposer", "sectionResults"],
      properties: {
        tickId: { type: "integer" },
        proposer: { const: proposer },
        sectionResults: {
          type: "object",
          additionalProperties: false,
          required: [section],
          properties: { [section]: semanticSectionResultSchema(changes) },
        },
      },
    },
  };
}

function buildWorldFactSemanticOutputSchema() {
  return buildSingleSectionSemanticOutputSchema("worldFactProposer", "worldFacts", ["add", "revise", "correct", "forget"].map(semanticTextItemChangeSchema));
}

function buildAgreementSemanticOutputSchema() {
  return buildSingleSectionSemanticOutputSchema("agreementProposer", "standingAgreements", [
    ...["add", "revise", "correct", "forget"].map(semanticTextItemChangeSchema),
    semanticChangeSchema("cancel"),
  ]);
}

function buildCurrentStateSemanticOutputSchema() {
  return buildSingleSectionSemanticOutputSchema("currentStateProposer", "scene", [
    ...["set", "correct"].map((action) => semanticChangeSchema(action)),
    ...["clear", "forget"].map((action) => semanticChangeSchema(action)),
  ]);
}

function compactionChangeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "refs", "text", "supportRefs"],
    properties: {
      action: { const: "merge" },
      refs: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string", minLength: 1 } },
      supportRefs: semanticSourceProperties.supportRefs,
      text: { type: "string", minLength: 1 },
    },
  };
}

function librarianTextSchema() {
  return {
    type: "string",
    minLength: 1,
  };
}

function librarianSectionTextVariants() {
  return LIBRARIAN_SECTIONS.map((section) => ({
    type: "object",
    additionalProperties: false,
    required: ["toSection", "text", "supportRefs"],
    properties: {
      toSection: { const: section },
      text: librarianTextSchema(section),
      supportRefs: semanticSourceProperties.supportRefs,
    },
  }));
}

function buildLibrarianOutputSchema() {
  const section = {
    enum: LIBRARIAN_SECTIONS.slice(),
  };
  const ref = { type: "string", minLength: 1 };
  const mergeOperations = LIBRARIAN_SECTIONS.map((toSection) => ({
    type: "object",
    additionalProperties: false,
    required: ["action", "refs", "toSection", "text", "supportRefs"],
    properties: {
      action: { const: "merge" },
      refs: { type: "array", minItems: 2, uniqueItems: true, items: ref },
      toSection: { const: toSection },
      text: librarianTextSchema(toSection),
      supportRefs: semanticSourceProperties.supportRefs,
    },
  }));
  const operation = {
    oneOf: [
      {
        type: "object", additionalProperties: false,
        required: ["action", "ref", "toSection"],
        properties: { action: { const: "move" }, ref, toSection: section },
      },
      ...mergeOperations,
      ...["revise", "correct"].map(action => ({ type: "object", additionalProperties: false, required: ["action", "ref", "text", "supportRefs"], properties: { action: { const: action }, ref, text: { type: "string", minLength: 1 }, supportRefs: semanticSourceProperties.supportRefs } })),
      {
        type: "object", additionalProperties: false,
        required: ["action", "ref", "keeperRef", "reason"],
        properties: {
          action: { const: "remove" },
          ref,
          reason: { const: "duplicate" },
          keeperRef: ref,
        },
      },
      {
        type: "object", additionalProperties: false,
        required: ["action", "ref", "parts"],
        properties: {
          action: { const: "split" },
          ref,
          parts: {
            type: "array", minItems: 2, maxItems: 4,
            items: { oneOf: librarianSectionTextVariants() },
          },
        },
      },
    ],
  };
  const root = (status, operations) => ({
    type: "object",
    additionalProperties: false,
    required: ["tickId", "proposer", "status", "operations"],
    properties: {
      tickId: { type: "integer" },
      proposer: { const: LIBRARIAN_PROPOSER },
      status: { const: status },
      operations,
      reports: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["ref", "reason"], properties: { ref, reason: { enum: ["unsupported_section", "insufficient_evidence", "cannot_repair"] } } } },
    },
  });
  return {
    name: "memory_librarian_semantic",
    strict: true,
    schema: {
      oneOf: [
        root("changes", { type: "array", minItems: 1, maxItems: 6, items: operation }),
        root("noop", {
          type: "array",
          maxItems: 0,
          // The array must stay empty; DeepSeek rejects an empty object schema.
          items: { type: "string" },
        }),
      ],
    },
  };
}

function buildOutputSchema(proposer, targetSections) {
  if (proposer === "todoProposer") return buildTodoOutputSchema();
  if (proposer === LIBRARIAN_PROPOSER) return buildLibrarianOutputSchema();
  if (proposer === "compactionProposer") {
    if (!Array.isArray(targetSections) || targetSections.length !== 1) throw new Error("Compaction schema requires exactly one target section");
    const [section] = targetSections;
    return {
      name: `memory_compaction_${section}`,
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["tickId", "proposer", "sectionResults"],
        properties: {
          tickId: { type: "integer" },
          proposer: { const: "compactionProposer" },
          sectionResults: {
            type: "object",
            additionalProperties: false,
            required: [section],
            properties: {
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
  if (isFlatWireProposer(proposer)) return buildFlatWireOutputSchema(proposer, targetSections);
  if (proposer === "episodeProposer") return buildEpisodeSemanticOutputSchema();
  if (proposer === "profileRelationshipProposer") return buildProfileRelationshipSemanticOutputSchema();
  if (PROFILE_SPECIALIST_SECTIONS[proposer]) {
    return buildTextItemSemanticOutputSchema(proposer, [PROFILE_SPECIALIST_SECTIONS[proposer]]);
  }
  if (proposer === "worldFactProposer") return buildWorldFactSemanticOutputSchema();
  if (proposer === "agreementProposer") return buildAgreementSemanticOutputSchema();
  if (proposer === "currentStateProposer") return buildCurrentStateSemanticOutputSchema();
  throw new Error(`Semantic output schema is not implemented for Memory proposer: ${proposer}`);
}

module.exports = {
  buildOutputSchema,
  buildEpisodeSemanticOutputSchema,
  buildProfileRelationshipSemanticOutputSchema,
  PROFILE_SPECIALIST_SECTIONS,
  buildWorldFactSemanticOutputSchema,
  buildAgreementSemanticOutputSchema,
  buildCurrentStateSemanticOutputSchema,
  buildLibrarianOutputSchema,
};
