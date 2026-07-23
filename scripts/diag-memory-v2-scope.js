#!/usr/bin/env node
/* eslint-disable no-console */
// Read-only diagnostic for Memory v2 force-drain "incomplete" failures.
// Usage: node scripts/diag-memory-v2-scope.js --userId 1 --presetId default

const { createCommandContext } = require("../app/composition/commandContext");

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (!argument.startsWith("--") || argv[index + 1] === undefined || String(argv[index + 1]).startsWith("--")) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    values[argument.slice(2)] = String(argv[index + 1]);
    index += 1;
  }
  return values;
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const userId = Number(values.userId);
  const presetId = String(values.presetId ?? "").trim();
  if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId) {
    throw new Error("--userId must be a positive integer and --presetId cannot be empty");
  }

  const context = createCommandContext();
  const db = context.database;
  try {
    console.log(`\n=== Memory v2 diagnostic: userId=${userId} presetId=${presetId} ===\n`);

    const preset = await db.query(
      `SELECT preset_id, deleted_at FROM chat_prompt_presets WHERE user_id=$1 AND preset_id=$2`,
      [userId, presetId],
    );
    console.log("[preset]");
    console.log(JSON.stringify(preset.rows, null, 2));

    const state = await db.query(
      `SELECT user_id, preset_id, memory_state, updated_at FROM chat_preset_memory WHERE user_id=$1 AND preset_id=$2`,
      [userId, presetId],
    );
    console.log("\n[chat_preset_memory.state]");
    if (!state.rows[0]) {
      console.log("  (no authority state row)");
    } else {
      const s = state.rows[0].memory_state;
      console.log(JSON.stringify({
        schemaVersion: s?.schemaVersion ?? s?.schema_version,
        sourceGeneration: s?.meta?.sourceGeneration,
        revision: s?.meta?.revision,
        targetCursors: s?.meta?.targetCursors,
        updatedAt: state.rows[0].updated_at,
      }, null, 2));
    }

    const targets = await db.query(
      `SELECT target_key, source_generation, rebuild_boundary_message_id, status, consecutive_errors,
              last_error_reason, last_task_id, next_retry_at, updated_at
       FROM chat_memory_target_status WHERE user_id=$1 AND preset_id=$2 ORDER BY target_key`,
      [userId, presetId],
    );
    console.log("\n[chat_memory_target_status]");
    console.log(JSON.stringify(targets.rows, null, 2));

    const tasks = await db.query(
      `SELECT task_id, target_key, source_generation, task_type, parent_task_id, predecessor_task_id,
              status, stage, cursor_before, target_message_id, base_revision, attempt,
              not_before, last_error_reason, result_revision, created_at, updated_at
       FROM chat_memory_tasks WHERE user_id=$1 AND preset_id=$2
       ORDER BY updated_at DESC, created_at DESC LIMIT 20`,
      [userId, presetId],
    );
    console.log("\n[chat_memory_tasks (latest 20)]");
    console.log(JSON.stringify(tasks.rows, null, 2));

    const sourceBoundary = await db.query(
      `SELECT get_boundary_message_id($1, $2) AS boundary`,
      [userId, presetId],
    ).catch((error) => ({ rows: [{ boundary: `query_failed: ${error.message}` }] }));
    console.log("\n[source boundary]");
    console.log(JSON.stringify(sourceBoundary.rows[0], null, 2));

    const notifications = await db.query(
      `SELECT subject_kind, subject_key, notification_type, boundary_message_id, source_generation, created_at
       FROM chat_memory_recovery_notifications WHERE user_id=$1 AND preset_id=$2
       ORDER BY created_at DESC LIMIT 10`,
      [userId, presetId],
    ).catch(() => ({ rows: [] }));
    console.log("\n[chat_memory_recovery_notifications (latest 10)]");
    console.log(JSON.stringify(notifications.rows, null, 2));
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };