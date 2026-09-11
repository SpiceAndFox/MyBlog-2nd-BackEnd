function blockingTask(result, targetKey) {
  if (!result || typeof result !== "object") return null;
  const target = result.targetKey || targetKey;
  for (const child of [result.result, result.barrier]) {
    const blocked = blockingTask(child, target);
    if (blocked) return blocked;
  }
  if (result.status === "retry_wait" || (result.status === "error" && result.halted === false)) {
    return { ...result, targetKey: target };
  }
  for (const child of result.results || []) {
    const blocked = blockingTask(child, target);
    if (blocked) return blocked;
  }
  return null;
}

function waitReason(task) {
  const code = task.detail?.code || task.provider?.code;
  if (code === "MEMORY_PROVIDER_TIMEOUT" || code === "ETIMEDOUT") return "请求超时";
  const status = task.detail?.status || task.provider?.status;
  if (status) return `服务请求失败（HTTP ${status}）`;
  const reason = task.reason || task.outcome;
  return ({ provider_queue_full: "请求队列已满", llm_call_failed: "服务请求失败",
    projection_provider_unavailable: "索引服务请求失败" })[reason] || code || reason || "等待重试";
}

function logWait({ event, scope, phase, notBefore, waitCount, result }) {
  const context = `${scope?.userId ?? "?"}/${scope?.presetId ?? "?"} · ${{ memory: "记忆", librarian: "记忆整理", rag: "检索索引" }[phase] || phase}`;
  let line;
  if (event === "memory_progress_resumed") line = `[进度已推进] ${context}`;
  else {
    const task = blockingTask(result) || {};
    const subject = [context, task.targetKey, task.mode === "maintenance" ? "容量维护" : null,
      task.taskId ? `任务 ${task.taskId.slice(0, 8)}` : null].filter(Boolean).join(" · ");
    if (event === "memory_wait_finished") line = `[继续调度] ${subject}`;
    else {
      const deadline = new Date(notBefore);
      const next = Number.isFinite(deadline.getTime()) ? deadline.toLocaleString("zh-CN", { hour12: false }) : "待定";
      line = `[等待 ${waitCount}] ${subject} · ${waitReason(task)} · 下次 ${next}`;
    }
  }
  process.stderr.write(`${line.replace(/[\r\n\t\x1b]/g, " ")}\n`);
}

function createCommandControl() {
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    process.exitCode = 130;
    process.stderr.write("Stopping Memory scheduling; waiting for the current request to finish. Durable progress is preserved.\n");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  return { signal: controller.signal, onWait: logWait, dispose() {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  } };
}

module.exports = { logWait, createCommandControl };
