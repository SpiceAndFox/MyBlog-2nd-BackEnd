#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  loadProposerPrompt,
  buildOutputSchema,
  schemaRepairPrompt,
} = require("../../modules/memory/admin");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const STATIC_FILES = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
});

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument === "--help" || argument === "-h") {
      values.help = true;
      continue;
    }
    if (argument !== "--port" || argv[index + 1] === undefined) throw new Error(`Invalid argument: ${argument}`);
    if (values.port !== undefined) throw new Error("Duplicate argument: --port");
    values.port = String(argv[index + 1]);
    index += 1;
  }
  return values;
}

function resolveOptions(values) {
  if (values.help) return { help: true };
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
  return { help: false, host: HOST, port };
}

function printUsage(stream = process.stdout) {
  stream.write([
    "Usage:",
    "  npm run gui:memory-v2 [-- --port <port>]",
    "",
    `Starts a read-only Memory proposer task viewer on http://${HOST}:${DEFAULT_PORT}.`,
    "The server only binds to localhost and never writes Memory data.",
    "",
  ].join("\n"));
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw Object.assign(new Error(`${name} must be a positive integer`), { statusCode: 400 });
  return parsed;
}

function scopeFrom(searchParams) {
  const userId = positiveInteger(searchParams.get("userId"), "userId");
  const presetId = String(searchParams.get("presetId") || "").trim();
  if (!presetId || presetId.length > 200) throw Object.assign(new Error("presetId must be 1-200 characters"), { statusCode: 400 });
  return { userId, presetId };
}

function generationFrom(searchParams) {
  const raw = searchParams.get("generation");
  if (raw === null || raw === "" || raw === "all") return null;
  return positiveInteger(raw, "generation");
}

function summarizeGenerations(rows) {
  const generations = new Map();
  for (const row of rows) {
    const key = String(row.source_generation);
    const current = generations.get(key) || {
      sourceGeneration: Number(row.source_generation),
      taskCount: 0,
      statuses: {},
      targets: {},
      startedAt: row.first_created_at,
      updatedAt: row.last_updated_at,
    };
    const count = Number(row.task_count);
    current.taskCount += count;
    current.statuses[row.status] = (current.statuses[row.status] || 0) + count;
    current.targets[row.target_key] = (current.targets[row.target_key] || 0) + count;
    generations.set(key, current);
  }
  return [...generations.values()].sort((left, right) => right.sourceGeneration - left.sourceGeneration);
}

function reconstructEffectiveEnvelope(taskPayload, stagePayload, contextExpansionAttempt) {
  const semanticInputVariant = stagePayload?.semanticInputVariant
    ?? (Number(contextExpansionAttempt || 0) > 0 ? "expanded" : "base");
  // The viewer may inspect terminal rows written by the pre-expandedArtifact implementation.
  const legacyExpandedArtifact = stagePayload?.expandedEnvelope?.artifact;
  const expandedArtifact = stagePayload?.expandedArtifact
    ?? (legacyExpandedArtifact ? {
      publicInput: legacyExpandedArtifact.publicInput,
      messageMeta: legacyExpandedArtifact.messageMeta,
    } : null);
  if (semanticInputVariant !== "expanded") return { effectiveEnvelope: taskPayload, expandedArtifact, semanticInputVariant };
  if (!expandedArtifact?.publicInput || !expandedArtifact?.messageMeta || !taskPayload?.artifact) {
    return { effectiveEnvelope: null, expandedArtifact, semanticInputVariant };
  }
  const effectiveEnvelope = structuredClone(taskPayload);
  effectiveEnvelope.artifact = {
    ...effectiveEnvelope.artifact,
    publicInput: structuredClone(expandedArtifact.publicInput),
    messageMeta: structuredClone(expandedArtifact.messageMeta),
    refMap: structuredClone(taskPayload.artifact.refMap),
  };
  effectiveEnvelope.task.observedMessageIds = (effectiveEnvelope.artifact.publicInput.messages || []).map((message) => message.id);
  return { effectiveEnvelope, expandedArtifact, semanticInputVariant };
}

async function hydrateTask(row, dependencies = {}) {
  const promptLoader = dependencies.promptLoader || loadProposerPrompt;
  const schemaBuilder = dependencies.schemaBuilder || buildOutputSchema;
  const repairPromptBuilder = dependencies.repairPromptBuilder || schemaRepairPrompt;
  const taskPayload = row.task_payload || null;
  const stagePayload = row.stage_payload || null;
  const { effectiveEnvelope, expandedArtifact, semanticInputVariant } = reconstructEffectiveEnvelope(
    taskPayload,
    stagePayload,
    row.context_expansion_attempt,
  );
  const proposer = effectiveEnvelope?.task?.proposer || taskPayload?.task?.proposer || null;
  const targetSections = effectiveEnvelope?.task?.targetSections || taskPayload?.task?.targetSections || [];
  const repairFeedback = stagePayload?.schemaRepairFeedback || null;
  let currentPrompt = null;
  let currentRepairPrompt = null;
  let responseSchema = null;
  let reconstructionError = semanticInputVariant === "expanded" && !effectiveEnvelope
    ? "Expanded task artifact is missing from durable state"
    : null;

  if (proposer) {
    try {
      currentPrompt = await promptLoader(proposer);
      currentRepairPrompt = repairFeedback ? repairPromptBuilder(currentPrompt, repairFeedback) : null;
      responseSchema = schemaBuilder(proposer, targetSections);
    } catch (error) {
      reconstructionError = String(error?.message || error);
    }
  }

  const semanticResult = stagePayload?.semanticResult || null;
  const unableResult = stagePayload?.unableResult || null;
  const compiledProposal = stagePayload?.compiledProposal || null;
  const outputAvailability = semanticResult || unableResult
    ? "persisted"
    : ["output_schema_invalid", "semantic_schema_invalid"].includes(row.last_error_reason)
      ? "invalid_output_not_persisted"
      : "not_persisted";

  return {
    taskId: row.task_id,
    userId: Number(row.user_id),
    presetId: row.preset_id,
    sourceGeneration: Number(row.source_generation),
    targetKey: row.target_key,
    proposer,
    targetSections,
    taskType: row.task_type,
    status: row.status,
    stage: row.stage,
    cursorBefore: row.cursor_before === null ? null : Number(row.cursor_before),
    targetMessageId: row.target_message_id === null ? null : Number(row.target_message_id),
    baseRevision: Number(row.base_revision),
    resultRevision: row.result_revision === null ? null : Number(row.result_revision),
    attempt: Number(row.attempt),
    contextExpansionAttempt: Number(row.context_expansion_attempt),
    lastErrorReason: row.last_error_reason,
    notBefore: row.not_before,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    input: {
      persistedEnvelope: taskPayload,
      expandedArtifact,
      semanticInputVariant,
      effectiveEnvelope,
      currentPrompt,
      currentRepairPrompt,
      responseSchema,
      repairFeedback,
      reconstructionError,
    },
    output: {
      availability: outputAvailability,
      semanticResult,
      unableResult,
      compiledProposal,
    },
    stagePayload,
    ops: Array.isArray(row.ops) ? row.ops : [],
  };
}

async function listGenerations(db, scope) {
  const { rows } = await db.query(`
    SELECT
      source_generation,
      status,
      target_key,
      COUNT(*)::integer AS task_count,
      MIN(created_at) AS first_created_at,
      MAX(updated_at) AS last_updated_at
    FROM chat_memory_tasks
    WHERE user_id = $1
      AND preset_id = $2
      AND task_type IN ('normal', 'maintenance')
    GROUP BY source_generation, status, target_key
    ORDER BY source_generation DESC, target_key, status
  `, [scope.userId, scope.presetId]);
  return summarizeGenerations(rows);
}

async function listTasks(db, scope, generation, dependencies = {}) {
  const params = [scope.userId, scope.presetId];
  const generationClause = generation === null ? "" : `AND t.source_generation = $${params.push(generation)}`;
  const { rows } = await db.query(`
    SELECT
      t.task_id,
      t.user_id,
      t.preset_id,
      t.source_generation,
      t.target_key,
      t.task_type,
      t.status,
      t.stage,
      t.cursor_before,
      t.target_message_id,
      t.base_revision,
      t.result_revision,
      t.attempt,
      t.context_expansion_attempt,
      t.not_before,
      t.last_error_reason,
      t.task_payload,
      t.stage_payload,
      t.created_at,
      t.updated_at,
      COALESCE(ops.rows, '[]'::jsonb) AS ops
    FROM chat_memory_tasks t
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', entry.id,
          'outcome', entry.outcome,
          'attempt', entry.attempt,
          'section', entry.section,
          'proposer', entry.proposer,
          'detail', entry.detail,
          'createdAt', entry.created_at
        ) ORDER BY entry.id
      ) AS rows
      FROM chat_memory_ops_log entry
      WHERE entry.task_id = t.task_id
    ) ops ON TRUE
    WHERE t.user_id = $1
      AND t.preset_id = $2
      AND t.task_type IN ('normal', 'maintenance')
      ${generationClause}
    ORDER BY t.source_generation DESC, t.created_at, t.task_id
  `, params);
  return Promise.all(rows.map((row) => hydrateTask(row, dependencies)));
}

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, securityHeaders("application/json; charset=utf-8"));
  response.end(`${JSON.stringify(payload)}\n`);
}

async function serveStatic(response, pathname) {
  const descriptor = STATIC_FILES[pathname];
  if (!descriptor) return false;
  const [filename, contentType] = descriptor;
  const body = await fs.readFile(path.join(__dirname, filename));
  response.writeHead(200, securityHeaders(contentType));
  response.end(body);
  return true;
}

function createServer({ db, promptLoader, schemaBuilder, repairPromptBuilder } = {}) {
  if (!db?.query) throw new Error("Memory task GUI requires a database query dependency");
  const dependencies = { promptLoader, schemaBuilder, repairPromptBuilder };
  return http.createServer(async (request, response) => {
    try {
      if (request.method !== "GET") return sendJson(response, 405, { error: "Only GET is supported" });
      const url = new URL(request.url, `http://${HOST}`);
      if (url.pathname === "/api/health") return sendJson(response, 200, { status: "ok", readOnly: true });
      if (url.pathname === "/api/generations") {
        const scope = scopeFrom(url.searchParams);
        return sendJson(response, 200, { scope, generations: await listGenerations(db, scope) });
      }
      if (url.pathname === "/api/tasks") {
        const scope = scopeFrom(url.searchParams);
        const generation = generationFrom(url.searchParams);
        const tasks = await listTasks(db, scope, generation, dependencies);
        return sendJson(response, 200, { scope, generation, taskCount: tasks.length, tasks });
      }
      if (await serveStatic(response, url.pathname)) return;
      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) process.stderr.write(`${error?.stack || error}\n`);
      return sendJson(response, statusCode, { error: statusCode >= 500 ? "Task query failed" : error.message });
    }
  });
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = resolveOptions(parseArgs(argv));
  if (options.help) {
    printUsage();
    return { status: "help" };
  }
  const db = dependencies.db || require("../../app/composition/commandDatabase").createCommandDatabase();
  const server = createServer({ db });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  process.stdout.write(`Memory proposer task GUI: http://${options.host}:${options.port}\n`);
  process.stdout.write("Read-only; press Ctrl+C to stop.\n");
  return { status: "listening", server, db, ...options };
}

if (require.main === module) {
  let resources;
  main().then((value) => { resources = value; }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
  const shutdown = async () => {
    if (resources?.server) await new Promise((resolve) => resources.server.close(resolve));
    if (resources?.db) await resources.db.end();
    process.exit();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = {
  DEFAULT_PORT,
  HOST,
  parseArgs,
  resolveOptions,
  scopeFrom,
  generationFrom,
  summarizeGenerations,
  hydrateTask,
  listGenerations,
  listTasks,
  createServer,
  main,
};
