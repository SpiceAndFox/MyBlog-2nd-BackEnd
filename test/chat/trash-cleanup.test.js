const test = require("node:test");
const assert = require("node:assert/strict");

function replaceModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const events = [];
const chatModel = {};
const memoryRuntime = {};
replaceModule("../../logger", {
  logger: {
    info(event, detail) { events.push(["info", event, detail]); },
    warn(event, detail) { events.push(["warn", event, detail]); },
    error(event, detail) { events.push(["error", event, detail]); },
  },
});
replaceModule("../../models/chatModel", chatModel);
replaceModule("../../services/chat/memoryRuntime", memoryRuntime);
const {
  purgeExpiredTrashedSessions,
  startChatTrashCleanup,
} = require("../../services/chat/trashCleanup");

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for background cleanup");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("trash cleanup groups raw deletes by Memory scope and uses the injected transaction client", async () => {
  chatModel.listTrashedSessionPurgeCandidates = async () => [
    { id: 1, userId: 7, presetId: "a" },
    { id: 2, userId: 7, presetId: "a" },
    { id: 3, userId: 7, presetId: "b" },
  ];
  const deletes = [];
  chatModel.purgeTrashedSessionIds = async (userId, presetId, ids, { client }) => {
    deletes.push({ userId, presetId, ids, client });
    return ids.length;
  };
  memoryRuntime.privacyHardDelete = async (userId, presetId, { deleteRawSource }) => {
    const client = { scope: `${userId}:${presetId}` };
    return { mutationResult: await deleteRawSource(client) };
  };

  const result = await purgeExpiredTrashedSessions({
    now: new Date("2026-07-22T00:00:00.000Z"),
    retentionDays: 30,
    batchSize: 10,
  });
  assert.equal(result.purged, 3);
  assert.equal(result.cutoff.toISOString(), "2026-06-22T00:00:00.000Z");
  assert.deepEqual(deletes, [
    { userId: 7, presetId: "a", ids: [1, 2], client: { scope: "7:a" } },
    { userId: 7, presetId: "b", ids: [3], client: { scope: "7:b" } },
  ]);
});

test("trash cleanup starts immediately, never overlaps ticks, and drains its active tick on stop", async () => {
  let calls = 0;
  let releaseActiveTick;
  const activeTickGate = new Promise((resolve) => { releaseActiveTick = resolve; });
  chatModel.listTrashedSessionPurgeCandidates = async () => [{ id: 4, userId: 8, presetId: "c" }];
  chatModel.purgeTrashedSessionIds = async () => 1;
  memoryRuntime.privacyHardDelete = async (_userId, _presetId, { deleteRawSource }) => {
    calls += 1;
    await activeTickGate;
    return { mutationResult: await deleteRawSource({ transaction: true }) };
  };

  const stop = startChatTrashCleanup({ retentionDays: 30, intervalMs: 5, batchSize: 10 });
  await waitFor(() => calls === 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1, "an interval tick overlapped the active cleanup");

  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "stop returned before the active cleanup drained");
  releaseActiveTick();
  await stopping;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 1, "cleanup ran again after stop");
});
