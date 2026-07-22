module.exports = Object.freeze({
  ...require("./calendar"),
  ...require("./capacity"),
  ...require("./lifecycle"),
  ...require("./renderer"),
  ...require("./contextCoverage"),
  ...require("./health"),
  ...require("./semanticCompiler"),
  ...require("./compiledReducer"),
});
