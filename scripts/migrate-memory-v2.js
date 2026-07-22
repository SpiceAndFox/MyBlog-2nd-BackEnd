const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true });
const db = require("../db");

async function main() {
  const directory = path.join(__dirname, "../migrations/memory");
  const files = fs.readdirSync(directory).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(directory, file), "utf8");
    await db.query(sql);
  }
  process.stdout.write("Memory Control v2 schema migration completed.\n");
}
main().then(() => db.end()).catch(async (error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  try { await db.end(); } catch {}
  process.exitCode = 1;
});
