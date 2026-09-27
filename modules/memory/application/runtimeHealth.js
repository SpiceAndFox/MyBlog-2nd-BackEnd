const { TARGET_LABELS } = require("../domain/health");
const { TARGET_KEYS } = require("../contracts");
const { selectRecentWindow, buildGapBridgeCoverage, assessContextCoverage } = require("../domain/contextCoverage");

function rowValue(row, snake, camel) {
  return row?.[snake] ?? row?.[camel];
}

function publicTargetHealth(state, targetKey, row) {
  const boundary = rowValue(row, "rebuild_boundary_message_id", "rebuildBoundaryMessageId");
  const internalStatus = row?.status || "missing";
  return {
    targetKey,
    status: internalStatus === "halted" ? "needs_attention"
      : boundary !== null && boundary !== undefined ? "rebuilding"
      : internalStatus === "healthy" ? "healthy" : "degraded",
    processedMessageId: Number(state.meta.targetCursors[targetKey] ?? 0),
    rebuildBoundaryMessageId: boundary ?? null,
  };
}

function targetAlert(targetKey, row) {
  const label = TARGET_LABELS[targetKey] || targetKey;
  const boundary = rowValue(row, "rebuild_boundary_message_id", "rebuildBoundaryMessageId");
  if (boundary !== null && boundary !== undefined) {
    return {
      subjectKind: "target",
      subjectKey: targetKey,
      status: row?.status === "halted" ? "degraded" : "rebuilding",
      message: row?.status === "halted"
        ? `${label}记忆重建已暂停，需要手动重试`
        : `${label}记忆正在后台更新`,
    };
  }
  if (row?.status === "healthy") return null;
  return {
    subjectKind: "target",
    subjectKey: targetKey,
    status: "degraded",
    message: row?.status === "halted" ? `${label}记忆更新已暂停，需要手动重试` : `${label}记忆可能滞后`,
  };
}

function createMemoryRuntimeHealth({
  config,
  recentWindowMaxChars,
  repositories,
  providerHealth,
  resetRetryBudget,
  reconcileRebuilds,
  recovery,
} = {}) {
  if (!config?.targets || !repositories?.state || !repositories?.runtime) {
    throw new Error("Memory runtime health dependencies are required");
  }
  if (!providerHealth?.snapshot) {
    throw new Error("Memory runtime provider health is required");
  }
  if (typeof reconcileRebuilds !== "function" || typeof recovery?.resumeTarget !== "function") {
    throw new Error("Memory runtime health recovery dependencies are required");
  }

  async function getHealthSnapshot({ userId, presetId } = {}) {
    const provider = providerHealth.snapshot();
    const normalizedUserId = Number(userId);
    const normalizedPresetId = String(presetId || "").trim();
    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0 || !normalizedPresetId) {
      return { provider, scope: null };
    }
    try {
      const state = await repositories.state.getState(normalizedUserId, normalizedPresetId);
      if (!state) {
        return {
          provider,
          scope: {
            status: "unavailable",
            usable: false,
            sourceGeneration: null,
            alerts: [{
              subjectKind: "system",
              subjectKey: "memory_state",
              status: "unavailable",
              message: "长期记忆状态尚未初始化",
            }],
          },
        };
      }
      const targetStatuses = await repositories.runtime.getTargetStatuses(normalizedUserId, normalizedPresetId);
      // Use the same raw-history coverage rules as contextAssembly/sendMessage.
      // A valid state JSON or a running rebuild does not establish chat readiness.
      const messages = await repositories.source.listUpTo(normalizedUserId, normalizedPresetId);
      const recent = selectRecentWindow(messages, recentWindowMaxChars);
      const gapBridge = recent.needsMemory
        ? buildGapBridgeCoverage({ messages, state, recentWindowStartMessageId: recent.messages[0]?.id,
            maxRawChars: config.gapBridge.maxRawChars, retainedMessages: config.gapBridge.retainedMessages })
        : { diagnostics: [] };
      const coverage = assessContextCoverage({ needsMemory: recent.needsMemory, gapBridge });
      const rebuilding = targetStatuses.some(row => rowValue(row, "rebuild_boundary_message_id", "rebuildBoundaryMessageId") != null);
      const paused = targetStatuses.some(row => row.status === "halted");
      const boundary = rebuilding
        ? Math.max(...targetStatuses.map(row => Number(rowValue(row, "rebuild_boundary_message_id", "rebuildBoundaryMessageId") ?? 0)))
        : Number(messages.at(-1)?.id ?? 0);
      const progressMessages = messages.filter(message => message.id <= boundary);
      const processedMessages = Math.min(...TARGET_KEYS.map(key =>
        progressMessages.filter(message => message.id <= Number(state.meta.targetCursors[key] ?? 0)).length));
      const progress = { processedMessages, totalMessages: progressMessages.length,
        remainingMessages: progressMessages.length - processedMessages };
      const targets = [];
      const alerts = [];
      let status = "healthy";
      for (const targetKey of Object.keys(config.targets)) {
        const row = targetStatuses.find((entry) => rowValue(entry, "target_key", "targetKey") === targetKey);
        const alert = targetAlert(targetKey, row);
        targets.push(publicTargetHealth(state, targetKey, row));
        if (!alert) continue;
        alerts.push(alert);
        if (alert.status !== "rebuilding") status = "degraded";
        else if (status === "healthy") status = "rebuilding";
      }
      if (!coverage.complete) {
        status = paused ? "degraded" : "rebuilding";
        alerts.unshift({ subjectKind: "system", subjectKey: "memory_coverage",
          status, chatBlocked: true,
          message: paused ? "记忆补齐已暂停，暂时无法继续对话，请重试长期记忆"
            : rebuilding ? "记忆正在重建，历史上下文尚未恢复，暂时无法继续对话"
              : "记忆正在补齐历史上下文，暂时无法继续对话",
        });
      }
      if (provider.status === "degraded") {
        status = "degraded";
        alerts.push({
          subjectKind: "provider",
          subjectKey: "memory",
          status: provider.status,
          message: coverage.complete ? "最近一次记忆服务请求失败，已保存的记忆仍可使用"
            : "最近一次记忆服务请求失败，历史上下文尚未补齐",
        });
      }
      return {
        provider,
        scope: {
          status,
          usable: coverage.complete,
          chatBlocked: !coverage.complete,
          availability: coverage.complete ? "ready" : rebuilding ? "rebuilding" : "catching_up",
          progress,
          coverage,
          sourceGeneration: state.meta.sourceGeneration,
          targets,
          alerts,
        },
      };
    } catch {
      return {
        provider,
        scope: {
          status: "unavailable",
          usable: false,
          chatBlocked: null,
          sourceGeneration: null,
          alerts: [{
            subjectKind: "system",
            subjectKey: "memory_state",
            status: "unavailable",
            message: "长期记忆状态无法验证，当前不会使用该记忆",
          }],
        },
      };
    }
  }

  async function retryProviderNow({ userId, presetId } = {}) {
    const provider = providerHealth.snapshot();
    const normalizedUserId = Number(userId);
    const normalizedPresetId = String(presetId || "").trim();
    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0 || !normalizedPresetId) {
      return { provider, attempted: false };
    }
    resetRetryBudget?.(normalizedUserId, normalizedPresetId);
    const rebuilds = await reconcileRebuilds({
      resumeHalted: true,
      selectedScope: { userId: normalizedUserId, presetId: normalizedPresetId },
    });
    const scopeKey = `${normalizedUserId}:${normalizedPresetId}`;
    if (rebuilds[scopeKey] && rebuilds[scopeKey].status !== "skipped") {
      return { provider: providerHealth.snapshot(), attempted: true, rebuild: rebuilds[scopeKey] };
    }
    const statuses = await repositories.runtime.getTargetStatuses(normalizedUserId, normalizedPresetId);
    const halted = statuses.filter((row) => row.status === "halted");
    const resumed = [];
    for (const row of halted) {
      resumed.push(await recovery.resumeTarget(
        normalizedUserId,
        normalizedPresetId,
        rowValue(row, "target_key", "targetKey"),
        { run: true },
      ));
    }
    return {
      provider: providerHealth.snapshot(),
      attempted: resumed.length > 0,
      resumed,
    };
  }

  return Object.freeze({ getHealthSnapshot, retryProviderNow });
}

module.exports = {
  createMemoryRuntimeHealth,
  publicTargetHealth,
  targetAlert,
};
