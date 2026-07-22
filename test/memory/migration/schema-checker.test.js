const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_TABLES, REQUIRED_COLUMNS, REQUIRED_INDEXES, REQUIRED_CONSTRAINTS, evaluateInspection } = require("../../../scripts/check-memory-schema");

test("schema inspection cannot report clean when any v2 table, column, or index is missing", () => {
  const base = {
    tables: REQUIRED_TABLES,
    columns: Object.entries(REQUIRED_COLUMNS).flatMap(([table, columns]) => columns.map((column) => ({
      table_name: table, column_name: column, data_type: table === "chat_preset_memory" && column === "memory_state" ? "jsonb" : "text",
      is_nullable: "YES", column_default: null,
    }))),
    indexes: REQUIRED_INDEXES,
    constraints: REQUIRED_CONSTRAINTS,
    userTimeZoneColumn: { data_type: "text", is_nullable: "NO" },
    legacy: { checkpointTable: false, columns: [] },
    duplicateActiveDiagnostics: [],
    unsupportedProjectionCheckpoints: [],
  };
  for (const column of base.columns) {
    if (["chat_memory_snapshots", "chat_memory_event_groups", "chat_memory_tasks"].includes(column.table_name) && column.column_name === "schema_version") {
      column.data_type = "text"; column.is_nullable = "NO";
    }
    if (column.table_name === "chat_context_quality_diagnostics" && column.column_name === "detail") {
      column.data_type = "jsonb"; column.is_nullable = "NO"; column.column_default = "'{}'::jsonb";
    }
    if (column.table_name === "chat_memory_privacy_operations" && column.column_name === "operation_payload") {
      column.data_type = "jsonb"; column.is_nullable = "NO"; column.column_default = "'{}'::jsonb";
    }
    if (column.table_name === "chat_memory_recovery_notifications" && column.column_name === "boundary_message_id") {
      column.is_nullable = "NO"; column.column_default = "0";
    }
    if (column.table_name === "chat_memory_diagnostic_projection_checkpoints" && column.column_name === "processed_event_id") {
      column.is_nullable = "NO"; column.column_default = "0";
    }
    if (column.table_name === "chat_context_projection_checkpoints" && column.column_name === "processed_tombstone_id") {
      column.is_nullable = "NO"; column.column_default = "0";
    }
    if (column.table_name === "chat_context_quality_diagnostics" && ["truncated", "resolved"].includes(column.column_name)) column.is_nullable = "NO";
  }
  assert.equal(evaluateInspection(base).clean, true);
  assert.equal(evaluateInspection({ ...base, tables: base.tables.filter((table) => table !== "chat_memory_tasks") }).clean, false);
  assert.equal(evaluateInspection({ ...base, indexes: base.indexes.filter((index) => index !== "idx_memory_tasks_recovery") }).clean, false);
  assert.equal(evaluateInspection({ ...base, constraints: [] }).clean, false);
  assert.equal(evaluateInspection({ ...base, columns: base.columns.filter((column) => !(column.table_name === "chat_memory_events" && column.column_name === "normalized_operation")) }).clean, false);
  assert.equal(evaluateInspection({ ...base, duplicateActiveDiagnostics: [{ user_id: 1, preset_id: "default", active_count: "2" }] }).clean, false);
  assert.equal(evaluateInspection({ ...base, unsupportedProjectionCheckpoints: [{ user_id: 1, preset_id: "default", projection_key: "recall" }] }).clean, false);
  assert.equal(evaluateInspection({
    ...base,
    columns: base.columns.map((column) => column.table_name === "chat_memory_tasks" && column.column_name === "schema_version"
      ? { ...column, data_type: "integer" }
      : column),
  }).clean, false);
});
