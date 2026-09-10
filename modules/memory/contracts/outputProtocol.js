// Each token identifies an immutable wire/prompt/compiler bundle. Changes to
// that bundle require a new token so persisted retries keep their contract.
const TODO_OUTPUT_PROTOCOL = "todo-v2";
const LEGACY_OUTPUT_PROTOCOL = "legacy-v1";

function resolveOutputProtocol(task = {}) {
  const protocol = task?.outputProtocol ?? LEGACY_OUTPUT_PROTOCOL;
  if (protocol === LEGACY_OUTPUT_PROTOCOL) return protocol;
  if (protocol === TODO_OUTPUT_PROTOCOL && task.proposer === "todoProposer") return protocol;
  throw new Error(`Unsupported Memory output protocol ${protocol} for ${task.proposer}`);
}

function usesTodoV2(task) { return resolveOutputProtocol(task) === TODO_OUTPUT_PROTOCOL; }

module.exports = { TODO_OUTPUT_PROTOCOL, LEGACY_OUTPUT_PROTOCOL, resolveOutputProtocol, usesTodoV2 };
