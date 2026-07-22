#!/usr/bin/env node
const MEMORY_SECTIONS = Object.freeze([
  "worldFacts",
  "userProfile",
  "assistantProfile",
  "relationship",
  "milestones",
  "standingAgreements",
  "todos",
  "recentEpisodes",
  "scene",
]);

const SECTION_TARGETS = Object.freeze({
  worldFacts: "worldFacts",
  userProfile: "profileRelationship",
  assistantProfile: "profileRelationship",
  relationship: "profileRelationship",
  milestones: "episodes",
  standingAgreements: "standingAgreements",
  todos: "todos",
  recentEpisodes: "episodes",
  scene: "scene",
});

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
    ? MEMORY_SECTIONS
    : String(values.sections).split(",").map((section) => section.trim()).filter(Boolean);
  if (!requested.length) throw new Error("--sections cannot be empty");
  const unknown = requested.filter((section) => !MEMORY_SECTIONS.includes(section));
  if (unknown.length) {
    throw new Error(`Unsupported section(s): ${[...new Set(unknown)].join(", ")}. Supported: ${MEMORY_SECTIONS.join(", ")}`);
  }
  const selected = new Set(requested);
  return { help: false, userId, presetId, sections: MEMORY_SECTIONS.filter((section) => selected.has(section)) };
}

function printUsage(stream = process.stdout) {
  stream.write([
    "Usage:",
    "  npm run inspect:memory-v2 -- --userId <id> --presetId <id> [--sections <section,...>]",
    "",
    "Sections:",
    `  ${MEMORY_SECTIONS.join(",")}`,
    "",
    "This command is read-only. By default it prints all rendered memory sections.",
    "",
  ].join("\n"));
}

function renderItems(items) {
  return items.length ? items.map((item) => `- ${item.text}`).join("\n") : "(无)";
}

function renderMemorySections({
  state,
  targetStatuses = [],
  diagnostics = [],
  sections,
  renderTargetHealthMarker,
  renderTodo,
  renderScene,
}) {
  const markerLine = (section) => {
    const marker = renderTargetHealthMarker(SECTION_TARGETS[section], targetStatuses, diagnostics);
    return marker ? `${marker}\n` : "";
  };
  const renderers = {
    worldFacts: () => `[长期事实]\n${renderItems(state.longTerm.worldFacts)}`,
    userProfile: () => `[User 核心档案]\n${renderItems(state.longTerm.userProfile)}`,
    assistantProfile: () => `[Assistant 核心档案]\n${renderItems(state.longTerm.assistantProfile)}`,
    relationship: () => `[关系模式]\n${renderItems(state.longTerm.relationship)}`,
    milestones: () => `[重要里程碑]\n${renderItems(state.longTerm.milestones)}`,
    standingAgreements: () => `[持续约定]\n${renderItems(state.working.standingAgreements)}`,
    todos: () => [
      `[待办]\n${state.working.todos.filter((todo) => todo.status === "active").map(renderTodo).join("\n") || "(无)"}`,
      `[已逾期待办]\n${state.working.todos.filter((todo) => todo.status === "overdue").map(renderTodo).join("\n") || "(无)"}`,
    ].join("\n\n"),
    recentEpisodes: () => `[最近经历]\n${renderItems(state.working.recentEpisodes)}`,
    scene: () => [
      `[当前状态]\n${renderScene(state.current.scene)}`,
      `[已过期场景 / 上次已知场景]\n${state.current.previousScene ? renderScene(state.current.previousScene) : "(无)"}`,
    ].join("\n\n"),
  };
  const markedTargets = new Set();
  return sections.map((section) => {
    const target = SECTION_TARGETS[section];
    const marker = markedTargets.has(target) ? "" : markerLine(section);
    markedTargets.add(target);
    return `${marker}${renderers[section]()}`;
  }).join("\n\n");
}

async function inspectMemory({ db, memory, userId, presetId, sections }) {
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
      ), '[]'::jsonb) AS diagnostics
    FROM chat_preset_memory pm
    WHERE pm.user_id = $1 AND pm.preset_id = $2
  `, [userId, presetId]);

  if (!rows[0]) throw new Error(`Memory scope not found: userId=${userId}, presetId=${presetId}`);
  if (rows[0].memory_state === null) throw new Error(`Memory state is not initialized: userId=${userId}, presetId=${presetId}`);

  const state = memory.contracts.assertMemoryState(rows[0].memory_state);
  return renderMemorySections({
    state,
    targetStatuses: rows[0].target_statuses,
    diagnostics: rows[0].diagnostics,
    sections,
    renderTargetHealthMarker: memory.domain.renderTargetHealthMarker,
    renderTodo: memory.domain.renderTodo,
    renderScene: memory.domain.renderScene,
  });
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = resolveOptions(parseArgs(argv));
  if (options.help) {
    printUsage();
    return;
  }
  const db = dependencies.db || require("../app/composition/commandDatabase").createCommandDatabase();
  const memory = dependencies.memory || require("../modules/memory/admin");
  const output = await inspectMemory({ db, memory, ...options });
  process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  let db;
  main(process.argv.slice(2), {
    get db() {
      if (!db) db = require("../app/composition/commandDatabase").createCommandDatabase();
      return db;
    },
  }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }).finally(async () => {
    if (db) await db.end();
  });
}

module.exports = { MEMORY_SECTIONS, parseArgs, resolveOptions, renderMemorySections, inspectMemory, main };
