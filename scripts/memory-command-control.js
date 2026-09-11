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

function logWait({ event, scope, phase, notBefore, waitCount, result, pid = process.pid, write = text => process.stderr.write(text) }) {
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
  write(`[PID ${pid}] ${line.replace(/[\r\n\t\x1b]/g, " ")}\n`);
}

function isInterrupted(value) {
  return value?.status === "interrupted"
    || value?.migrationDetail?.status === "interrupted"
    || value?.librarianResult?.status === "interrupted"
    || value?.error?.detail?.status === "interrupted";
}

function createCommandControl({ name = "Memory", runtime = process,
  write = text => runtime.stderr.write(text),
  writeExit = text => require("node:fs").writeSync(2, text),
} = {}) {
  const controller = new AbortController();
  let closed = false;
  let failed = false;
  const log = message => write(`[PID ${runtime.pid}] ${message}\n`);
  const interrupt = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (!failed) runtime.exitCode = 130;
    log("[正在停止] 等待当前请求和收尾完成；请等本进程显示“已退出”后再重跑。");
  };
  const onExit = code => {
    const message = !closed ? "未完成正常收尾，请检查已保存的任务状态。"
      : failed || (code !== 0 && !controller.signal.aborted) ? "执行或收尾失败，请查看上方错误。"
      : controller.signal.aborted ? "已停止，已保存进度保留，可重新执行命令。" : "命令已结束。";
    writeExit(`[PID ${runtime.pid}] [已退出 ${code}] ${message}\n`);
  };
  // Keep handlers installed during cleanup, including a repeated Ctrl+C.
  runtime.on("SIGINT", interrupt);
  runtime.on("SIGTERM", interrupt);
  runtime.once("exit", onExit);
  log(`[已启动] ${name}`);
  const reportError = error => {
    failed = true;
    runtime.exitCode = 1;
    const detail = error?.migrationDetail || error?.librarianResult;
    const lines = [error?.stack || String(error)];
    if (detail) lines.push(JSON.stringify(error.migrationDetail || require("../modules/memory/admin").summarizeOperation(detail), null, 2));
    for (const line of lines.join("\n").split(/\r?\n/)) log(line);
  };
  return {
    signal: controller.signal,
    onWait: event => {
      if (!controller.signal.aborted) logWait({ ...event, pid: runtime.pid, write });
    },
    async run(work, close) {
      try {
        const result = await work();
        if (controller.signal.aborted && isInterrupted(result)) runtime.exitCode = 130;
        else if (["failed", "evidence_incomplete"].includes(result?.status)) {
          failed = true;
          if (!runtime.exitCode || runtime.exitCode === 130) runtime.exitCode = 2;
        }
      } catch (error) {
        if (controller.signal.aborted && (isInterrupted(error) || error?.code === "ABORT_ERR")) runtime.exitCode = 130;
        else reportError(error);
      } finally {
        try { await close(); closed = true; }
        catch (error) { reportError(error); }
        if (controller.signal.aborted && !failed) runtime.exitCode = 130;
      }
    },
    dispose() {
      runtime.removeListener("SIGINT", interrupt);
      runtime.removeListener("SIGTERM", interrupt);
      runtime.removeListener("exit", onExit);
    },
  };
}

module.exports = { logWait, createCommandControl, isInterrupted };
