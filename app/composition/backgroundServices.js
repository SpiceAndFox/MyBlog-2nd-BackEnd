function createBackgroundServices(entries = []) {
  const services = entries.map((entry, index) => {
    if (typeof entry?.start !== "function") {
      throw new Error(`Background service at index ${index} requires start()`);
    }
    return Object.freeze({
      name: String(entry.name || `background-${index + 1}`),
      start: entry.start,
    });
  });
  let stopping = null;
  let started = [];

  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      const failures = [];
      for (const service of [...started].reverse()) {
        try { await service.stop(); }
        catch (error) { failures.push({ name: service.name, error }); }
      }
      started = [];
      if (failures.length) {
        throw new AggregateError(
          failures.map((failure) => failure.error),
          `Failed to stop background services: ${failures.map((failure) => failure.name).join(", ")}`,
        );
      }
    })();
    return stopping;
  }

  async function start() {
    if (started.length) throw new Error("Background services are already started");
    stopping = null;
    try {
      for (const service of services) {
        const stopService = await Promise.resolve(service.start());
        started.push({
          name: service.name,
          stop: typeof stopService === "function" ? stopService : async () => {},
        });
      }
    } catch (error) {
      try { await stop(); }
      catch (stopError) { error.cause = stopError; }
      throw error;
    }
    return stop;
  }

  return Object.freeze({ start, stop });
}

module.exports = { createBackgroundServices };
