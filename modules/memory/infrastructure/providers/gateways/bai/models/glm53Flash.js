// https://docs.b.ai/llmservice/models/glm-5-3-flash/
// Thinking is always on; explicitly select low/high/max instead of the upstream max default.
module.exports = {
  id: "glm-5.3-flash",
  policy: {
    reasoningEncoding: "reasoning-effort",
    reasoningEfforts: ["low", "high", "max"],
    thinkingModes: ["enabled"],
    // Start with JSON Object + local validation. Enable strict schema only after probing it.
    outputModes: ["json_object"],
  },
};
