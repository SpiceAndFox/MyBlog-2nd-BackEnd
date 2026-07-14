const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { Pool } = require("pg");
require("dotenv").config({ quiet: true });

const REQUIRED_COLUMNS = Object.freeze({
  chat_preset_memory: ["id", "user_id", "preset_id", "memory_state", "created_at", "updated_at"],
  chat_memory_snapshots: ["id", "user_id", "preset_id", "source_generation", "revision", "schema_version", "state", "created_at"],
  chat_memory_event_groups: ["event_group_id", "user_id", "preset_id", "task_id", "target_key", "source_generation", "schema_version", "base_revision", "result_revision", "cursor_before", "cursor_after", "group_kind", "created_at"],
  chat_memory_events: ["id", "event_group_id", "event_index", "user_id", "preset_id", "task_id", "tick_id", "target_key", "section", "event_kind", "decision", "patch_id", "op", "item_id", "result_item_id", "merged_from_item_ids", "evidence_kind", "reject_reason", "maintenance_task_id", "patch_summary", "normalized_operation", "cleanup_type", "created_at"],
  chat_memory_tasks: ["task_id", "dedupe_key", "user_id", "preset_id", "target_key", "source_generation", "task_type", "parent_task_id", "predecessor_task_id", "resume_epoch", "status", "stage", "cursor_before", "target_message_id", "base_revision", "task_payload", "stage_payload", "attempt", "context_expansion_attempt", "not_before", "last_error_reason", "result_revision", "created_at", "updated_at"],
  chat_memory_target_status: ["user_id", "preset_id", "target_key", "source_generation", "rebuild_boundary_message_id", "status", "consecutive_errors", "last_error_reason", "last_task_id", "next_retry_at", "updated_at"],
  chat_memory_ops_log: ["id", "user_id", "preset_id", "source_generation", "task_id", "tick_id", "target_key", "section", "proposer", "outcome", "attempt", "detail", "created_at"],
  chat_context_projection_checkpoints: ["user_id", "preset_id", "projection_key", "processed_generation", "processed_boundary_message_id", "processed_tombstone_id", "status", "last_error_reason", "updated_at"],
  chat_context_suppression_tombstones: ["id", "user_id", "preset_id", "message_id", "content_hash", "reason", "source_item_id", "source_section", "created_revision", "created_at"],
  chat_context_quality_diagnostics: ["id", "user_id", "preset_id", "subject_kind", "subject_key", "diagnostic_type", "source_generation", "request_id", "target_cursor", "processed_boundary_message_id", "omitted_upper_message_id", "recent_window_start", "original_gap_count", "original_gap_chars", "retained_boundary", "retained_count", "omitted_count", "omitted_chars", "truncated", "detail", "resolved", "resolved_at", "created_at", "updated_at"],
  chat_memory_diagnostic_projection_checkpoints: ["user_id", "preset_id", "projection_key", "processed_event_id", "last_error_reason", "updated_at"],
  chat_memory_recovery_notifications: ["id", "user_id", "preset_id", "subject_kind", "subject_key", "notification_type", "boundary_message_id", "source_generation", "delivered", "delivered_at", "created_at"],
  chat_memory_privacy_operations: ["user_id", "preset_id", "operation_id", "operation_mode", "source_generation", "boundary_message_id", "status", "last_error_reason", "created_at", "updated_at"],
});
const REQUIRED_TABLES = Object.freeze(Object.keys(REQUIRED_COLUMNS));
const REQUIRED_INDEXES = Object.freeze([
  "idx_chat_preset_memory_user_preset", "idx_chat_preset_memory_user_updated_at",
  "idx_memory_events_user_preset", "idx_memory_events_target_decision", "idx_memory_events_group_order", "idx_memory_events_group_patch",
  "idx_memory_tasks_recovery", "idx_memory_tasks_scope_dedupe", "idx_memory_ops_log_health", "idx_memory_ops_log_outcome",
  "idx_suppression_tombstones_lookup", "idx_context_diagnostics_active", "idx_context_diagnostics_one_active", "idx_recovery_notifications_pending",
  "idx_memory_privacy_operations_pending",
]);

function evaluateInspection({ tables, columns, indexes, userTimeZoneColumn, legacy }) {
  const tableSet = new Set(tables);
  const columnMap = new Map();
  for (const column of columns) {
    const values = columnMap.get(column.table_name) || new Map();
    values.set(column.column_name, column);
    columnMap.set(column.table_name, values);
  }
  const missingTables = REQUIRED_TABLES.filter((table) => !tableSet.has(table));
  const missingColumns = [];
  for (const [table, expected] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = columnMap.get(table) || new Map();
    for (const column of expected) if (!actual.has(column)) missingColumns.push(`${table}.${column}`);
  }
  const indexSet = new Set(indexes);
  const missingIndexes = REQUIRED_INDEXES.filter((index) => !indexSet.has(index));
  const memoryState = columnMap.get("chat_preset_memory")?.get("memory_state");
  const keyDefinitionsValid = memoryState?.data_type === "jsonb"
    && userTimeZoneColumn?.data_type === "text" && userTimeZoneColumn?.is_nullable === "NO"
    && columnMap.get("chat_memory_recovery_notifications")?.get("boundary_message_id")?.is_nullable === "NO"
    && String(columnMap.get("chat_memory_recovery_notifications")?.get("boundary_message_id")?.column_default ?? "").includes("0")
    && columnMap.get("chat_context_projection_checkpoints")?.get("processed_tombstone_id")?.is_nullable === "NO"
    && String(columnMap.get("chat_context_projection_checkpoints")?.get("processed_tombstone_id")?.column_default ?? "").includes("0")
    && columnMap.get("chat_context_quality_diagnostics")?.get("truncated")?.is_nullable === "NO"
    && columnMap.get("chat_context_quality_diagnostics")?.get("resolved")?.is_nullable === "NO"
    && columnMap.get("chat_context_quality_diagnostics")?.get("detail")?.data_type === "jsonb"
    && columnMap.get("chat_context_quality_diagnostics")?.get("detail")?.is_nullable === "NO"
    && columnMap.get("chat_memory_diagnostic_projection_checkpoints")?.get("processed_event_id")?.is_nullable === "NO"
    && String(columnMap.get("chat_memory_diagnostic_projection_checkpoints")?.get("processed_event_id")?.column_default ?? "").includes("0");
  const clean = missingTables.length === 0 && missingColumns.length === 0 && missingIndexes.length === 0
    && keyDefinitionsValid && !legacy.checkpointTable && legacy.columns.length === 0;
  return { clean, missingTables, missingColumns, missingIndexes, keyDefinitionsValid };
}

function inspectionReport(result) {
  return {
    target: result.target,
    clean: result.clean,
    tableCount: result.tables.length,
    columnCount: result.columns.length,
    indexCount: result.indexes.length,
    missingTables: result.missingTables,
    missingColumns: result.missingColumns,
    missingIndexes: result.missingIndexes,
    keyDefinitionsValid: result.keyDefinitionsValid,
    userTimeZoneColumn: result.userTimeZoneColumn,
    legacy: result.legacy,
  };
}

function readResolvNameserver() {
  try {
    const match = fs.readFileSync("/etc/resolv.conf", "utf8").match(/^nameserver\s+([^\s#]+)/m);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function readDefaultGateway() {
  try {
    const lines = fs.readFileSync("/proc/net/route", "utf8").trim().split(/\r?\n/).slice(1);
    const row = lines.map((line) => line.trim().split(/\s+/)).find((fields) => fields[1] === "00000000");
    if (!row?.[2] || !/^[0-9A-Fa-f]{8}$/.test(row[2])) return null;
    const bytes = row[2].match(/../g).reverse().map((part) => Number.parseInt(part, 16));
    return bytes.join(".");
  } catch {
    return null;
  }
}

function isLoopback(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(hostname || "").toLowerCase());
}

function candidateUrls() {
  const configured = String(process.env.WINDOWS_DATABASE_URL || process.env.DATABASE_URL || "").trim();
  if (!configured) throw new Error("DATABASE_URL or WINDOWS_DATABASE_URL is required");
  const base = new URL(configured);
  const candidates = [base];
  const isWsl = Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME);
  if (isWsl && isLoopback(base.hostname)) {
    const hosts = [process.env.WINDOWS_DATABASE_HOST, readResolvNameserver(), readDefaultGateway()]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    for (const host of [...new Set(hosts)]) {
      const candidate = new URL(base);
      candidate.hostname = host;
      candidates.push(candidate);
    }
  }
  return candidates;
}

function safeTarget(url) {
  return `${url.hostname}:${url.port || "5432"}`;
}

async function inspect(url) {
  const pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000 });
  try {
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND (table_name LIKE 'chat_memory_%' OR table_name LIKE 'chat_context_%' OR table_name IN ('chat_preset_memory','chat_preset_memory_checkpoints'))
      ORDER BY table_name
    `);
    const columns = await pool.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (table_name LIKE 'chat_memory_%' OR table_name LIKE 'chat_context_%' OR table_name = 'chat_preset_memory')
      ORDER BY table_name, ordinal_position
    `);
    const indexes = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema()
        AND (tablename LIKE 'chat_memory_%' OR tablename LIKE 'chat_context_%' OR tablename = 'chat_preset_memory')
      ORDER BY indexname
    `);
    const userColumns = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'time_zone'
    `);
    const oldColumnNames = new Set([
      "rolling_summary", "rolling_summary_updated_at", "summarized_until_message_id",
      "dirty_since_message_id", "rebuild_required", "core_memory",
    ]);
    const legacyColumns = columns.rows.map((row) => row.column_name).filter((name) => oldColumnNames.has(name));
    const legacyCheckpointTable = tables.rows.some((row) => row.table_name === "chat_preset_memory_checkpoints");
    const result = {
      target: safeTarget(url),
      tables: tables.rows.map((row) => row.table_name),
      columns: columns.rows,
      indexes: indexes.rows.map((row) => row.indexname),
      userTimeZoneColumn: userColumns.rows[0] || null,
      legacy: { checkpointTable: legacyCheckpointTable, columns: legacyColumns },
    };
    return { ...result, ...evaluateInspection(result) };
  } finally {
    await pool.end();
  }
}

function findWindowsPsql() {
  const command = '$cmd = Get-Command psql.exe -ErrorAction SilentlyContinue; if ($cmd) { $cmd.Source } else { Get-ChildItem "C:\\Program Files\\PostgreSQL" -Filter psql.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }';
  const found = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 10000 });
  const windowsPath = String(found.stdout || "").trim();
  if (!windowsPath) return null;
  const converted = spawnSync("wslpath", ["-u", windowsPath], { encoding: "utf8", timeout: 3000 });
  return converted.status === 0 ? String(converted.stdout || "").trim() : null;
}

function inspectThroughWindowsPsql(url) {
  const psql = findWindowsPsql();
  if (!psql) throw new Error("Windows psql.exe was not found");
  const host = isLoopback(url.hostname) ? "127.0.0.1" : url.hostname;
  const port = url.port || "5432";
  const sql = `
    SELECT json_build_object(
      'tables', COALESCE((SELECT json_agg(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema=current_schema() AND (table_name LIKE 'chat_memory_%' OR table_name LIKE 'chat_context_%' OR table_name IN ('chat_preset_memory','chat_preset_memory_checkpoints'))), '[]'::json),
      'columns', COALESCE((SELECT json_agg(json_build_object('table_name',table_name,'column_name',column_name,'data_type',data_type,'is_nullable',is_nullable,'column_default',column_default) ORDER BY table_name,ordinal_position) FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name LIKE 'chat_memory_%' OR table_name LIKE 'chat_context_%' OR table_name='chat_preset_memory')), '[]'::json),
      'indexes', COALESCE((SELECT json_agg(indexname ORDER BY indexname) FROM pg_indexes WHERE schemaname=current_schema() AND (tablename LIKE 'chat_memory_%' OR tablename LIKE 'chat_context_%' OR tablename='chat_preset_memory')), '[]'::json),
      'userTimeZoneColumn', (SELECT json_build_object('column_name',column_name,'data_type',data_type,'is_nullable',is_nullable,'column_default',column_default) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='time_zone'),
      'legacyCheckpointTable', EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='chat_preset_memory_checkpoints'),
      'legacyColumns', COALESCE((SELECT json_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='chat_preset_memory' AND column_name IN ('rolling_summary','rolling_summary_updated_at','summarized_until_message_id','dirty_since_message_id','rebuild_required','core_memory')), '[]'::json)
    )::text;
  `;
  const result = spawnSync(psql, [
    "-X", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1",
    "-h", host, "-p", port,
    "-U", decodeURIComponent(url.username), "-d", decodeURIComponent(url.pathname.replace(/^\//, "")),
    "-c", sql,
  ], {
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      PGPASSWORD: decodeURIComponent(url.password),
      WSLENV: [process.env.WSLENV, "PGPASSWORD"].filter(Boolean).join(":"),
    },
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.error?.message || "Windows psql failed").trim());
  const parsed = JSON.parse(String(result.stdout || "").trim());
  const normalized = {
    target: `${host}:${port} (Windows psql.exe)`,
    tables: parsed.tables,
    columns: parsed.columns,
    indexes: parsed.indexes,
    userTimeZoneColumn: parsed.userTimeZoneColumn,
    legacy: { checkpointTable: parsed.legacyCheckpointTable, columns: parsed.legacyColumns },
  };
  return { ...normalized, ...evaluateInspection(normalized) };
}

async function main() {
  const urls = candidateUrls();
  const failures = [];
  for (const url of urls) {
    try {
      const result = await inspect(url);
      process.stdout.write(`${JSON.stringify(inspectionReport(result), null, 2)}\n`);
      if (!result.clean) process.exitCode = 2;
      return;
    } catch (error) {
      failures.push({ target: safeTarget(url), code: error.code || null, message: error.message });
    }
  }
  if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) {
    try {
      const result = inspectThroughWindowsPsql(urls[0]);
      process.stdout.write(`${JSON.stringify(inspectionReport(result), null, 2)}\n`);
      if (!result.clean) process.exitCode = 2;
      return;
    } catch (error) {
      failures.push({ target: "windows-localhost:5432 (psql.exe)", code: error.code || null, message: error.message });
    }
  }
  const error = new Error("Unable to connect to PostgreSQL from WSL");
  error.failures = failures;
  throw error;
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  for (const failure of error.failures || []) {
    process.stderr.write(`- ${failure.target}: ${failure.code || "ERROR"} ${failure.message}\n`);
  }
  process.stderr.write("Set WINDOWS_DATABASE_HOST to the Windows host IP, and ensure PostgreSQL listen_addresses/pg_hba.conf and Windows Firewall allow the WSL subnet.\n");
  process.exitCode = 1;
});

module.exports = { REQUIRED_TABLES, REQUIRED_COLUMNS, REQUIRED_INDEXES, evaluateInspection, inspectionReport };
