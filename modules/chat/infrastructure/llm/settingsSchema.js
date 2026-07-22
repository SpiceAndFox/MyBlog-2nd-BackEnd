function createSettingsSchema({ providers } = {}) {
if (typeof providers?.getProviderDefinition !== "function" || typeof providers?.listSupportedProviders !== "function") {
  throw new Error("Chat LLM settings schema requires a provider registry");
}
const { getProviderDefinition, listSupportedProviders } = providers;

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeKey(value) {
  return String(value || "").trim();
}

function getProviderSettingsSchema(providerId) {
  const id = normalizeKey(providerId);
  const schema = getProviderDefinition(id)?.settingsSchema;
  return Array.isArray(schema) ? schema : [];
}

function findSchemaControl(schema, key) {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return null;
  const list = Array.isArray(schema) ? schema : [];
  return (
    list.find((control) => control && typeof control === "object" && normalizeKey(control.key) === normalizedKey) || null
  );
}

function getProviderModel(providerId, modelId) {
  const definition = getProviderDefinition(normalizeKey(providerId));
  const normalizedModelId = normalizeKey(modelId);
  if (!definition || !normalizedModelId) return null;
  const models = Array.isArray(definition.models) ? definition.models : [];
  return models.find((model) => normalizeKey(model?.id) === normalizedModelId) || null;
}

function isControlAllowedForModel(control, modelId) {
  const normalizedModelId = normalizeKey(modelId);
  const blocklist = Array.isArray(control?.modelBlocklist) ? control.modelBlocklist : [];
  return !normalizedModelId || !blocklist.map(normalizeKey).includes(normalizedModelId);
}

function getControlOptions(control, { model } = {}) {
  const options = Array.isArray(control?.options) ? control.options : [];
  const sourceField = normalizeKey(control?.optionsFrom);
  if (!sourceField) return options;

  const allowed = Array.isArray(model?.[sourceField]) ? model[sourceField] : null;
  if (!allowed) return options;

  const allowedSet = new Set(allowed.map(normalizeKey).filter(Boolean));
  return options.filter((option) => allowedSet.has(normalizeKey(option?.value)));
}

function getActiveSchemaControls(providerId, modelId) {
  const schema = getProviderSettingsSchema(providerId);
  const controlsByKey = new Map();

  for (const control of schema) {
    const key = normalizeKey(control?.key);
    if (!key || controlsByKey.has(key)) continue;
    if (!isControlAllowedForModel(control, modelId)) continue;
    controlsByKey.set(key, control);
  }

  return Array.from(controlsByKey.values());
}

function validateSettingsWithSchema(settings, { providerId, modelId } = {}) {
  if (!isPlainObject(settings)) return null;

  const model = getProviderModel(providerId, modelId);
  const controls = getActiveSchemaControls(providerId, modelId);

  for (const control of controls) {
    const key = normalizeKey(control?.key);
    if (!key || !Object.prototype.hasOwnProperty.call(settings, key)) continue;

    const type = normalizeKey(control?.type);
    const value = settings[key];

    if (type === "toggle") {
      if (typeof value !== "boolean") return `Invalid setting ${key}: expected boolean`;
      continue;
    }

    if (type === "select") {
      const normalizedValue = normalizeKey(value);
      const allowedValues = getControlOptions(control, { model }).map((option) => normalizeKey(option?.value)).filter(Boolean);
      if (!normalizedValue || !allowedValues.includes(normalizedValue)) {
        return `Invalid setting ${key} for model ${normalizeKey(modelId) || "(empty)"}: ${
          normalizedValue || "(empty)"
        }. Allowed values: ${allowedValues.join(", ") || "(none)"}`;
      }
      continue;
    }

    if (type === "range" || type === "number") {
      if (!Number.isFinite(Number(value))) return `Invalid setting ${key}: expected number`;
    }
  }

  return null;
}

function getNumericRangeFromControl(control) {
  if (!isPlainObject(control)) return null;
  const type = normalizeKey(control.type);
  if (type !== "range" && type !== "number") return null;

  const min = Number(control.min);
  const max = Number(control.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max, type };
}

function getProviderNumericRange(providerId, key) {
  const schema = getProviderSettingsSchema(providerId);
  const control = findSchemaControl(schema, key);
  return getNumericRangeFromControl(control);
}

let globalNumericRangeCache = null;

function buildGlobalNumericRanges() {
  const ranges = new Map();
  for (const provider of listSupportedProviders()) {
    const providerId = normalizeKey(provider?.id);
    if (!providerId) continue;

    const schema = getProviderSettingsSchema(providerId);
    for (const control of schema) {
      const key = normalizeKey(control?.key);
      if (!key) continue;

      const range = getNumericRangeFromControl(control);
      if (!range) continue;

      const existing = ranges.get(key);
      if (!existing) {
        ranges.set(key, { min: range.min, max: range.max });
        continue;
      }

      ranges.set(key, {
        min: Math.min(existing.min, range.min),
        max: Math.max(existing.max, range.max),
      });
    }
  }

  globalNumericRangeCache = ranges;
}

function getGlobalNumericRange(key) {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return null;
  if (!globalNumericRangeCache) buildGlobalNumericRanges();
  return globalNumericRangeCache.get(normalizedKey) || null;
}

function clampNumber(value, { min, max, fallback } = {}) {
  if (!Number.isFinite(value)) return fallback;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return value;
  return Math.min(max, Math.max(min, value));
}

function clampNumberWithRange(value, range, { fallback } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return number;
  return Math.min(range.max, Math.max(range.min, number));
}

return Object.freeze({
  getProviderSettingsSchema,
  getProviderModel,
  getControlOptions,
  getActiveSchemaControls,
  isControlAllowedForModel,
  validateSettingsWithSchema,
  getProviderNumericRange,
  getGlobalNumericRange,
  clampNumber,
  clampNumberWithRange,
});
}

module.exports = { createSettingsSchema };
