function rowValue(row, snake, camel) {
  return row?.[snake] ?? row?.[camel];
}

function publicTargetHealth(state, targetKey, row) {
  const boundary = rowValue(row, "rebuild_boundary_message_id", "rebuildBoundaryMessageId");
  const internalStatus = row?.status || "missing";
  return {
    targetKey,
    status: boundary !== null && boundary !== undefined
      ? internalStatus === "halted" ? "needs_attention" : "rebuilding"
      : internalStatus === "healthy" ? "healthy" : "degraded",
    processedMessageId: Number(state.meta.targetCursors[targetKey] ?? 0),
    rebuildBoundaryMessageId: boundary ?? null,
  };
}

function targetAlert(targetKey, row) {
  const boundary = rowValue(row, "rebuild_boundary_message_id", "rebuildBoundaryMessageId");
  if (boundary !== null && boundary !== undefined) {
    return {
      subjectKind: "target",
      subjectKey: targetKey,
      status: row?.status === "halted" ? "degraded" : "rebuilding",
      message: row?.status === "halted"
        ? `${targetKey} 记忆重建已暂停，需要手动重试`
        : `${targetKey} 记忆正在从已保存进度继续重建`,
    };
  }
  if (row?.status === "healthy") return null;
  return {
    subjectKind: "target",
    subjectKey: targetKey,
    status: "degraded",
    message: `${targetKey} 记忆可能滞后`,
  };
}

function createMemoryRuntimeHealth({
  config,
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
      const targets = [];
      const alerts = [];
      let status = "healthy";
      for (const targetKey of Object.keys(config.targets)) {
        const row = targetStatuses.find((entry) => rowValue(entry, "target_key", "targetKey") === targetKey);
        const alert = targetAlert(targetKey, row);
        targets.push(publicTargetHealth(state, targetKey, row));
        if (!alert) continue;
        alerts.push(alert);
        if (alert.status === "rebuilding") status = "rebuilding";
        else if (status === "healthy") status = "degraded";
      }
      if (provider.status === "degraded") {
        if (status === "healthy") status = "degraded";
        alerts.push({
          subjectKind: "provider",
          subjectKey: "memory",
          status: provider.status,
          message: "最近一次记忆服务请求失败，已保存的记忆仍可使用",
        });
      }
      return {
        provider,
        scope: {
          status,
          usable: true,
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
