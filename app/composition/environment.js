const dotenv = require("dotenv");

function loadEnvironment({ environment = process.env, loadDotenv = environment === process.env } = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("An environment object is required");
  }
  if (loadDotenv) dotenv.config({ quiet: true });
  return Object.freeze({ ...environment });
}

module.exports = { loadEnvironment };
