const databaseEntry = require("../../db");
const { loadEnvironment } = require("./environment");

function createCommandDatabase({ environment, loadDotenv } = {}) {
  const loadedEnvironment = loadEnvironment({
    environment: environment || process.env,
    loadDotenv: loadDotenv ?? environment === undefined,
  });
  const database = databaseEntry.createDatabase({
    connectionString: loadedEnvironment.DATABASE_URL,
  });
  databaseEntry.configureDatabase(database);
  return database;
}

module.exports = { createCommandDatabase };
