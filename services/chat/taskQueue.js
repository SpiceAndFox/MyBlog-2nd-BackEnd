function createSemaphore(limit) {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  let active = 0;
  const waiters = [];

  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  }

  async function acquire() {
    if (active < normalizedLimit) {
      active += 1;
      return release;
    }

    await new Promise((resolve) => waiters.push(resolve));
    active += 1;
    return release;
  }

  return { acquire };
}

function createKeyedTaskQueue() {
  const keyLocks = new Map();

  function enqueue(key, task) {
    const tail = keyLocks.get(key) || Promise.resolve();

    const run = tail
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (keyLocks.get(key) === run) keyLocks.delete(key);
      });

    keyLocks.set(key, run);
    return run;
  }

  return { enqueue };
}

module.exports = {
  createSemaphore,
  createKeyedTaskQueue,
};

