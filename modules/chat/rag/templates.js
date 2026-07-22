function normalizeTemplate(value) {
  return String(value || "")
    .split("\\n")
    .join("\n");
}

function renderTemplate(rawTemplate, vars) {
  let rendered = normalizeTemplate(rawTemplate);
  const entries = vars && typeof vars === "object" && !Array.isArray(vars) ? Object.entries(vars) : [];

  for (const [key, rawValue] of entries) {
    const token = `{{${String(key)}}}`;
    const value = rawValue === null || rawValue === undefined ? "" : String(rawValue);
    rendered = rendered.split(token).join(value);
  }

  return rendered;
}

module.exports = {
  normalizeTemplate,
  renderTemplate,
};

