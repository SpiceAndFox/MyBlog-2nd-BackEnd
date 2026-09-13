function createChatScopeCoordinator() {
  const lanes = new Map();
  const sendLanes = new Map();
  const cancellable = new Map();

  function normalizeKey(key) {
    const normalized = String(key || "").trim();
    if (!normalized) throw new Error("Scope coordinator key is required");
    return normalized;
  }

  function track(key, controller) {
    if (!controller) return () => {};
    const controllers = cancellable.get(key) || new Set();
    controllers.add(controller);
    cancellable.set(key, controllers);
    return () => {
      controllers.delete(controller);
      if (!controllers.size && cancellable.get(key) === controllers) cancellable.delete(key);
    };
  }

  function enqueue(laneMap, rawKey, work, { cancellable: canCancel = false, signal } = {}) {
    const key = normalizeKey(rawKey);
    if (typeof work !== "function") throw new Error("Scope coordinator work is required");

    const controller = canCancel ? new AbortController() : null;
    const untrack = track(key, controller);
    let unlinkExternal = () => {};
    if (controller && signal) {
      const abortFromExternal = () => controller.abort(signal.reason || new Error("Request cancelled"));
      if (signal.aborted) abortFromExternal();
      else {
        signal.addEventListener("abort", abortFromExternal, { once: true });
        unlinkExternal = () => signal.removeEventListener("abort", abortFromExternal);
      }
    }

    const previous = laneMap.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      if (controller?.signal.aborted) throw controller.signal.reason || new Error("Request cancelled");
      return work({ signal: controller?.signal });
    });
    laneMap.set(key, current);

    const release = () => {
      unlinkExternal();
      untrack();
      if (laneMap.get(key) === current) laneMap.delete(key);
    };
    void current.then(release, release);
    return current;
  }

  function enqueueByKey(key, work, options) { return enqueue(lanes, key, work, options); }
  // Preserve complete-turn order while a send waits for Memory outside the
  // mutation lane. Mutations and recovery can acquire that lane during a wait.
  function enqueueSendByKey(key, work, options) { return enqueue(sendLanes, key, work, options); }

  function cancelByKey(rawKey, reason = new Error("Scope source changed")) {
    const key = normalizeKey(rawKey);
    const controllers = cancellable.get(key);
    if (!controllers) return 0;
    let cancelled = 0;
    for (const controller of controllers) {
      if (controller.signal.aborted) continue;
      controller.abort(reason);
      cancelled += 1;
    }
    return cancelled;
  }

  function cancelAll(reason = new Error("Service is shutting down")) {
    let cancelled = 0;
    for (const controllers of cancellable.values()) {
      for (const controller of controllers) {
        if (controller.signal.aborted) continue;
        controller.abort(reason);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  async function waitForIdle() {
    while (lanes.size || sendLanes.size) await Promise.allSettled([...lanes.values(), ...sendLanes.values()]);
  }

  function buildKey(userId, presetId) {
    const normalizedPresetId = String(presetId || "").trim();
    if (!userId || !normalizedPresetId) throw new Error("Scope userId and presetId are required");
    return `${userId}:${normalizedPresetId}`;
  }

  return Object.freeze({ enqueueByKey, enqueueSendByKey, cancelByKey, cancelAll, waitForIdle, buildKey });
}

module.exports = { createChatScopeCoordinator };
