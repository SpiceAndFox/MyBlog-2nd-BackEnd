// Specialize the flat Todo wire shape before strict compilation. Enumerating
// every optional field independently produces 128 mostly invalid combinations.
// Group actions and dates by their field requirements; only edit fields retain
// independent presence/absence semantics. Keep bound selectors and limits.
function buildDeepSeekTodoSchema(schema) {
  const specialized = structuredClone(schema);
  const changes = specialized.properties.changes;
  const properties = changes.items.properties;
  const variants = [];

  function addVariant(actions, requiredFields, optionalFields = [], dueModes = null) {
    const allowedActions = properties.action.enum.filter((action) => actions.includes(action));
    if (!allowedActions.length) return;
    const required = ["section", "action", "sources", ...requiredFields];
    if (required.some((field) => !properties[field])) return;
    const selected = new Set([...required, ...optionalFields]);
    const variantProperties = Object.fromEntries(Object.entries(properties)
      .filter(([field]) => selected.has(field)));
    variantProperties.action = { ...properties.action, enum: allowedActions };
    if (dueModes) {
      const allowedModes = properties.dueMode.enum.filter((mode) => dueModes.includes(mode));
      if (!allowedModes.length) return;
      variantProperties.dueMode = { ...properties.dueMode, enum: allowedModes };
    }
    variants.push({ type: "object", additionalProperties: false, properties: variantProperties, required });
  }

  const anchoredModes = ["relativeDays", "relativeMonths", "relativeYears", "dayOfMonth"];
  const addFields = ["text", "actor", "requester"];
  addVariant(["add"], addFields);
  addVariant(["add"], [...addFields, "dueMode", "dueValue"], [], ["absolute"]);
  addVariant(["add"], [...addFields, "dueMode", "dueValue", "anchorSource"], [], anchoredModes);

  const editActions = ["revise", "correct"];
  const editFields = ["text", "actor", "requester"];
  addVariant(editActions, ["target", "dueMode"], editFields, ["keep", "clear"]);
  addVariant(editActions, ["target", "dueMode", "dueValue"], editFields, ["absolute"]);
  addVariant(editActions, ["target", "dueMode", "dueValue", "anchorSource"], editFields, anchoredModes);

  addVariant(["forget", "complete", "cancel", "expire"], ["target"]);
  if (!variants.length) throw new Error("DeepSeek Todo schema has no supported action/date variant");
  changes.items = { anyOf: variants };
  return specialized;
}

module.exports = { buildDeepSeekTodoSchema };
