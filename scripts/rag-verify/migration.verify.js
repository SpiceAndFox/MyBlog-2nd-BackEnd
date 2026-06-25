// T7 verify: migration file `alter_chat_rag_chunks_add_embedding_text.sql` exists
// and contains the required statements. Failing-first: run before the SQL file
// exists to confirm it FAILS, then create the SQL file and re-run to confirm PASS.
// Standalone CommonJS — no module-alias, no config loader, no DB.

const fs = require('fs');
const path = require('path');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  '..',
  'models',
  'tableCreate',
  'alter_chat_rag_chunks_add_embedding_text.sql',
);

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

if (!fs.existsSync(MIGRATION_PATH)) {
  console.error(`FAIL: migration file not found at ${MIGRATION_PATH}`);
  process.exit(1);
}

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

assert(
  sql.includes('ALTER TABLE chat_rag_chunks'),
  'file must contain `ALTER TABLE chat_rag_chunks`',
);

assert(
  sql.includes('ADD COLUMN IF NOT EXISTS embedding_text TEXT NOT NULL'),
  'file must contain `ADD COLUMN IF NOT EXISTS embedding_text TEXT NOT NULL`',
);

assert(
  sql.includes('UPDATE chat_rag_chunks SET embedding_text = content'),
  'file must contain `UPDATE chat_rag_chunks SET embedding_text = content` backfill',
);

// MUST NOT DO guards.
assert(
  !/DROP\s+(TABLE|COLUMN)/i.test(sql),
  'file must NOT drop any table or column',
);

assert(
  !sql.includes('embedding_text IS NULL') &&
    !/embedding_text\s+NULL\b/i.test(sql.replace(/NOT NULL/g, '')),
  'embedding_text must NOT be NULLable',
);

console.log('OK: migration file present');