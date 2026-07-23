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
    if (writableRefs.length >= 2) {
      itemSchema.properties.refs.items = { type: "string", enum: writableRefs };
    } else {
      resultSchema.oneOf = resultSchema.oneOf.filter((branch) => branch !== changesBranch);
    }
    return;
  }
  const variants = itemSchema.oneOf;
  if (!Array.isArray(variants)) return;
  const boundVariants = variants.filter((variant) => {
    if (!isPlainObject(variant?.properties)) return false;
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
  const bound = structuredClone(schema);
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
