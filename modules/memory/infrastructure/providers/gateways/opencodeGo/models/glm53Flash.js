// OpenCode Go integration verified with low, JSON Object and assistant repair turns.
// https://opencode.ai/docs/go/#endpoints
module.exports = {
  id: "glm-5.3-flash",
  policy: {
    reasoningEncoding: "reasoning-effort",
    reasoningEfforts: ["low", "high", "max"],
    thinkingModes: ["enabled"],
    outputModes: ["json_object"],
  },
};
