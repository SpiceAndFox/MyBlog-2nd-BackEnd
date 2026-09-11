// Syntax accepted for runtime settings. Per-model capabilities narrow these
// choices during provider initialization, after environment parsing.
const REASONING_EFFORT_VALUES = Object.freeze(["max", "xhigh", "high", "medium", "low", "minimal", "none"]);
const THINKING_MODE_VALUES = Object.freeze(["enabled", "disabled"]);

module.exports = { REASONING_EFFORT_VALUES, THINKING_MODE_VALUES };
