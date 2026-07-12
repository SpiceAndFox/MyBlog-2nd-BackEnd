const fs = require("node:fs");
const path = require("node:path");
const db = require("../db");

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/memory/001-memory-v2.sql"), "utf8");
  await db.query(sql);
  process.stdout.write("Memory Control v2 schema migration completed.\n");
}
main().then(() => db.end()).catch(async (error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  try { await db.end(); } catch {}
  process.exitCode = 1;
});
