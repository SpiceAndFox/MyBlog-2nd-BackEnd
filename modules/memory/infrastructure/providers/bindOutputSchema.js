const { sectionLimits } = require("../../contracts/sectionPolicy");
const { TODO_SCHEMA_NAME, buildTodoOutputSchema } = require("./todoWireProtocol");
function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function removeRequiredAlternatives(variant, field) {
  if (!Array.isArray(variant.anyOf)) return;
  variant.anyOf = variant.anyOf.filter((entry) => !entry.required?.includes(field));
}

function bindSourceSelectors(variant, { messageIds, readOnlyRefs }) {
  if (variant.properties?.evidenceMessageIds) {
    if (messageIds.length) {
      variant.properties.evidenceMessageIds.items = { type: "integer", enum: messageIds };
    } else {
      delete variant.properties.evidenceMessageIds;
      removeRequiredAlternatives(variant, "evidenceMessageIds");
    }
  }
  if (variant.properties?.supportRefs) {
    if (readOnlyRefs.length) {
      variant.properties.supportRefs.items = { type: "string", enum: readOnlyRefs };
    } else {
      delete variant.properties.supportRefs;
      removeRequiredAlternatives(variant, "supportRefs");
    }
  }
  return !Array.isArray(variant.anyOf) || variant.anyOf.length > 0;
}

function renderedSelectors(artifact, section) {
  const writableRefs = Object.entries(artifact?.refMap?.writable || {})
    .filter(([, entry]) => entry.section === section)
    .map(([ref]) => ref)
    .sort();
  const readOnlyRefs = Object.keys(artifact?.refMap?.readOnly || {}).sort();
  const messageIds = Object.keys(artifact?.messageMeta || {})
    .map(Number)
    .filter(Number.isSafeInteger)
    .sort((left, right) => left - right);
  return { writableRefs, readOnlyRefs, messageIds };
}

function bindSectionResult(resultSchema, artifact, section) {
  const changesBranch = resultSchema?.oneOf?.find((branch) => branch.properties?.status?.const === "changes");
  const itemSchema = changesBranch?.properties?.changes?.items;
  if (!changesBranch || !itemSchema) return;
  const { writableRefs, readOnlyRefs, messageIds } = renderedSelectors(artifact, section);
  if (itemSchema.properties?.refs) {
    if (writableRefs.length >= 2 && readOnlyRefs.length) {
      itemSchema.properties.refs.items = { type: "string", enum: writableRefs };
      itemSchema.properties.supportRefs.items = { type: "string", enum: readOnlyRefs };
      itemSchema.properties.text.maxLength = sectionLimits(section, artifact?.publicInput?.task).maxItemChars;
      itemSchema.properties.supportRefs.maxItems = sectionLimits(section, artifact?.publicInput?.task).maxSourceRefs;
    } else {
      resultSchema.oneOf = resultSchema.oneOf.filter((branch) => branch !== changesBranch);
    }
    return;
  }
  const variants = itemSchema.oneOf;
  if (!Array.isArray(variants)) return;
  const boundVariants = variants.filter((variant) => {
    if (!isPlainObject(variant?.properties)) return false;
    const limits = sectionLimits(section, artifact?.publicInput?.task);
    if (variant.properties.text) {
      variant.properties.text.maxLength = variant.properties.action?.const === "append" ? limits.maxAppendChars : limits.maxItemChars;
    }
    for (const key of ["supportRefs", "evidenceMessageIds"]) {
      if (variant.properties[key]) variant.properties[key].maxItems = limits.maxSourceRefs;
    }
    if (variant.properties.ref) {
      if (!writableRefs.length) return false;
      variant.properties.ref = { type: "string", enum: writableRefs };
    }
    return bindSourceSelectors(variant, { messageIds, readOnlyRefs });
  });
  if (boundVariants.length) {
    changesBranch.properties.changes.items.oneOf = boundVariants;
  } else {
    resultSchema.oneOf = resultSchema.oneOf.filter((branch) => branch !== changesBranch);
  }
}

function bindOutputSchema(schema, artifact, sections) {
  if (schema.name === TODO_SCHEMA_NAME) return buildTodoOutputSchema(artifact);
  if (isFlatWireSchema(schema)) return bindFlatWireOutputSchema(schema, artifact, sections);
  const bound = structuredClone(schema);
  if (bound.name === "memory_librarian_semantic") {
    const refs = Object.keys(artifact?.refMap?.writable || {}).sort();
    const evidenceRefs = Object.keys(artifact?.refMap?.readOnly || {}).sort();
    const rootBranches = bound.schema?.oneOf || [];
    const changesBranch = rootBranches.find((branch) => branch.properties?.status?.const === "changes");
    const operationArray = changesBranch?.properties?.operations;
    if (!refs.length) {
      bound.schema.oneOf = rootBranches.filter((branch) => branch.properties?.status?.const === "noop");
      bound.schema.oneOf[0].properties.reports.maxItems = 0;
      return bound;
    }
    let operations = operationArray?.items?.oneOf || [];
    if (refs.length < 2) {
      operations = operations.filter((variant) => !["merge", "remove"].includes(variant.properties?.action?.const));
      operationArray.items.oneOf = operations;
    }
    if (!evidenceRefs.length) operations = operations.filter(variant => ["move", "remove"].includes(variant.properties?.action?.const));
    operationArray.items.oneOf = operations;
    for (const branch of rootBranches) {
      if (refs.length) branch.properties.reports.items.properties.ref = { type: "string", enum: refs };
      else branch.properties.reports.maxItems = 0;
    }
    for (const variant of operations) {
      const section = variant.properties.toSection?.const;
      if (variant.properties.text && section) variant.properties.text.maxLength = sectionLimits(section, artifact?.publicInput?.task).maxItemChars;
      if (variant.properties.supportRefs) variant.properties.supportRefs.items = { type: "string", enum: evidenceRefs };
      for (const part of variant.properties.parts?.items?.oneOf || []) {
        part.properties.supportRefs.items = { type: "string", enum: evidenceRefs };
        const limits = sectionLimits(part.properties.toSection.const, artifact?.publicInput?.task);
        part.properties.text.maxLength = limits.maxItemChars;
        part.properties.supportRefs.maxItems = limits.maxSourceRefs;
      }
      for (const field of ["ref", "keeperRef"]) {
        if (variant.properties?.[field]) variant.properties[field] = { type: "string", enum: refs };
      }
      for (const field of ["refs", "duplicateRefs"]) {
        if (variant.properties?.[field]?.items) variant.properties[field].items = { type: "string", enum: refs };
      }
    }
    return bound;
  }
  const sectionResults = bound.schema?.properties?.sectionResults;
  const selected = Array.isArray(sections) && sections.length
    ? sections
    : sectionResults?.required || [];
  for (const section of selected) {
    bindSectionResult(sectionResults?.properties?.[section], artifact, section);
  }
  return bound;
}

function bindSpecialistSchema(schema, artifact, section) {
  return bindOutputSchema(schema, artifact, [section]);
}

module.exports = {
  bindOutputSchema,
  bindSectionResult,
  bindSpecialistSchema,
};
const {
  bindFlatWireOutputSchema,
  isFlatWireSchema,
} = require("./flatWireProtocol");
