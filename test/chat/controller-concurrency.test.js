const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

require("module-alias/register");

function replaceModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function localDateKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

class TestResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.body = null;
    this.chunks = [];
  }

  status(value) { this.statusCode = value; return this; }
  setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); }
  getHeader(name) { return this.headers.get(String(name).toLowerCase()); }
  flushHeaders() { this.headersSent = true; }
  json(value) { this.body = value; this.headersSent = true; this.writableEnded = true; this.emit("finish"); return this; }
  send(value) { this.body = value; this.headersSent = true; this.writableEnded = true; this.emit("finish"); return this; }
  write(value) { this.headersSent = true; this.chunks.push(String(value)); return true; }
  end() { this.headersSent = true; this.writableEnded = true; this.emit("finish"); }
}

function request(sessionId, content, idempotencyKey, body = {}) {
  return {
    user: { id: 7 },
    params: { sessionId: String(sessionId), messageId: String(body.messageId || "") },
    body: { content, ...body },
    get(name) { return String(name).toLowerCase() === "idempotency-key" ? idempotencyKey : undefined; },
    method: "POST",
    originalUrl: `/api/chat/sessions/${sessionId}/messages`,
  };
}

const events = [];
const sessions = new Map();
const messages = [];
const byIdempotencyKey = new Map();
let nextMessageId = 1;
let completeChat = async () => "assistant";
let createStreamResponse = async () => { throw new Error("stream not expected"); };
let readStreamDeltas = async function* empty() {};
let lastPrivacyOptions = null;
let compileContext = async ({ upToMessageId, signal }) => {
  if (signal?.aborted) throw signal.reason;
  events.push(`context:${upToMessageId}`);
  return { messages: [{ role: "user", content: "compiled" }], segments: {}, memory: null, rag: null };
};

function resetHarness() {
  events.length = 0;
  sessions.clear();
  messages.length = 0;
  byIdempotencyKey.clear();
  nextMessageId = 1;
  completeChat = async () => "assistant";
  createStreamResponse = async () => { throw new Error("stream not expected"); };
  readStreamDeltas = async function* empty() {};
  lastPrivacyOptions = null;
  compileContext = async ({ upToMessageId, signal }) => {
    if (signal?.aborted) throw signal.reason;
    events.push(`context:${upToMessageId}`);
    return { messages: [{ role: "user", content: "compiled" }], segments: {}, memory: null, rag: null };
  };
  for (const id of [11, 12]) {
    sessions.set(id, {
      id,
      title: localDateKey(),
      preset_id: "companion",
      settings: { providerId: "deepseek", modelId: "deepseek-v4-flash", stream: false },
    });
  }
}

const chatModel = {
  async getSession(_userId, sessionId) { return sessions.get(Number(sessionId)) || null; },
  async updateSessionSettings(_userId, sessionId, settings) {
    const session = sessions.get(Number(sessionId));
    Object.assign(session.settings, settings);
    return session;
  },
  async touchSession(_userId, sessionId) { return sessions.get(Number(sessionId)); },
  async createUserMessage(_userId, sessionId, content, { turnId, idempotencyKey }) {
    const existing = byIdempotencyKey.get(idempotencyKey);
    if (existing) {
      if (existing.session_id !== Number(sessionId) || existing.content !== content) {
        throw Object.assign(new Error("Idempotency conflict"), { code: "CHAT_IDEMPOTENCY_CONFLICT" });
      }
      return { message: existing, created: false };
    }
    const message = {
      id: nextMessageId++, session_id: Number(sessionId), preset_id: "companion", role: "user",
      content, turn_id: turnId, idempotency_key: idempotencyKey, source_generation: 0,
    };
    events.push(`user:${content}`);
    messages.push(message);
    byIdempotencyKey.set(idempotencyKey, message);
    return { message, created: true };
  },
  async getAssistantForUserMessage(_userId, parentId) {
    return messages.find((message) => message.role === "assistant" && message.parent_user_message_id === parentId) || null;
  },
  async createAssistantMessageForTurn(_userId, sessionId, parentId, turnId, content) {
    const parent = messages.find((message) => message.id === parentId && message.role === "user");
    if (!parent || parent.turn_id !== turnId || parent.source_generation !== 0) {
      throw Object.assign(new Error("Stale turn"), { code: "CHAT_TURN_STALE" });
    }
    const existing = await this.getAssistantForUserMessage(_userId, parentId);
    if (existing) return { message: existing, created: false };
    const message = {
      id: nextMessageId++, session_id: Number(sessionId), preset_id: "companion", role: "assistant",
      content, turn_id: turnId, parent_user_message_id: parentId, source_generation: 0,
    };
    events.push(`assistant:${content}`);
    messages.push(message);
    return { message, created: true };
  },
  async getMessage(_userId, _sessionId, messageId) {
    return messages.find((message) => message.id === Number(messageId)) || null;
  },
  async deleteMessagesAfter(_userId, sessionId, messageId) {
    events.push("edit:truncate");
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].session_id === Number(sessionId) && messages[index].id > Number(messageId)) messages.splice(index, 1);
    }
  },
  async updateMessageContent(_userId, _sessionId, messageId, content, { turnId, idempotencyKey }) {
    events.push("edit:update");
    const message = messages.find((entry) => entry.id === Number(messageId));
    Object.assign(message, { content, turn_id: turnId, idempotency_key: idempotencyKey });
    return message;
  },
  async setMessageSourceGeneration(_userId, _sessionId, messageId, sourceGeneration) {
    const message = messages.find((entry) => entry.id === Number(messageId));
    message.source_generation = sourceGeneration;
    return message;
  },
};

replaceModule("../../config", {
  chatConfig: { dayTimeZone: "Asia/Shanghai", defaultProviderId: "deepseek", defaultSettings: {}, defaultModelByProvider: { deepseek: "deepseek-v4-flash" } },
  llmConfig: { timeoutMs: 1000 },
  chatRagConfig: { enabled: true, debugIncludeContent: false },
});
replaceModule("../../modules/memory", { markRecoveryNotificationsDelivered: async () => {} });
replaceModule("../../modules/chat/rag/indexer", { requestChatTurnIndexing() {}, requestDeleteChunksFromMessageId() {} });
const testLogger = { debug() {}, warn() {}, error() {} };
replaceModule("../../logger", { logger: testLogger, withRequestContext: (_req, value) => value });
const providerCatalog = {
  getProviderDefinition: () => ({ capabilities: { webSearch: false } }),
  isSupportedProvider: () => true,
  listConfiguredProviders: () => [],
  listSupportedProviders: () => [],
};
replaceModule("../../services/llm/providers", providerCatalog);
const modelCatalog = { isSupportedModel: () => true, listModelsForProvider: () => [{ id: "deepseek-v4-flash" }] };
replaceModule("../../services/llm/models", modelCatalog);
const settingsSchema = {
  getGlobalNumericRange: () => null,
  getProviderNumericRange: () => null,
  clampNumberWithRange: (value) => Number(value),
  getActiveSchemaControls: () => [],
  getProviderModel: () => null,
  getControlOptions: () => [],
  validateSettingsWithSchema: () => null,
};
replaceModule("../../services/llm/settingsSchema", settingsSchema);
const llmPort = {
  createChatCompletion: async (options) => ({ content: await completeChat(options) }),
  createChatCompletionStreamResponse: (options) => createStreamResponse(options),
  streamChatCompletionDeltas: (options) => readStreamDeltas(options),
};
replaceModule("../../services/llm/chatCompletions", llmPort);

const { createChatScopeCoordinator } = require("../../modules/chat");
const scopeCoordinator = createChatScopeCoordinator();
const memoryRuntime = {
  enabled: false,
  async getPrivacyOperation() { return null; },
  async assembleContext() { throw new Error("Memory context is disabled"); },
  async processScope() {},
  async rebuildScope() {},
  async privacyHardDelete(userId, presetId, options) {
    lastPrivacyOptions = options;
    return scopeCoordinator.enqueueByKey(scopeCoordinator.buildKey(userId, presetId), async () => {
      const mutationResult = await options.deleteRawSource(null);
      await options.afterGenerationInitialized?.(null, { sourceGeneration: 1, boundaryMessageId: 0 });
      return { status: "purging", operationId: "privacy-edit", rawMutationCommitted: true, mutationResult };
    });
  },
};
replaceModule("../../services/chat/memoryRuntime", memoryRuntime);

const { createChatModule } = require("../../modules/chat");
const chatModule = createChatModule({
  config: {
    chat: {
      dayTimeZone: "Asia/Shanghai",
      defaultProviderId: "deepseek",
      defaultSettings: {},
      defaultModelByProvider: { deepseek: "deepseek-v4-flash" },
    },
    context: { recentWindowAssistantGistEnabled: false },
    gist: { enabled: false },
    timeContext: { enabled: false, timeZone: "Asia/Shanghai", template: "" },
    llm: { timeoutMs: 1000 },
    memory: { enabled: false },
  },
  adapters: {
    chatRepository: chatModel,
    presetRepository: { getPreset: async (_userId, presetId) => ({ id: presetId, systemPrompt: "You are a companion." }) },
    providers: providerCatalog,
    models: modelCatalog,
    settingsSchema,
    isModelAllowed: () => true,
    memory: memoryRuntime,
    rag: { retrieve: async () => null, requestTurnIndexing() {}, requestDeleteFromMessage() {} },
    gist: { scheduleBackfill() {}, requestGeneration() {} },
    presets: {},
    sessions: {},
    trashCleanup: {},
    llm: {
      complete: llmPort.createChatCompletion,
      createStreamResponse: llmPort.createChatCompletionStreamResponse,
      streamDeltas: llmPort.streamChatCompletionDeltas,
    },
    scopeCoordinator,
    logger: testLogger,
    compileContext: (options) => compileContext(options),
  },
});
const { createChatController } = require("../../controllers/chatController");
const chatController = createChatController({
  chatModule,
  memory: { markRecoveryNotificationsDelivered: async () => {} },
  config: { rag: { enabled: true, debugIncludeContent: false } },
  logger: testLogger,
  withRequestContext: (_req, value) => value,
});

test.beforeEach(resetHarness);

test("send failures expose the application error code to clients", async () => {
  const response = new TestResponse();

  await chatController.sendMessage(request(11, "missing key", null), response);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    error: "Idempotency-Key header is required",
    code: "CHAT_IDEMPOTENCY_KEY_REQUIRED",
  });
});

test("two sends in different sessions of one preset commit complete turns in scope order", async () => {
  let releaseFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  completeChat = ({ signal }) => {
    const userCount = events.filter((event) => event.startsWith("user:")).length;
    if (userCount === 1) {
      events.push("provider:first");
      firstStartedResolve();
      return new Promise((resolve, reject) => {
        releaseFirst = () => resolve("a1");
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    events.push("provider:second");
    return "a2";
  };

  const firstResponse = new TestResponse();
  const secondResponse = new TestResponse();
  const first = chatController.sendMessage(request(11, "u1", "send-1"), firstResponse);
  await firstStarted;
  const second = chatController.sendMessage(request(12, "u2", "send-2"), secondResponse);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["user:u1", "context:1", "provider:first"]);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "user:u1", "context:1", "provider:first", "assistant:a1",
    "user:u2", "context:3", "provider:second", "assistant:a2",
  ]);
  assert.deepEqual(messages.map((message) => [message.role, message.content]), [
    ["user", "u1"], ["assistant", "a1"], ["user", "u2"], ["assistant", "a2"],
  ]);
});

test("concurrent retry with one idempotency key replays the committed turn without another Provider call", async () => {
  let calls = 0;
  completeChat = async () => { calls += 1; return "only-once"; };
  const firstResponse = new TestResponse();
  const retryResponse = new TestResponse();

  await Promise.all([
    chatController.sendMessage(request(11, "same", "retry-key"), firstResponse),
    chatController.sendMessage(request(11, "same", "retry-key"), retryResponse),
  ]);

  assert.equal(calls, 1);
  assert.equal(messages.length, 2);
  assert.equal(retryResponse.body.idempotent_replay, true);
  assert.equal(retryResponse.body.assistant_message.content, "only-once");
});

test("edit cancels an active send, waits for its lane, and returns an asynchronous privacy operation", async () => {
  let providerStartedResolve;
  const providerStarted = new Promise((resolve) => { providerStartedResolve = resolve; });
  completeChat = ({ signal }) => new Promise((_, reject) => {
    events.push("provider:active");
    providerStartedResolve();
    signal.addEventListener("abort", () => {
      events.push("provider:aborted");
      reject(signal.reason);
    }, { once: true });
  });

  const sendResponse = new TestResponse();
  const send = chatController.sendMessage(request(11, "old", "edit-key"), sendResponse);
  await providerStarted;
  const userMessage = messages[0];
  const editResponse = new TestResponse();
  const editRequest = request(11, "new", null, { messageId: userMessage.id, regenerate: true });
  editRequest.method = "PATCH";
  const edit = chatController.editMessage(editRequest, editResponse);

  await Promise.all([send, edit]);
  assert.equal(sendResponse.statusCode, 409);
  assert.equal(editResponse.statusCode, 202);
  assert.equal(editResponse.body.privacy.operationId, "privacy-edit");
  assert.equal(editResponse.body.privacy.rawMutationCommitted, true);
  assert.equal(editResponse.body.regeneration.status, "blocked_until_privacy_completed");
  assert.equal(messages.some((message) => message.role === "assistant"), false);
  assert.equal(messages[0].content, "new");
  assert.equal(lastPrivacyOptions.affectedFromMessageId, userMessage.id);
  assert.equal(events.indexOf("provider:aborted") < events.indexOf("edit:update"), true);
});

test("degraded RAG context remains observable but does not block the main chat Provider", async () => {
  compileContext = async () => ({
    messages: [{ role: "user", content: "main-chat-still-runs" }],
    segments: { rag: { reason: "retrieval_degraded", degraded: true, failure: "http_429" } },
    memory: null,
    rag: {
      enabled: true,
      sources: [],
      stats: { reason: "retrieval_degraded", degraded: true, failure: "http_429" },
    },
  });
  let providerMessages = null;
  completeChat = async ({ messages: compiled }) => { providerMessages = compiled; return "healthy-main-provider"; };
  const response = new TestResponse();

  await chatController.sendMessage(request(11, "hello", "rag-degraded"), response);

  assert.deepEqual(providerMessages, [{ role: "user", content: "main-chat-still-runs" }]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.assistant_message.content, "healthy-main-provider");
  assert.deepEqual(response.body.rag_health, {
    status: "degraded",
    reason: "retrieval_degraded",
    failure: "http_429",
  });
});

test("streaming sends HTTP events while committing only the normalized final Provider response", async () => {
  sessions.get(11).settings.stream = true;
  createStreamResponse = async () => ({ body: "upstream" });
  readStreamDeltas = async function* stream() {
    yield "partial ";
    yield { type: "delta", delta: "draft" };
    yield { type: "final", content: " canonical final " };
  };
  const response = new TestResponse();

  await chatController.sendMessage(request(11, "hello", "stream-key"), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.getHeader("Content-Type"), "text/event-stream; charset=utf-8");
  assert.equal(response.writableEnded, true);
  assert.match(response.chunks[0], /"type":"start"/);
  assert.match(response.chunks[1], /"type":"delta","delta":"partial "/);
  assert.match(response.chunks[2], /"type":"delta","delta":"draft"/);
  assert.match(response.chunks.at(-1), /"type":"done"/);
  assert.equal(messages.at(-1).content, "canonical final");
});
