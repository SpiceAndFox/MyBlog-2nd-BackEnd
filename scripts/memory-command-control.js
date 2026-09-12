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

function logWait({ event, scope, phase, notBefore, waitCount, result, write = text => process.stderr.write(text) }) {
  const context = `${scope?.userId ?? "?"}/${scope?.presetId ?? "?"} · ${{ memory: "记忆", librarian: "记忆整理" }[phase] || phase}`;
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
  write(`${line.replace(/[\r\n\t\x1b]/g, " ")}\n`);
}

function isInterrupted(value) {
  return value?.status === "interrupted"
    || value?.migrationDetail?.status === "interrupted"
    || value?.librarianResult?.status === "interrupted"
    || value?.error?.detail?.status === "interrupted";
}

function createCommandControl({ runtime = process, write = text => runtime.stderr.write(text) } = {}) {
  const controller = new AbortController();
  // The user requested immediate termination, not an asynchronous shutdown.
  // Closing the process also closes its database sockets; uncommitted transactions roll back.
  const interrupt = () => { controller.abort(); runtime.exit(130); };
  runtime.on("SIGINT", interrupt);
  runtime.on("SIGTERM", interrupt);
  const reportError = error => {
    runtime.exitCode = 1;
    const detail = error?.migrationDetail || error?.librarianResult;
    write(String(error?.stack || error) + "\n");
    if (detail) write(JSON.stringify(error.migrationDetail || require("../modules/memory/admin").summarizeOperation(detail), null, 2) + "\n");
  };
  return {
    signal: controller.signal,
    onWait: event => { if (!controller.signal.aborted) logWait({ ...event, write }); },
    async run(work, close) {
      try {
        const result = await work();
        if (["failed", "evidence_incomplete"].includes(result?.status) && !runtime.exitCode) runtime.exitCode = 2;
      } catch (error) { reportError(error); }
      finally {
        try { await close(); } catch (error) { reportError(error); }
      }
    },
    dispose() {
      runtime.removeListener("SIGINT", interrupt);
      runtime.removeListener("SIGTERM", interrupt);
    },
  };
}

module.exports = { logWait, createCommandControl, isInterrupted };
