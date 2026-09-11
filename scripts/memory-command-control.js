function logWait({ event, scope, phase, notBefore, waitCount, totalWaitCount, result }) {
  const { summarizeOperation } = require("../modules/memory/admin");
  process.stderr.write(`${JSON.stringify({ event, scope, phase, notBefore, waitCount, totalWaitCount,
    operation: summarizeOperation(result) })}\n`);
}

function createCommandControl() {
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    process.exitCode = 130;
    process.stderr.write("Stopping Memory scheduling; waiting for the current request to finish. Durable progress is preserved.\n");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  return { signal: controller.signal, onWait: logWait, dispose() {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  } };
}

module.exports = { logWait, createCommandControl };
