const pg = require("pg");

function createDatabase({ connectionString, Pool = pg.Pool } = {}) {
  if (typeof connectionString !== "string" || !connectionString.trim()) {
    throw new Error("Database connectionString is required");
  }
  if (typeof Pool !== "function") throw new Error("Database Pool constructor is required");

  const pool = new Pool({ connectionString: connectionString.trim() });
  return Object.freeze({
    query: (text, params) => pool.query(text, params),
    end: () => pool.end(),
    getClient: () => pool.connect(),
  });
}

let configuredDatabase = null;

function configureDatabase(database) {
  if (!database?.query || !database?.getClient || !database?.end) {
    throw new Error("A database adapter with query, getClient, and end is required");
  }
  configuredDatabase = database;
  return configuredDatabase;
}

function getDatabase() {
  if (!configuredDatabase) {
    throw new Error("Database is not configured; create it in app/composition before use");
  }
  return configuredDatabase;
}

const database = {
  query(text, params) { return getDatabase().query(text, params); },
  end() { return getDatabase().end(); },
  getClient() { return getDatabase().getClient(); },
  createDatabase,
  configureDatabase,
  getDatabase,
};

module.exports = database;
