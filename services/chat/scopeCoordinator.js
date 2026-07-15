function createScopeCoordinator() {
  const lanes = new Map();
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

  function enqueueByKey(rawKey, work, { cancellable: canCancel = false, signal } = {}) {
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

    const previous = lanes.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      if (controller?.signal.aborted) throw controller.signal.reason || new Error("Request cancelled");
      return work({ signal: controller?.signal });
    });
    lanes.set(key, current);

    const release = () => {
      unlinkExternal();
      untrack();
      if (lanes.get(key) === current) lanes.delete(key);
    };
    void current.then(release, release);
    return current;
  }

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

  function buildKey(userId, presetId) {
    const normalizedPresetId = String(presetId || "").trim();
    if (!userId || !normalizedPresetId) throw new Error("Scope userId and presetId are required");
    return `${userId}:${normalizedPresetId}`;
  }

  return Object.freeze({ enqueueByKey, cancelByKey, buildKey });
}

module.exports = Object.freeze({ ...createScopeCoordinator(), createScopeCoordinator });
