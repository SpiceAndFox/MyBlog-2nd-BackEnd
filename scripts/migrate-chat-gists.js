const fs = require("node:fs");
const path = require("node:path");
const { createCommandDatabase } = require("../app/composition/commandDatabase");

async function main() {
  const db = createCommandDatabase();
  try {
    await db.query(fs.readFileSync(path.join(__dirname, "../migrations/chat/001-gist-tasks.sql"), "utf8"));
    process.stdout.write("Chat gist task migration completed.\n");
  } finally { await db.end(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
