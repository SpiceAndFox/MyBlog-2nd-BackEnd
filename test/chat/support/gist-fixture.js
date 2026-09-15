const { hashGistContent, gistSourceFingerprint } = require("../../../modules/chat/domain/gistSource");

function createGistFixture() {
  const tasks = new Map();
  const sources = new Map();
  const stored = new Map();
  let clock = 0;
  let token = 0;
  function addSource(messageId, content = "assistant source", userContent = "user source") {
    const source = { userId: 7, presetId: "companion", messageId, content, userContent, userMessageId: messageId - 1 };
    sources.set(messageId, { ...source, contentHash: hashGistContent(content), sourceHash: gistSourceFingerprint(source) });
  }
  const repository = {
    async getGistTask({ messageId }) { return tasks.get(Number(messageId)) || null; },
    async enqueueGistTask({ messageId, userId, presetId }, { force } = {}) {
      messageId = Number(messageId);
      const source = sources.get(messageId);
      if (!source) return null;
      if (!force && stored.get(messageId)?.sourceHash === source.sourceHash) return { status: "succeeded" };
      const old = tasks.get(messageId);
      if (old && old.source_hash === source.sourceHash && !["cancelled", "succeeded"].includes(old.status) && !(force && old.status === "failed")) return old;
      const task = { message_id: messageId, user_id: userId, preset_id: presetId, source_hash: source.sourceHash,
        content_hash: source.contentHash, status: "queued", attempt: 0 };
      tasks.set(messageId, task); return task;
    },
    async claimGistTask({ messageId = null, leaseMs }) {
      const task = [...tasks.values()].find(row => (messageId === null || Number(messageId) === row.message_id)
        && (["queued", "retry_wait"].includes(row.status) && (!row.nextRetryAt || Date.parse(row.nextRetryAt) <= clock)
          || row.status === "running" && row.leaseUntil <= clock));
      if (!task) return null;
      Object.assign(task, { status: "running", attempt: task.attempt + 1, run_token: ++token, leaseUntil: clock + leaseMs });
      return { ...task };
    },
    async getGistSource(task) { return sources.get(Number(task.message_id ?? task.messageId)) || null; },
    async finishGistTask(task, outcome) {
      const row = tasks.get(task.message_id);
      if (!row || row.run_token !== task.run_token) return { status: "stale" };
      if (sources.get(task.message_id)?.sourceHash !== task.source_hash) outcome = { status: "cancelled" };
      if (outcome.result) {
        stored.set(task.message_id, { ...outcome.result, sourceHash: task.source_hash });
        outcome = { status: "succeeded" };
      }
      Object.assign(row, outcome, { run_token: null });
      return outcome;
    },
  };
  return { repository, tasks, sources, stored, addSource, advance: ms => { clock += ms; }, now: () => clock };
}

module.exports = { createGistFixture };
