function constraintDescriptions(schema) {
  const descriptions = [];
  if (Number.isSafeInteger(schema.minLength)) descriptions.push(`String length must be at least ${schema.minLength} Unicode characters.`);
  if (Number.isSafeInteger(schema.maxLength)) descriptions.push(`String length must be at most ${schema.maxLength} Unicode characters.`);
  if (Number.isSafeInteger(schema.minItems)) descriptions.push(`Array must contain at least ${schema.minItems} items.`);
  if (Number.isSafeInteger(schema.maxItems)) descriptions.push(`Array must contain at most ${schema.maxItems} items.`);
  if (schema.uniqueItems === true) descriptions.push("Array items must be unique.");
  return descriptions;
}

module.exports = { constraintDescriptions };
