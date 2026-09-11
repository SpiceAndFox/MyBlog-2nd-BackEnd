const glm53Flash = require("./models/glm53Flash");

// Model capabilities are scoped to B.AI; other hosted models keep generic defaults.
module.exports = { id: "bai", defaults: {}, models: [glm53Flash] };
