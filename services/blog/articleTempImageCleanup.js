const fs = require("node:fs");
const path = require("node:path");

const defaultTempDirectory = path.join(__dirname, "..", "..", "uploads", "articles", "content", "tmp");

function createArticleTempImageCleanup({ logger, ttlMs, intervalMs, tempDirectory = defaultTempDirectory } = {}) {
  if (!logger?.warn) throw new Error("Article temp cleanup logger is required");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error(`Invalid article cleanup ttlMs. Got: ${String(ttlMs)}`);
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(`Invalid article cleanup intervalMs. Got: ${String(intervalMs)}`);
  }

  async function cleanup() {
    await fs.promises.mkdir(tempDirectory, { recursive: true });
    const now = Date.now();
    let files;
    try { files = await fs.promises.readdir(tempDirectory); }
    catch (error) {
      logger.warn("article_temp_cleanup_read_failed", { error });
      return { removed: 0 };
    }

    let removed = 0;
    await Promise.all(files.map(async (file) => {
      const fullPath = path.join(tempDirectory, file);
      try {
        const stats = await fs.promises.stat(fullPath);
        if (now - stats.mtimeMs <= ttlMs) return;
        await fs.promises.unlink(fullPath);
        removed += 1;
      } catch { /* best-effort cleanup */ }
    }));
    return { removed };
  }

  function start() {
    let activeTick = cleanup();
    void activeTick.finally(() => { activeTick = null; });
    const timer = setInterval(() => {
      if (activeTick) return;
      activeTick = cleanup();
      void activeTick.finally(() => { activeTick = null; });
    }, intervalMs);
    timer.unref?.();

    return async () => {
      clearInterval(timer);
      if (activeTick) await activeTick;
    };
  }

  return Object.freeze({ cleanup, start });
}

module.exports = { createArticleTempImageCleanup };
