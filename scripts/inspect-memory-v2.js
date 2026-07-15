#!/usr/bin/env node
process.env.DOTENV_CONFIG_QUIET ||= "true";
require("dotenv").config({ quiet: true });

const PROFILE_SECTIONS = Object.freeze(["userProfile", "assistantProfile"]);

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument === "--help") {
      values.help = true;
      continue;
    }
    if (!argument.startsWith("--") || argv[index + 1] === undefined || String(argv[index + 1]).startsWith("--")) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    const key = argument.slice(2);
    if (!["userId", "presetId", "sections"].includes(key)) throw new Error(`Unknown argument: ${argument}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`Duplicate argument: ${argument}`);
    values[key] = String(argv[index + 1]);
    index += 1;
  }
  return values;
}

function resolveOptions(values) {
  if (values.help) return { help: true };
  const userId = Number(values.userId);
  const presetId = String(values.presetId ?? "").trim();
  if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId) {
    throw new Error("--userId must be a positive integer and --presetId cannot be empty");
  }

  const requested = values.sections === undefined
    ? PROFILE_SECTIONS
    : String(values.sections).split(",").map((section) => section.trim()).filter(Boolean);
  if (!requested.length) throw new Error("--sections cannot be empty");
  const unknown = requested.filter((section) => !PROFILE_SECTIONS.includes(section));
  if (unknown.length) {
    throw new Error(`Unsupported section(s): ${[...new Set(unknown)].join(", ")}. Supported: ${PROFILE_SECTIONS.join(", ")}`);
  }
  const selected = new Set(requested);
  return { help: false, userId, presetId, sections: PROFILE_SECTIONS.filter((section) => selected.has(section)) };
}

function printUsage(stream = process.stdout) {
  stream.write([
    "Usage:",
    "  npm run inspect:memory-v2 -- --userId <id> --presetId <id> [--sections userProfile,assistantProfile]",
    "",
    "This command is read-only. By default it prints both rendered profile sections.",
    "",
  ].join("\n"));
}

function renderItems(items) {
  return items.length ? items.map((item) => `- ${item.text}`).join("\n") : "(无)";
}

function renderProfiles({ state, targetStatuses = [], diagnostics = [], sections, renderTargetHealthMarker }) {
  const marker = renderTargetHealthMarker("profileRelationship", targetStatuses, diagnostics);
  const renderers = {
    userProfile: () => `${marker ? `${marker}\n` : ""}[User 核心档案]\n${renderItems(state.longTerm.userProfile)}`,
    assistantProfile: () => `[Assistant 核心档案]\n${renderItems(state.longTerm.assistantProfile)}`,
  };
  return sections.map((section) => renderers[section]()).join("\n\n");
}

async function inspectProfiles({ db, memory, userId, presetId, sections }) {
  const { rows } = await db.query(`
    SELECT
      pm.memory_state,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(status_row) ORDER BY status_row.target_key)
        FROM chat_memory_target_status status_row
        WHERE status_row.user_id = pm.user_id AND status_row.preset_id = pm.preset_id
      ), '[]'::jsonb) AS target_statuses,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(diagnostic_row) ORDER BY diagnostic_row.created_at, diagnostic_row.id)
        FROM chat_context_quality_diagnostics diagnostic_row
        WHERE diagnostic_row.user_id = pm.user_id
          AND diagnostic_row.preset_id = pm.preset_id
          AND diagnostic_row.resolved = FALSE
          AND (diagnostic_row.subject_kind <> 'projection' OR diagnostic_row.subject_key = 'rag')
      ), '[]'::jsonb) AS diagnostics,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(tombstone_row) ORDER BY tombstone_row.message_id, tombstone_row.id)
        FROM chat_context_suppression_tombstones tombstone_row
        WHERE tombstone_row.user_id = pm.user_id AND tombstone_row.preset_id = pm.preset_id
      ), '[]'::jsonb) AS tombstones
    FROM chat_preset_memory pm
    WHERE pm.user_id = $1 AND pm.preset_id = $2
  `, [userId, presetId]);

  if (!rows[0]) throw new Error(`Memory scope not found: userId=${userId}, presetId=${presetId}`);
  if (rows[0].memory_state === null) throw new Error(`Memory state is not initialized: userId=${userId}, presetId=${presetId}`);

  const rawState = memory.contracts.assertMemoryState(rows[0].memory_state);
  const state = memory.domain.filterRebuiltState(rawState, rows[0].tombstones).state;
  return renderProfiles({
    state,
    targetStatuses: rows[0].target_statuses,
    diagnostics: rows[0].diagnostics,
    sections,
    renderTargetHealthMarker: memory.domain.renderTargetHealthMarker,
  });
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = resolveOptions(parseArgs(argv));
  if (options.help) {
    printUsage();
    return;
  }
  const db = dependencies.db || require("../db");
  const memory = dependencies.memory || require("../modules/memory");
  const output = await inspectProfiles({ db, memory, ...options });
  process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  let db;
  main(process.argv.slice(2), {
    get db() {
      if (!db) db = require("../db");
      return db;
    },
  }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }).finally(async () => {
    if (db) await db.end();
  });
}

module.exports = { PROFILE_SECTIONS, parseArgs, resolveOptions, renderProfiles, inspectProfiles, main };
