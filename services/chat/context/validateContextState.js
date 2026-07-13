function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertString(value, { name, allowEmpty = true } = {}) {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${name || "string"}: expected string`);
  }
  if (!allowEmpty && !value.trim()) {
    throw new Error(`Invalid ${name || "string"}: expected non-empty string`);
  }
}

function assertNumber(value, { name, allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined)) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${name || "number"}: expected number`);
  }
}

function assertChatMessages(messages, { name } = {}) {
  if (!Array.isArray(messages)) {
    throw new Error(`Invalid ${name || "messages"}: expected array`);
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isPlainObject(message)) {
      throw new Error(`Invalid ${name || "messages"}[${i}]: expected object`);
    }
    assertString(message.role, { name: `${name || "messages"}[${i}].role`, allowEmpty: false });
    assertString(message.content, { name: `${name || "messages"}[${i}].content`, allowEmpty: false });
  }
}

function assertOptionalMessageContainer(container, { name } = {}) {
  if (container === null || container === undefined) return;
  if (!isPlainObject(container)) {
    throw new Error(`Invalid ${name || "container"}: expected object`);
  }
  assertChatMessages(container.messages, { name: `${name || "container"}.messages` });
}

function assertContextState(contextState) {
  if (!isPlainObject(contextState)) throw new Error("Invalid contextState: expected object");

  assertString(contextState.systemPrompt ?? "", { name: "contextState.systemPrompt", allowEmpty: true });
  assertOptionalMessageContainer(contextState.gapBridge, { name: "contextState.gapBridge" });
  assertOptionalMessageContainer(contextState.ragContext, { name: "contextState.ragContext" });
  if (contextState.memoryV2 !== null && contextState.memoryV2 !== undefined) {
    if (!isPlainObject(contextState.memoryV2)) throw new Error("Invalid contextState.memoryV2: expected object or null");
    assertString(contextState.memoryV2.renderedText ?? "", { name: "contextState.memoryV2.renderedText", allowEmpty: true });
  }

  if (!isPlainObject(contextState.recent)) {
    throw new Error("Invalid contextState.recent: expected object");
  }
  assertChatMessages(contextState.recent.messages, { name: "contextState.recent.messages" });

  if (!isPlainObject(contextState.timeContext)) {
    throw new Error("Invalid contextState.timeContext: expected object");
  }
  assertNumber(contextState.timeContext.nowMs, { name: "contextState.timeContext.nowMs" });
  assertNumber(contextState.timeContext.lastMs, { name: "contextState.timeContext.lastMs", allowNull: true });
  assertNumber(contextState.timeContext.gapMs, { name: "contextState.timeContext.gapMs", allowNull: true });
}

function assertSegmentResult(segment, { name } = {}) {
  if (segment === null || segment === undefined) return;
  if (!isPlainObject(segment)) throw new Error(`Invalid ${name || "segment"}: expected object`);
  assertChatMessages(segment.messages, { name: `${name || "segment"}.messages` });
}

module.exports = {
  assertContextState,
  assertSegmentResult,
  assertChatMessages,
};
