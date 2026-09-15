const { gistRetryDecision } = require("./gistRetryPolicy");

function createGistWorker({ config, repository, generate, logger, now = Date.now }) {
  for (const field of ["workerConcurrency", "workerTimeoutMs", "pollIntervalMs", "leaseGraceMs"]) {
    if (!Number.isSafeInteger(config?.[field]) || config[field] <= 0) throw new Error(`Gist config.${field} must be a positive safe integer`);
  }
  const retryConfig = config.retry;
  if (!Number.isSafeInteger(retryConfig?.retryMax) || retryConfig.retryMax < 0) throw new Error("Gist config.retry.retryMax must be a non-negative safe integer");
  for (const field of ["backoffBaseMs", "backoffMaxMs"]) {
    if (!Number.isSafeInteger(retryConfig[field]) || retryConfig[field] <= 0) throw new Error(`Gist config.retry.${field} must be a positive safe integer`);
  }
  const leaseMs = config.workerTimeoutMs + config.leaseGraceMs;
  if (!Number.isSafeInteger(leaseMs)) throw new Error("Gist lease duration must be a safe integer");
  const active = new Set();
  const pending = new Set();
  const controllers = new Set();
  let claiming = false;
  let stopped = false;
  let timer = null;

  function track(work) {
    pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }

  async function execute(task) {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const source = await repository.getGistSource(task);
      if (!source || source.sourceHash !== task.source_hash) {
        return await repository.finishGistTask(task, { status: "cancelled", reason: "source_changed" });
      }
      // Expired leases also consume the durable budget, so crashes cannot mint retries.
      if (task.attempt > retryConfig.retryMax + 1) {
        return await repository.finishGistTask(task, { status: "failed", reason: "retry_budget_exhausted" });
      }
      if (controller.signal.aborted || stopped) throw new Error("Gist worker stopped");
      const result = await generate({ ...source, signal: controller.signal });
      return await repository.finishGistTask(task, { result });
    } catch (error) {
      // Shutdown keeps the leased task recoverable without extending its budget.
      const decision = stopped ? { status: "retry_wait", nextRetryAt: null, reason: "worker_stopped" }
        : gistRetryDecision(error, Number(task.attempt), retryConfig, now());
      const outcome = await repository.finishGistTask(task, decision);
      logger.error("chat_message_gist_generate_failed", { userId: task.user_id, presetId: task.preset_id,
        messageId: task.message_id, attempt: task.attempt, ...decision });
      return outcome;
    } finally { controllers.delete(controller); }
  }

  async function pollOnce({ messageId = null } = {}) {
    if (stopped || !config.enabled || claiming) return;
    claiming = true;
    const launched = [];
    try {
      while (!stopped && active.size < config.workerConcurrency) {
        const task = await repository.claimGistTask({ messageId, leaseMs });
        if (!task) break;
        const work = execute(task).catch(error => logger.error("chat_gist_worker_failed", { error }));
        active.add(work);
        work.finally(() => active.delete(work));
        launched.push(work);
        if (messageId !== null) break;
      }
    } finally { claiming = false; }
    await Promise.all(launched);
  }

  function poll(options) { return track(pollOnce(options)); }

  function requestGeneration({ userId, presetId, messageId, force = false } = {}) {
    if (!config.enabled || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0
      || !String(presetId || "").trim() || !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0 || stopped) return Promise.resolve(null);
    return track(repository.enqueueGistTask({ userId, presetId, messageId }, { force }).then(async task => {
      if (task && task.status !== "succeeded") await poll({ messageId });
      return task?.status === "succeeded" ? task : await repository.getGistTask({ userId, presetId, messageId });
    }).catch(error => {
      logger.error("chat_gist_enqueue_failed", { error, userId, presetId, messageId });
      return { status: "enqueue_failed" };
    }));
  }

  function start() {
    if (timer) return stop;
    stopped = false;
    if (!config.enabled) return stop;
    const tick = () => { void poll().catch(error => logger.error("chat_gist_poll_failed", { error })); };
    timer = setInterval(tick, config.pollIntervalMs);
    timer.unref?.();
    tick();
    return stop;
  }

  async function stop() {
    stopped = true;
    clearInterval(timer); timer = null;
    for (const controller of controllers) controller.abort(new Error("Gist worker stopped"));
    await Promise.allSettled([...pending, ...active]);
  }
  return { requestGeneration, poll, start, stop };
}

module.exports = { createGistWorker };
