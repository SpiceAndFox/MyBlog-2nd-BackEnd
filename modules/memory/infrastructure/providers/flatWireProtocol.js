const {
  FLAT_WIRE_PROPOSER_SECTIONS,
  FLAT_WIRE_STATUSES,
  flatWireSections,
  isFlatWireProposer,
} = require("../../contracts/flatWire");

const FLAT_WIRE_SOURCE_PREFIXES = Object.freeze({
  message: "message:",
  memory: "memory:",
});
const { SECTION_ACTIONS, sectionLimits } = require("../../contracts/sectionPolicy");
const BASE_CHANGE_FIELDS = Object.freeze(["section", "action", "target", "text", "sources"]);
const TODO_CHANGE_FIELDS = Object.freeze([
  ...BASE_CHANGE_FIELDS,
  "actor",
  "requester",
  "dueMode",
  "dueValue",
  "anchorSource",
]);
const DUE_MODES = Object.freeze([
  "keep",
  "clear",
  "absolute",
  "relativeDays",
  "relativeMonths",
  "relativeYears",
  "dayOfMonth",
]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function selectedSections(proposer, targetSections) {
  return flatWireSections(proposer, targetSections);
}

function selectedActions(sections) {
  return [...new Set(sections.flatMap((section) => SECTION_ACTIONS[section] || []))];
}

function buildFlatWireOutputSchema(proposer, targetSections) {
  const sections = selectedSections(proposer, targetSections);
  const changeProperties = {
    section: {
      type: "string",
      enum: sections,
      description: "Section receiving this change.",
    },
    action: {
      type: "string",
      enum: selectedActions(sections),
      description: "Semantic action allowed by the proposer.",
    },
    target: {
      type: "string",
      minLength: 1,
      description: "Writable short ref. Omit only for add.",
    },
    text: {
      type: "string",
      minLength: 1,
      description: "Full result text, except append: only the new fragment. Omit for terminal actions.",
    },
    sources: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
      description: "One or more visible message:ID or memory:REF source tokens.",
    },
  };
  if (proposer === "todoProposer") {
    Object.assign(changeProperties, {
      actor: { type: "string", enum: ["user", "assistant", "both"] },
      requester: { type: "string", enum: ["user", "assistant"] },
      dueMode: { type: "string", enum: DUE_MODES.slice() },
      dueValue: { type: "string", minLength: 1 },
      anchorSource: {
        type: "string",
        minLength: 1,
        description: "A message:ID token also present in sources.",
      },
    });
  }
  return {
    name: `memory_flat_${proposer}_v1`,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["sectionStatuses", "changes"],
      properties: {
        sectionStatuses: {
          type: "object",
          additionalProperties: false,
          required: sections,
          properties: Object.fromEntries(sections.map((section) => [
            section,
            { type: "string", enum: FLAT_WIRE_STATUSES.slice() },
          ])),
        },
        changes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["section", "action", "sources"],
            properties: changeProperties,
          },
        },
      },
    },
  };
}

function isFlatWireSchema(schema) {
  return typeof schema?.name === "string" && schema.name.startsWith("memory_flat_");
}

function messageSource(messageId) {
  return `${FLAT_WIRE_SOURCE_PREFIXES.message}${messageId}`;
}

function memorySource(ref) {
  return `${FLAT_WIRE_SOURCE_PREFIXES.memory}${ref}`;
}

function bindFlatWireOutputSchema(schema, artifact, sections) {
  const bound = structuredClone(schema);
  const selected = Array.isArray(sections) && sections.length
    ? sections
    : Object.keys(bound.schema?.properties?.sectionStatuses?.properties || {});
  const writableRefs = Object.entries(artifact?.refMap?.writable || {})
    .filter(([, entry]) => selected.includes(entry.section))
    .map(([ref]) => ref)
    .sort();
  const messageIds = Object.keys(artifact?.messageMeta || {})
    .map(Number)
    .filter(Number.isSafeInteger)
    .sort((left, right) => left - right);
  const readOnlyRefs = Object.keys(artifact?.refMap?.readOnly || {}).sort();
  const properties = bound.schema?.properties?.changes?.items?.properties;
  if (!properties) return bound;
  properties.text.maxLength = Math.max(...selected.map((section) => sectionLimits(section, artifact?.publicInput?.task).maxItemChars));
  properties.sources.maxItems = Math.max(...selected.map((section) => sectionLimits(section, artifact?.publicInput?.task).maxSourceRefs));
  if (writableRefs.length) properties.target = { ...properties.target, enum: writableRefs };
  else {
    delete properties.target;
    const addAllowed = selected.some((section) => SECTION_ACTIONS[section]?.includes("add"));
    if (addAllowed) properties.action = { ...properties.action, enum: ["add"] };
    else bound.schema.properties.changes.maxItems = 0;
  }
  const sources = [
    ...messageIds.map(messageSource),
    ...readOnlyRefs.map(memorySource),
  ];
  if (sources.length) properties.sources.items = { type: "string", enum: sources };
  else bound.schema.properties.changes.maxItems = 0;
  if (properties.anchorSource) {
    if (messageIds.length) properties.anchorSource = { type: "string", enum: messageIds.map(messageSource) };
    else delete properties.anchorSource;
  }
  return bound;
}

function parseSourceTokens(values) {
  const evidenceMessageIds = [];
  const supportRefs = [];
  for (const value of Array.isArray(values) ? values : []) {
    const token = String(value);
    if (token.startsWith(FLAT_WIRE_SOURCE_PREFIXES.message)) {
      const raw = token.slice(FLAT_WIRE_SOURCE_PREFIXES.message.length);
      evidenceMessageIds.push(/^[1-9]\d*$/.test(raw) ? Number(raw) : token);
    } else if (token.startsWith(FLAT_WIRE_SOURCE_PREFIXES.memory)) {
      supportRefs.push(token.slice(FLAT_WIRE_SOURCE_PREFIXES.memory.length));
    } else {
      supportRefs.push(token);
    }
  }
  return {
    ...(evidenceMessageIds.length ? { evidenceMessageIds } : {}),
    ...(supportRefs.length ? { supportRefs } : {}),
  };
}

function dueExpression(mode, value) {
  if (mode === "absolute") return { mode: "absolute", date: value };
  if (mode === "dayOfMonth") return { mode: "dayOfMonth", day: strictInteger(value) };
  const unit = {
    relativeDays: "days",
    relativeMonths: "months",
    relativeYears: "years",
  }[mode];
  return unit ? { mode: "relative", [unit]: strictInteger(value) } : null;
}

function strictInteger(value) {
  return /^-?\d+$/.test(String(value ?? "")) ? Number(value) : Number.NaN;
}

function parseAnchorSource(value) {
  if (value === undefined) return undefined;
  const token = String(value);
  if (!token.startsWith(FLAT_WIRE_SOURCE_PREFIXES.message)) return token;
  const raw = token.slice(FLAT_WIRE_SOURCE_PREFIXES.message.length);
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : token;
}

function wireChangeToSemantic(change, proposer) {
  if (!isPlainObject(change)) return change;
  const allowed = new Set(proposer === "todoProposer" ? TODO_CHANGE_FIELDS : BASE_CHANGE_FIELDS);
  const output = {
    action: change.action,
    ...parseSourceTokens(change.sources),
  };
  if (change.target !== undefined) output.ref = change.target;
  if (change.text !== undefined) output.text = change.text;
  if (change.actor !== undefined) output.actor = change.actor;
  if (change.requester !== undefined) output.requester = change.requester;
  if (change.anchorSource !== undefined) output.anchorMessageId = parseAnchorSource(change.anchorSource);
  if (change.dueMode !== undefined) {
    if (["keep", "clear"].includes(change.dueMode)) {
      output.dueChange = { mode: change.dueMode };
    } else {
      const expression = dueExpression(change.dueMode, change.dueValue);
      if (change.action === "add") output.dueAt = expression;
      else output.dueChange = { mode: "set", dueAt: expression };
    }
  } else if (change.dueValue !== undefined) {
    output.__wireDueValueWithoutMode = change.dueValue;
  }
  const unexpected = Object.keys(change).filter((key) => !allowed.has(key));
  if (unexpected.length) output.__wireUnexpectedFields = unexpected;
  return output;
}

function flatWireToSemanticOutput(value, task) {
  if (!isFlatWireProposer(task?.proposer)) return value;
  if (isPlainObject(value?.sectionResults)) return value;
  if (!isPlainObject(value)
    || !isPlainObject(value.sectionStatuses)
    || !Array.isArray(value.changes)
    || Object.keys(value).some((key) => !["sectionStatuses", "changes"].includes(key))) {
    return value;
  }
  const expectedSections = Array.isArray(task.targetSections) && task.targetSections.length
    ? task.targetSections.map(String)
    : selectedSections(task.proposer);
  const actualSections = new Set([
    ...Object.keys(value.sectionStatuses),
    ...value.changes
      .filter(isPlainObject)
      .map((change) => String(change.section ?? "__missing_section__")),
  ]);
  const sectionResults = {};
  for (const section of new Set([...expectedSections, ...actualSections])) {
    const changes = value.changes
      .filter((change) => isPlainObject(change) && String(change.section ?? "__missing_section__") === section)
      .map((change) => wireChangeToSemantic(change, task.proposer));
    const status = value.sectionStatuses[section];
    sectionResults[section] = {
      status,
      ...((status === "changes" || changes.length) ? { changes } : {}),
    };
  }
  const output = {
    tickId: task.tickId,
    proposer: task.proposer,
    sectionResults,
  };
  const expectedStatusKeys = new Set(expectedSections);
  if (Object.keys(value.sectionStatuses).some((section) => !expectedStatusKeys.has(section))) {
    output.__wireUnexpectedStatusSections = Object.keys(value.sectionStatuses)
      .filter((section) => !expectedStatusKeys.has(section));
  }
  return output;
}

function flatWireChangeIndex(output, section, localIndex) {
  if (!Array.isArray(output?.changes)) return localIndex;
  const indexes = [];
  output.changes.forEach((change, index) => {
    if (isPlainObject(change) && String(change.section) === section) indexes.push(index);
  });
  return indexes[localIndex] ?? localIndex;
}

function flatWireIssuePath(path, output) {
  const value = String(path || "$");
  const match = value.match(/^\$\.sectionResults\.([A-Za-z0-9_]+)(?:\.changes\[(\d+)\])?(.*)$/);
  if (!match) {
    if (/^\$\.(tickId|proposer|sectionResults)(?:\.|\[|$)/.test(value)) return "$";
    return value;
  }
  const [, section, localIndex, rawSuffix] = match;
  if (localIndex === undefined) {
    if (rawSuffix.startsWith(".changes")) return "$.changes";
    return `$.sectionStatuses.${section}`;
  }
  const index = flatWireChangeIndex(output, section, Number(localIndex));
  const suffix = rawSuffix
    .replace(/^\.ref(?=\.|\[|$)/, ".target")
    .replace(/^\.(evidenceMessageIds|supportRefs)(?=\.|\[|$)/, ".sources")
    .replace(/^\.anchorMessageId(?=\.|\[|$)/, ".anchorSource")
    .replace(/^\.(dueAt|dueChange)(?=\.|\[|$).*/, ".dueMode");
  return `$.changes[${index}]${suffix}`;
}

function flatWireRepairErrors(errors, output, task) {
  if (!isFlatWireProposer(task?.proposer)) return Array.isArray(errors) ? errors : [];
  return (Array.isArray(errors) ? errors : []).map((issue) => ({
    ...issue,
    path: flatWireIssuePath(issue?.path, output),
  }));
}

function dueExpressionToWire(expression) {
  if (!expression) return {};
  if (expression.mode === "absolute") return { dueMode: "absolute", dueValue: expression.date };
  if (expression.mode === "dayOfMonth") return { dueMode: "dayOfMonth", dueValue: String(expression.day) };
  const unit = ["days", "months", "years"].find((key) => expression[key] !== undefined);
  return unit ? {
    dueMode: `relative${unit[0].toUpperCase()}${unit.slice(1)}`,
    dueValue: String(expression[unit]),
  } : {};
}

function semanticChangeToWire(change, section) {
  const output = {
    section,
    action: change.action,
    sources: [
      ...(change.evidenceMessageIds || []).map(messageSource),
      ...(change.supportRefs || []).map(memorySource),
    ],
  };
  if (change.ref !== undefined) output.target = change.ref;
  if (change.text !== undefined) output.text = change.text;
  if (change.actor !== undefined) output.actor = change.actor;
  if (change.requester !== undefined) output.requester = change.requester;
  if (change.dueAt !== undefined) Object.assign(output, dueExpressionToWire(change.dueAt));
  if (change.dueChange !== undefined) {
    if (["keep", "clear"].includes(change.dueChange.mode)) output.dueMode = change.dueChange.mode;
    else Object.assign(output, dueExpressionToWire(change.dueChange.dueAt));
  }
  if (change.anchorMessageId !== undefined) output.anchorSource = messageSource(change.anchorMessageId);
  return output;
}

function semanticOutputToFlatWire(value, task) {
  if (!isFlatWireProposer(task?.proposer) || !isPlainObject(value?.sectionResults)) return value;
  const sections = Array.isArray(task.targetSections) && task.targetSections.length
    ? task.targetSections
    : selectedSections(task.proposer);
  return {
    sectionStatuses: Object.fromEntries(sections.map((section) => [
      section,
      value.sectionResults?.[section]?.status,
    ])),
    changes: sections.flatMap((section) => (
      value.sectionResults?.[section]?.changes || []
    ).map((change) => semanticChangeToWire(change, section))),
  };
}

module.exports = {
  FLAT_WIRE_SOURCE_PREFIXES,
  FLAT_WIRE_STATUSES,
  PROPOSER_SECTIONS: FLAT_WIRE_PROPOSER_SECTIONS,
  SECTION_ACTIONS,
  bindFlatWireOutputSchema,
  buildFlatWireOutputSchema,
  flatWireIssuePath,
  flatWireRepairErrors,
  flatWireToSemanticOutput,
  isFlatWireProposer,
  isFlatWireSchema,
  messageSource,
  memorySource,
  semanticOutputToFlatWire,
};
