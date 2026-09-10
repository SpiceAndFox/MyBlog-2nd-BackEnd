const { sectionLimits } = require("../../contracts/sectionPolicy");
const { semanticOutputToFlatWire, flatWireToSemanticOutput } = require("./flatWireProtocol");

const TODO_V2_SCHEMA_NAME = "memory_todo_v2";
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const enumeration = (...values) => ({ type: "string", enum: values });
const mode = (value, properties = {}) => object({ mode: enumeration(value), ...properties });
const union = (...anyOf) => ({ anyOf });
const edit = (value) => union(mode("keep"), mode("set", { value }));

function buildTodoV2OutputSchema(artifact = null) {
  const limits = artifact ? sectionLimits("todos", artifact.publicInput.task) : null;
  const targets = artifact ? Object.entries(artifact.refMap?.writable || {})
    .filter(([, entry]) => entry.section === "todos").map(([ref]) => ref).sort() : null;
  const messages = artifact ? Object.keys(artifact.messageMeta || {}).map(Number).filter(Number.isSafeInteger)
    .sort((a, b) => a - b).map(id => `message:${id}`) : null;
  const sources = artifact ? [...messages, ...Object.keys(artifact.refMap?.readOnly || {}).sort().map(ref => `memory:${ref}`)] : null;
  const selector = (values) => values ? enumeration(...values) : { type: "string", minLength: 1 };
  const text = { type: "string", minLength: 1, ...(limits ? { maxLength: limits.maxItemChars } : {}), description: "One complete atomic Todo text." };
  const common = { sources: { type: "array", minItems: 1, uniqueItems: true, ...(limits ? { maxItems: limits.maxSourceRefs } : {}), items: selector(sources), description: "Visible message:ID or memory:REF tokens supporting the change." } };
  function due(adding) {
    const variants = adding ? [mode("none")] : [mode("keep"), mode("clear")];
    variants.push(mode("absolute", { date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" } }));
    if (!messages || messages.length) {
      const anchorSource = { ...selector(messages), description: "Date-source message token also included in this change's sources." };
      for (const name of ["relativeDays", "relativeMonths", "relativeYears"]) {
        variants.push(mode(name, { offset: { type: "integer", minimum: name === "relativeDays" ? 0 : 1, maximum: Number.MAX_SAFE_INTEGER }, anchorSource }));
      }
      variants.push(mode("dayOfMonth", { day: { type: "integer", minimum: 1, maximum: 31 }, anchorSource }));
    }
    return union(...variants);
  }
  const actor = enumeration("user", "assistant", "both");
  const requester = enumeration("user", "assistant");
  const results = [object({ status: enumeration("noop") }), object({ status: enumeration("unable_to_decide") })];
  if (!sources || sources.length) {
    const changes = [object({ action: enumeration("add"), ...common, text, actor, requester, due: due(true) })];
    if (!targets || targets.length) {
      changes.push(object({ action: enumeration("revise", "correct"), ...common, target: selector(targets), text: edit(text), actor: edit(actor), requester: edit(requester), due: due(false) }));
      changes.push(object({ action: enumeration("forget", "complete", "cancel", "expire"), ...common, target: selector(targets) }));
    }
    results.push(object({ status: enumeration("changes"), changes: { type: "array", minItems: 1, items: union(...changes) } }));
  }
  return { name: TODO_V2_SCHEMA_NAME, strict: true, schema: object({ results: object({ todos: union(...results) }) }) };
}

// Call only after complete wire validation. These conversions never read old
// target values; keep preserves omission in the existing Semantic IR.
function todoV2ToSemantic(value, task) {
  const result = value.results.todos;
  const flat = { sectionStatuses: { todos: result.status }, changes: (result.changes || []).map(change => {
    const out = { section: "todos", action: change.action, sources: change.sources };
    if (change.target !== undefined) out.target = change.target;
    if (!["add", "revise", "correct"].includes(change.action)) return out;
    for (const field of ["text", "actor", "requester"]) {
      if (change.action === "add") out[field] = change[field];
      else if (change[field].mode === "set") out[field] = change[field].value;
    }
    const due = change.due;
    if (due.mode !== "none") out.dueMode = due.mode;
    if (due.mode === "absolute") out.dueValue = due.date;
    else if (due.mode === "dayOfMonth") out.dueValue = String(due.day);
    else if (due.mode.startsWith("relative")) out.dueValue = String(due.offset);
    if (due.anchorSource !== undefined) out.anchorSource = due.anchorSource;
    return out;
  }) };
  return flatWireToSemanticOutput(flat, task);
}

function semanticToTodoV2(value, task) {
  const flat = semanticOutputToFlatWire(value, task);
  const status = flat.sectionStatuses.todos;
  if (status !== "changes") return { results: { todos: { status } } };
  return { results: { todos: { status, changes: flat.changes.map(change => {
    const out = { action: change.action, sources: change.sources };
    if (change.target !== undefined) out.target = change.target;
    if (!["add", "revise", "correct"].includes(change.action)) return out;
    for (const field of ["text", "actor", "requester"]) {
      out[field] = change.action === "add" ? change[field] : change[field] === undefined ? { mode: "keep" } : { mode: "set", value: change[field] };
    }
    out.due = { mode: change.dueMode || "none" };
    if (change.dueMode === "absolute") out.due.date = change.dueValue;
    else if (change.dueMode === "dayOfMonth") out.due.day = Number(change.dueValue);
    else if (change.dueMode?.startsWith("relative")) out.due.offset = Number(change.dueValue);
    if (change.anchorSource !== undefined) out.due.anchorSource = change.anchorSource;
    return out;
  }) } } };
}

function todoV2RepairErrors(errors, wire) {
  return (errors || []).map(issue => {
    const path = String(issue.path || "$");
    const match = path.match(/^\$\.sectionResults\.todos(?:\.changes\[(\d+)\])?(.*)$/);
    if (!match) return { ...issue, path: /^\$\.(tickId|proposer|sectionResults)(?:\.|$)/.test(path) ? "$" : path };
    const [, index, suffix] = match;
    if (index === undefined) return { ...issue, path: `$.results.todos${suffix}` };
    const action = wire?.results?.todos?.changes?.[Number(index)]?.action;
    const field = suffix.replace(/^\.ref(?=\.|$)/, ".target")
      .replace(/^\.(evidenceMessageIds|supportRefs)(?:\[\d+\])?/, ".sources")
      .replace(/^\.anchorMessageId/, ".due.anchorSource")
      .replace(/^\.(dueAt|dueChange).*$/, ".due")
      .replace(/^\.(text|actor|requester)(?=\.|$)/, (_, name) => `.${name}${action === "add" ? "" : ".value"}`);
    return { ...issue, path: `$.results.todos.changes[${index}]${field}` };
  });
}

module.exports = { TODO_V2_SCHEMA_NAME, buildTodoV2OutputSchema, todoV2ToSemantic, semanticToTodoV2, todoV2RepairErrors };
