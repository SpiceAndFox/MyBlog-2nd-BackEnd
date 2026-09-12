const { abortable } = require("../../../shared/async/abortable");

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function createProviderAdmission({ concurrency, queueMax } = {}) {
  const maxActive = positiveInt(concurrency, "Memory Provider concurrency");
  const maxQueued = positiveInt(queueMax, "Memory Provider queueMax");
  let active = 0;
  const queue = [];

  function drain() {
    while (active < maxActive && queue.length) {
      const entry = queue.shift();
      active += 1;
      Promise.resolve()
        .then(entry.work)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function tryRun(work) {
    if (typeof work !== "function") throw new Error("Memory Provider admission work is required");
    if (active >= maxActive && queue.length >= maxQueued) return null;
    return new Promise((resolve, reject) => {
      queue.push({ work, resolve, reject });
      drain();
    });
  }

  function run(work) {
    const scheduled = tryRun(work);
    if (scheduled) return scheduled;
    return Promise.reject(Object.assign(new Error("Memory Provider queue is full"), { code: "MEMORY_PROVIDER_QUEUE_FULL" }));
  }

  return Object.freeze({
    run,
    tryRun,
    snapshot: () => Object.freeze({ active, queued: queue.length, concurrency: maxActive, queueMax: maxQueued }),
  });
}

function admissionControlledAdapter(adapter, admission) {
  if (!adapter?.propose) throw new Error("Memory Provider adapter is required");
  if (!admission?.run) throw new Error("Memory Provider admission is required");
  return Object.freeze({
    propose(envelope, options) {
      const signal = options?.signal;
      const interrupted = { status: "deferred", reason: "operation_interrupted" };
      if (signal?.aborted) return Promise.resolve(interrupted);
      const scheduled = admission.tryRun(async () => {
        if (!signal) return adapter.propose(envelope, options);
        try { return await abortable(() => adapter.propose(envelope, options), signal); }
        catch (error) { if (signal?.aborted) return interrupted; throw error; }
      });
      if (!scheduled) return Promise.resolve({ status: "deferred", reason: "provider_queue_full" });
      return abortable(() => scheduled, signal).catch(error => {
        if (signal?.aborted) return interrupted;
        throw error;
      });
    },
  });
}

module.exports = { createProviderAdmission, admissionControlledAdapter };
