// Memory jobs serialize with each other, but never occupy the chat send lane.
// A mutation reserves both lanes synchronously and drains cancelled Memory work
// before changing source data. No old task callback can outlive that barrier.
function createMemoryWorkCoordinator({ enqueueMutation = (_key, work) => work() } = {}) {
  const lanes = new Map();
  const controllers = new Map();
  let stopped = false;
  const interrupted = () => ({ status: "interrupted", reason: "cancelled" });

  function remember(key, promise) {
    lanes.set(key, promise);
    const release = () => { if (lanes.get(key) === promise) lanes.delete(key); };
    void promise.then(release, release);
    return promise;
  }

  function cancel(key) {
    for (const controller of controllers.get(key) || []) {
      controller.abort(Object.assign(new Error("Memory work superseded"), { code: "MEMORY_WORK_INTERRUPTED" }));
    }
  }

  function enqueue(key, work) {
    if (stopped) return Promise.resolve(interrupted());
    const controller = new AbortController();
    const entries = controllers.get(key) || new Set();
    entries.add(controller);
    controllers.set(key, entries);
    const previous = lanes.get(key) || Promise.resolve();
    const promise = previous.catch(() => {}).then(() => controller.signal.aborted
      ? interrupted() : work({ signal: controller.signal }));
    const release = () => {
      entries.delete(controller);
      if (!entries.size && controllers.get(key) === entries) controllers.delete(key);
    };
    void promise.then(release, release);
    return remember(key, promise);
  }

  function mutate(key, work) {
    if (stopped) return Promise.reject(Object.assign(new Error("Memory runtime is shutting down"), {
      code: "MEMORY_RUNTIME_SHUTTING_DOWN", status: 503,
    }));
    cancel(key);
    const previous = lanes.get(key) || Promise.resolve();
    // Reserve the chat lane now, before awaiting the old Memory job.
    return remember(key, Promise.resolve(enqueueMutation(key, async () => {
      await previous.catch(() => {});
      return work();
    })));
  }

  async function shutdown() {
    stopped = true;
    for (const key of controllers.keys()) cancel(key);
    while (lanes.size) await Promise.allSettled([...lanes.values()]);
  }

  return Object.freeze({ enqueue, mutate, shutdown });
}

module.exports = { createMemoryWorkCoordinator };
