const { TARGET_KEYS } = require("../contracts/constants");

const TARGET_LABELS = Object.freeze({ scene: "当前状态", todos: "待办", standingAgreements: "持续约定", episodes: "经历与里程碑", profileRelationship: "人物与关系", worldFacts: "长期事实" });

function rowValue(row, camel, snake = camel) { return row?.[camel] ?? row?.[snake]; }

function aggregateMemoryHealth({ targetStatuses = [], diagnostics = [], projectionHealth = [], now = new Date(), alertDebounceMs = 0 } = {}) {
  const alerts = [];
  let status = "healthy";
  const byTarget = new Map(targetStatuses.map((row) => [rowValue(row, "targetKey", "target_key"), row]));
  const currentTimestamp = new Date(now).getTime();
  const debounced = (row) => {
    if (!(alertDebounceMs > 0)) return false;
    const changedAt = rowValue(row, "createdAt", "created_at") ?? rowValue(row, "updatedAt", "updated_at");
    return changedAt && currentTimestamp - new Date(changedAt).getTime() < alertDebounceMs;
  };
  for (const targetKey of TARGET_KEYS) {
    const row = byTarget.get(targetKey);
    if (!row) {
      if (status === "healthy") status = "degraded";
      alerts.push({ subjectKind: "target", subjectKey: targetKey, status: "degraded", message: `${TARGET_LABELS[targetKey]}记忆健康状态不可用` });
      continue;
    }
    const hasRebuildBoundary = rowValue(row, "rebuildBoundaryMessageId", "rebuild_boundary_message_id") !== null && rowValue(row, "rebuildBoundaryMessageId", "rebuild_boundary_message_id") !== undefined;
    const internal = hasRebuildBoundary ? "rebuilding" : rowValue(row, "status");
    if (internal === "healthy") continue;
    if (debounced(row)) continue;
    const rebuilding = internal === "rebuilding";
    status = rebuilding ? "rebuilding" : status === "healthy" ? "degraded" : status;
    alerts.push({ subjectKind: "target", subjectKey: targetKey, status: rebuilding ? "rebuilding" : "degraded", message: rebuilding ? `${TARGET_LABELS[targetKey]}记忆正在重建` : `${TARGET_LABELS[targetKey]}记忆可能滞后${internal === "halted" ? "，需要服务器维护" : ""}` });
  }
  const queryProjectionKeys = new Set(projectionHealth.filter(Boolean).map((row) => row.projectionKey));
  for (const diagnostic of diagnostics.filter((row) => rowValue(row, "resolved") !== true)) {
    if (debounced(diagnostic)) continue;
    const kind = rowValue(diagnostic, "subjectKind", "subject_kind");
    const key = rowValue(diagnostic, "subjectKey", "subject_key");
    if (kind === "projection" && queryProjectionKeys.has(key)) continue;
    const rebuilding = rowValue(diagnostic, "healthStatus", "health_status") === "rebuilding";
    if (rebuilding) status = "rebuilding";
    else if (status === "healthy") status = "degraded";
    alerts.push({ subjectKind: kind, subjectKey: key, status: rebuilding ? "rebuilding" : "degraded", message: rebuilding ? `${key} 上下文正在重建` : kind === "target" ? `${TARGET_LABELS[key] || key}：部分早期对话未在上下文中` : `${key}：部分早期对话未在上下文中` });
  }
  for (const projection of projectionHealth) {
    if (!projection || projection.queryHealth === "healthy") continue;
    if (projection.queryHealth === "rebuilding") status = "rebuilding";
    else if (status === "healthy") status = "degraded";
    alerts.push({ subjectKind: "projection", subjectKey: projection.projectionKey, status: projection.queryHealth, message: projection.queryHealth === "rebuilding" ? `${projection.projectionKey} 上下文正在重建` : `${projection.projectionKey}：部分早期对话未在上下文中` });
  }
  return { status, alerts, chatBlocked: false };
}

module.exports = { aggregateMemoryHealth, TARGET_LABELS };
