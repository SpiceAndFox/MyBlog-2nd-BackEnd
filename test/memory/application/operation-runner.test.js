const test = require("node:test");
const assert = require("node:assert/strict");
const { createOperationRunner, operationWait, summarizeOperation } = require("../../../modules/memory/application/operationRunner");

function clock() {
  let time = Date.parse("2026-09-11T00:00:00Z");
  return { now: () => time, advance(ms) { time += ms; }, iso(ms = 0) { return new Date(time + ms).toISOString(); } };
}

test("foreground runner honors the latest blocking wave deadline without duplicate dispatch", async () => {
  const time = clock(); let calls = 0;
  const runner = createOperationRunner({ now: time.now, sleepUntilNext: async ms => { assert.equal(calls, 1); time.advance(ms); } });
  const start = time.now();
  const result = await runner.run({ step: async () => {
    if (++calls === 2) { assert.equal(time.now() - start, 60_000); return { status: "completed" }; }
    return { status: "incomplete", result: { status: "error", halted: false, notBefore: time.iso(30_000) },
      results: [{ status: "prepared" }, { status: "retry_wait", notBefore: time.iso(60_000) }] };
  } });
  assert.equal(result.status, "completed"); assert.equal(calls, 2);
});

test("final Librarian nested result is waitable but a halted sibling always stops the runner", async () => {
  const time = clock();
  assert.equal(operationWait({ status: "retry_wait", notBefore: new Date(time.iso(1234)) }).notBefore, time.iso(1234));
  const waiting = { status: "retry_wait", notBefore: time.iso(30_000) };
  assert.ok(operationWait({ status: "incomplete", result: { status: "incomplete", results: [waiting] } }));
  assert.equal(operationWait({ ...waiting, results: [{ status: "halted" }] }), null);
  for (const blocker of [{ status: "error", halted: true }, { status: "failed" }, { status: "stale" },
    { status: "queued", outcome: "transaction_failed" }, { status: "incomplete", reason: "barrier_misaligned" }]) {
    assert.equal(operationWait({ status: "incomplete", results: [waiting, blocker] }), null);
  }
  let calls = 0;
  const result = await createOperationRunner().run({ step: async () => { calls++; return { status: "incomplete", results: [waiting, { status: "halted" }] }; } });
  assert.equal(result.status, "incomplete"); assert.equal(calls, 1);
});

test("wait end means dispatch, and only persisted progress resets the consecutive wait count", async () => {
  const time = clock(); let calls = 0; let revision = 0;
  const events = [];
  const runner = createOperationRunner({ now: time.now, sleepUntilNext: async ms => time.advance(ms) });
  const scope = { userId: 7, presetId: "companion" };
  const result = await runner.run({ scope, phase: "memory", onWait: event => events.push(structuredClone(event)),
    readProgress: async () => ({ revision }), step: async () => {
      calls++;
      if (calls === 3 || calls === 4) revision++;
      if (calls === 4) return { status: "completed" };
      return { status: "retry_wait", taskId: "blocked", reason: "llm_call_failed", stage: "provider_error", notBefore: time.iso(1000) };
    } });
  assert.equal(result.status, "completed");
  assert.equal(result.waitCount, 0);
  assert.equal(result.totalWaitCount, 3);
  assert.deepEqual(events.filter(e => e.event === "memory_waiting").map(e => e.waitCount), [1, 2, 1]);
  assert.deepEqual(events.slice(0, 4).map(e => e.event), ["memory_waiting", "memory_wait_finished", "memory_waiting", "memory_wait_finished"]);
  assert.equal(events.filter(e => e.event === "memory_progress_resumed").length, 2);
  assert.ok(events.every(e => e.phase === "memory" && e.scope.presetId === scope.presetId));
});

test("a scheduler reporting completion without persisted advancement cannot report progress recovery", async () => {
  const time = clock(); let calls = 0;
  const events = [];
  await createOperationRunner({ now: time.now, sleepUntilNext: async ms => time.advance(ms) }).run({
    readProgress: async () => 0, onWait: e => events.push(e.event),
    step: async () => ++calls === 1 ? { status: "retry_wait", notBefore: time.iso(1000) } : { status: "completed" },
  });
  assert.deepEqual(events, ["memory_waiting", "memory_wait_finished"]);
});

test("waiting has no elapsed-time limit and cancellation preserves the blocking task", async () => {
  const time = clock(); let calls = 0; const controller = new AbortController(); const start = time.now();
  const result = await createOperationRunner({ now: time.now, sleepUntilNext: async ms => {
    time.advance(ms); if (time.now() - start >= 1_801_000) controller.abort();
  } }).run({ signal: controller.signal,
    step: async () => { calls++; return { status: "retry_wait", taskId: "durable", notBefore: time.iso(3_600_000) }; },
  });
  assert.equal(result.status, "interrupted"); assert.equal(calls, 1); assert.equal(result.result.taskId, "durable");
});

test("durable progress is observed and cancellation interrupts sleeping without dispatch", async () => {
  const time = clock(); let progress = 0; let calls = 0;
  const abort = new AbortController();
  const start = time.now();
  const runner = createOperationRunner({ now: time.now, sleepUntilNext: async ms => {
    time.advance(ms);
    if (time.now() - start === 3_000) progress++;
    if (time.now() - start === 6_000) abort.abort();
  } });
  const result = await runner.run({ signal: abort.signal, readProgress: async () => progress,
    step: async () => { calls++; return { status: "retry_wait", notBefore: time.iso(60_000) }; } });
  assert.equal(result.status, "interrupted"); assert.equal(calls, 1);
});

test("diagnostic summary preserves nested recovery information without rejected outputs or prepared payloads", () => {
  const result = summarizeOperation({ status: "incomplete", result: { status: "retry_wait", taskId: "task", notBefore: "date",
    detail: { status: 503, code: "unavailable", message: "secret" }, rejectedOutput: "secret", envelope: "secret" } });
  assert.equal(result.result.provider.status, 503);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("expired deadlines yield instead of busy-looping while cancellation remains available", async () => {
  const time = clock(); let calls = 0;
  const expired = time.iso(-1000); const controller = new AbortController();
  const result = await createOperationRunner({ now: time.now, sleepUntilNext: async ms => time.advance(ms) }).run({
    signal: controller.signal, step: async () => { if (++calls === 3) controller.abort(); return { status: "retry_wait", notBefore: expired }; },
  });
  assert.equal(result.status, "interrupted"); assert.equal(calls, 3);
});
