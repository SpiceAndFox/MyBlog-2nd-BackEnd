const test = require("node:test");
const assert = require("node:assert/strict");
const { createContextCatchup } = require("../../../modules/memory/application/contextCatchup");

function fixture({ statuses = [], privacyPending = false, state = { meta: { sourceGeneration: 2 } }, drain } = {}) {
  const calls = [];
  const signal = new AbortController().signal;
  const request = createContextCatchup({
    repositories: {
      privacy: { async hasIncompleteOperation() { return privacyPending; } },
      runtime: { async getTargetStatuses() { return statuses; } },
      source: { async getBoundary() { return 300; } },
    },
    async ensureState() { return state; },
    runInBackground: work => Promise.resolve().then(work),
    enqueueByKey: (_key, work) => work({ signal }),
    sourceRebuild: Object.fromEntries(["forceDrainTo", "forceDrainTargetsTo"].map(method => [method,
      async (userId, presetId, options) => {
        calls.push({ method, userId, presetId, options });
        return drain ? drain() : { status: "completed" };
      },
    ])),
  });
  return { request, calls, signal };
}

test("ordinary lag catches up without recreating a completed generation's Librarian schedule", async () => {
  const h = fixture({ statuses: [{ source_generation: 1, rebuild_boundary_message_id: 100 },
    { source_generation: 2, rebuild_boundary_message_id: null, status: "healthy" }] });
  await h.request(1, "p");
  assert.deepEqual(h.calls, [{ method: "forceDrainTargetsTo", userId: 1, presetId: "p", options: {
    sourceGeneration: 2, boundaryMessageId: 300, rebuildBoundaryMessageId: null,
    finalizeTargets: false, signal: h.signal,
  } }]);
});

test("catch-up preserves an unfinished rebuild's frozen boundary", async () => {
  const h = fixture({ statuses: [{ source_generation: 2, rebuild_boundary_message_id: 200, status: "retry_wait" }] });
  await h.request(1, "p");
  assert.deepEqual(h.calls, [{ method: "forceDrainTo", userId: 1, presetId: "p", options: {
    sourceGeneration: 2, boundaryMessageId: 200, signal: h.signal,
  } }]);
});

test("waiting chats coalesce catch-up jobs and can resume after a provider retry", async () => {
  const pending = Promise.withResolvers();
  const h = fixture({ drain: () => pending.promise });
  const first = h.request(1, "p");
  assert.equal(h.request(1, "p"), first);
  pending.resolve({ status: "incomplete", reason: "retry_wait" });
  await first;
  assert.equal(h.calls.length, 1);
  const resumed = h.request(1, "p");
  assert.notEqual(resumed, first);
  await resumed;
  assert.equal(h.calls.length, 2);
});

test("catch-up respects privacy cleanup and unavailable authority", async () => {
  for (const options of [{ privacyPending: true }, { state: null }]) {
    const h = fixture(options);
    assert.equal((await h.request(1, "p")).status, "skipped");
    assert.deepEqual(h.calls, []);
  }
});

test("catch-up rejects conflicting frozen boundaries before invoking a provider", async () => {
  const h = fixture({ statuses: [100, 200].map(boundary => ({ source_generation: 2, rebuild_boundary_message_id: boundary })) });
  await assert.rejects(h.request(1, "p"), /inconsistent boundaries/);
  assert.deepEqual(h.calls, []);
});
