const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createPrivacyHardDelete } = require("../../../modules/memory/application/privacyHardDelete");
const {
  createAvatarStorage,
  operationAvatarUrls,
} = require("../../../modules/chat/infrastructure/avatarStorage");

test("privacy hard delete does not force-drain while any external store still reports residue", async () => {
  const calls = [];
  const sourceRebuild = {
    async initializeGeneration(_u, _p, options) { await options.mutateSource({}); await options.purgeDerived({}, { sourceGeneration: 3, boundaryMessageId: 20 }); return { sourceGeneration: 3, boundaryMessageId: 20 }; },
    async forceDrainTo() { calls.push("drain"); return { status: "completed" }; },
  };
  let operation;
  const repositories = {
    async withTransaction(work) { return work({}); },
    privacy: {
      async purgeDerivedHistory() { calls.push("memory-purge"); },
      async upsertOperation(_u, _p, value) { operation = { ...value }; return operation; },
      async updateOperation(_u, _p, value) { Object.assign(operation, value); return operation; },
    },
  };
  const stores = [{ name: "rag", async purge() { calls.push("rag-purge"); }, async verifyPurged() { return false; } }];
  const hardDelete = createPrivacyHardDelete({ repositories, sourceRebuild, stores });
  const result = await hardDelete.execute(7, "companion", { async deleteRawSource() { calls.push("raw-delete"); } });
  assert.equal(result.status, "purging");
  assert.equal(result.rawMutationCommitted, true);
  assert.deepEqual(calls, ["raw-delete", "memory-purge"]);
  const continued = await hardDelete.continueOperation(7, "companion", operation, { repurge: true });
  assert.equal(continued.status, "incomplete");
  assert.deepEqual(calls, ["raw-delete", "memory-purge", "rag-purge"]);
  assert.equal(calls.includes("drain"), false);
  assert.equal(operation.status, "purging");
});

test("privacy canary is absent from raw source, derived stores, avatar files, and rebuilt state before completion", async () => {
  const uploadsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blog-privacy-test-"));
  const { avatarDir, deleteAvatarByUrl, avatarExists } = createAvatarStorage({ uploadsRoot });
  const canary = `privacy-${crypto.randomUUID()}`;
  const avatarName = `${canary}.webp`;
  const avatarUrl = `/uploads/assistant_avatars/${avatarName}`;
  await fs.mkdir(avatarDir, { recursive: true });
  await fs.writeFile(path.join(avatarDir, avatarName), canary);

  const rawMessages = new Set([canary, "retained-source"]);
  const ragChunks = new Set([canary]);
  const gists = new Set([canary]);
  const memoryHistory = new Set([canary]);
  let rebuiltFrom = [];
  let operation = null;
  let backgroundError = null;
  const repositories = {
    async withTransaction(work) { return work({}); },
    privacy: {
      async purgeDerivedHistory() { memoryHistory.clear(); },
      async upsertOperation(_userId, _presetId, value) {
        operation = { ...value, operation_payload: value.operationPayload };
        return operation;
      },
      async updateOperation(_userId, _presetId, changes) { Object.assign(operation, changes); return operation; },
      async getOperation() { return operation; },
    },
  };
  const sourceRebuild = {
    async initializeGeneration(_userId, _presetId, options) {
      let mutationResult;
      await repositories.withTransaction(async (client) => {
        mutationResult = await options.mutateSource(client);
        await options.purgeDerived(client, { sourceGeneration: 4, boundaryMessageId: 2 });
      });
      return { sourceGeneration: 4, boundaryMessageId: 2, mutationResult };
    },
    async forceDrainTo() {
      assert.equal(rawMessages.has(canary), false);
      assert.equal(ragChunks.has(canary), false);
      assert.equal(gists.has(canary), false);
      assert.equal(await avatarExists(avatarUrl), false);
      rebuiltFrom = [...rawMessages];
      return { status: "completed" };
    },
  };
  const stores = [{
    name: "rag",
    async purge() { ragChunks.clear(); },
    async verifyPurged() { return !ragChunks.has(canary); },
  }, {
    name: "assistant_gists",
    async purge() { gists.clear(); },
    async verifyPurged() { return !gists.has(canary); },
  }, {
    name: "avatar_files",
    async purge({ operation: current }) {
      for (const url of operationAvatarUrls(current)) await deleteAvatarByUrl(url);
    },
    async verifyPurged({ operation: current }) {
      for (const url of operationAvatarUrls(current)) if (await avatarExists(url)) return false;
      return true;
    },
  }];

  const hardDelete = createPrivacyHardDelete({
    repositories,
    sourceRebuild,
    stores,
    onBackgroundError(error) { backgroundError = error; },
  });
  try {
    const started = await hardDelete.execute(7, "companion", {
      async deleteRawSource() { rawMessages.delete(canary); return { deleted: canary }; },
      operationPayload: { avatarUrls: [avatarUrl] },
    });
    assert.equal(started.status, "purging");
    assert.equal(started.rawMutationCommitted, true);
    assert.equal(rawMessages.has(canary), false);
    assert.equal(memoryHistory.has(canary), false);

    for (let attempt = 0; attempt < 20 && operation?.status !== "completed" && !backgroundError; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ifError(backgroundError);
    assert.equal(operation.status, "completed");
    assert.deepEqual(rebuiltFrom, ["retained-source"]);
    assert.equal(ragChunks.has(canary), false);
    assert.equal(gists.has(canary), false);
    assert.equal(await avatarExists(avatarUrl), false);
  } finally {
    await fs.rm(uploadsRoot, { recursive: true, force: true });
  }
});
