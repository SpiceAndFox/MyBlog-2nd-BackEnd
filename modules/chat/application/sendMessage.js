const crypto = require("node:crypto");
const { ChatApplicationError, fail } = require("./errors");

function normalizePositiveId(value) {
  const id = Number.parseInt(String(value), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function normalizeIdempotencyKey(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function getAbortReasonMessage(signal) {
  const reason = signal?.reason;
  if (!reason) return "";
  return reason instanceof Error ? reason.message || "" : String(reason);
}

function createSendMessageUseCase({
  chatRepository,
  settings,
  compileContext,
  llm,
  memory,
  rag,
  gist,
  scopeCoordinator,
  logger,
  timeoutMs,
  randomUUID = crypto.randomUUID,
} = {}) {
  for (const method of [
    "getSession",
    "updateSessionSettings",
    "createUserMessage",
    "getAssistantForUserMessage",
    "createAssistantMessageForTurn",
    "touchSession",
  ]) {
    if (typeof chatRepository?.[method] !== "function") throw new Error(`Chat repository port is missing: ${method}`);
  }
  if (!settings?.getSessionPresetId || !settings?.resolvePresetForSession) throw new Error("Chat settings service is required");
  if (typeof compileContext !== "function") throw new Error("Chat context compiler is required");
  if (!llm?.complete || !llm?.createStreamResponse || !llm?.streamDeltas) throw new Error("Chat LLM port is required");
  if (!memory || typeof memory.processScope !== "function") throw new Error("Chat Memory port is required");
  if (!rag || typeof rag.requestTurnIndexing !== "function") throw new Error("Chat RAG indexing port is required");
  if (!gist || typeof gist.requestGeneration !== "function") throw new Error("Chat gist port is required");
  if (!scopeCoordinator?.enqueueByKey || !scopeCoordinator?.buildKey) throw new Error("Chat scope coordinator is required");
  if (!logger?.debug || !logger?.error) throw new Error("Chat logger is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Chat LLM timeout is required");

  function requestPostTurnWork({ userId, presetId, sessionId, userMessage, assistantMessage, assistantContent }) {
    if (memory.enabled) void memory.processScope(userId, presetId);
    else {
      try {
        rag.requestTurnIndexing({
          userId,
          presetId,
          sessionId,
          userMessage,
          assistantMessage,
          userContent: userMessage?.content,
          assistantContent,
        });
      } catch (error) {
        logger.error("chat_rag_turn_index_kick_failed", {
          error,
          userId,
          presetId,
          sessionId,
          userMessageId: userMessage?.id,
          assistantMessageId: assistantMessage?.id,
        });
      }
    }
    gist.requestGeneration({
      userId,
      presetId,
      messageId: assistantMessage?.id,
      userContent: userMessage?.content,
      content: assistantContent,
    });
  }

  async function commitAssistant({ userId, sessionId, presetId, userMessage, assistantContent }) {
    const { message: assistantMessage } = await chatRepository.createAssistantMessageForTurn(
      userId,
      sessionId,
      userMessage.id,
      userMessage.turn_id,
      assistantContent,
    );
    const session = await chatRepository.touchSession(userId, sessionId);
    requestPostTurnWork({ userId, presetId, sessionId, userMessage, assistantMessage, assistantContent });
    return { session, assistantMessage };
  }

  async function executeInScope(input, signal) {
    const { userId, sessionId, content, idempotencyKey, rawSettings, onStreamStart, onStreamDelta } = input;
    let errorSession = null;
    let userMessage = null;
    try {
      if (!content) fail("Content cannot be empty", { status: 400, code: "CHAT_CONTENT_EMPTY" });
      const session = await chatRepository.getSession(userId, sessionId);
      if (!session) fail("Session not found", { status: 404, code: "CHAT_SESSION_NOT_FOUND" });
      errorSession = session;
      if (!settings.isSessionEditableToday(session)) {
        fail("Historical sessions are read-only", { status: 403, code: "CHAT_SESSION_READ_ONLY" });
      }

      const incomingSettings = settings.sanitize(rawSettings);
      const presetResolution = await settings.resolvePresetForSession({
        userId,
        session,
        incomingSettings,
        enforceMatch: true,
      });
      if (presetResolution.error) fail(presetResolution.error, { status: 400, code: "CHAT_PRESET_INVALID" });
      const { presetId, preset } = presetResolution;

      const mergedSettings = settings.merge(session.settings, incomingSettings);
      mergedSettings.systemPromptPresetId = presetId;
      mergedSettings.systemPrompt = preset?.systemPrompt || "";
      const providerResolution = settings.resolveProviderModel(mergedSettings);
      if (providerResolution.error) {
        fail(providerResolution.error, { status: providerResolution.status, code: "CHAT_PROVIDER_INVALID" });
      }
      const { providerId, modelId, providerDefinition } = providerResolution;
      const validationError = settings.validate(mergedSettings, { providerId, modelId });
      if (validationError) fail(validationError, { status: 400, code: "CHAT_SETTINGS_INVALID" });

      const effectiveSettings = settings.normalize(mergedSettings, { providerId, modelId });
      Object.assign(effectiveSettings, {
        providerId,
        modelId,
        systemPromptPresetId: presetId,
        systemPrompt: preset?.systemPrompt || "",
      });
      if (providerDefinition?.capabilities?.webSearch === false) effectiveSettings.enableWebSearch = false;

      let updatedSession = await chatRepository.updateSessionSettings(
        userId,
        sessionId,
        effectiveSettings,
        presetId,
      ) || session;
      errorSession = updatedSession;

      const userInsert = await chatRepository.createUserMessage(userId, sessionId, content, {
        turnId: randomUUID(),
        idempotencyKey,
      });
      userMessage = userInsert.message;
      if (!userMessage) {
        if (userInsert.blocked) fail("Privacy operation is still in progress", { status: 409, code: "CHAT_PRIVACY_PENDING" });
        fail("Session not found", { status: 404, code: "CHAT_SESSION_NOT_FOUND" });
      }
      if (!userInsert.created) {
        const existingAssistant = await chatRepository.getAssistantForUserMessage(userId, userMessage.id);
        if (existingAssistant) {
          return {
            kind: "idempotent_replay",
            stream: false,
            session: updatedSession,
            userMessage,
            assistantMessage: existingAssistant,
          };
        }
      }

      const context = await compileContext({
        userId,
        presetId,
        systemPrompt: effectiveSettings.systemPrompt,
        upToMessageId: userMessage.id,
        signal,
      });
      logger.debug("chat_context_compiled", {
        userId,
        sessionId,
        presetId,
        segments: context.segments,
        memory: context.memory,
      });

      if (!effectiveSettings.stream) {
        const { content: assistantContent } = await llm.complete({
          providerId,
          model: modelId,
          messages: context.messages,
          settings: effectiveSettings,
          signal,
        });
        const committed = await commitAssistant({
          userId,
          sessionId,
          presetId,
          userMessage,
          assistantContent,
        });
        return {
          kind: "completed",
          stream: false,
          session: committed.session,
          userMessage,
          assistantMessage: committed.assistantMessage,
          context,
        };
      }

      onStreamStart?.({ sessionId, userMessage, context });
      const abortController = new AbortController();
      const abortFromScope = () => abortController.abort(signal?.reason || new Error("Request cancelled"));
      if (signal?.aborted) abortFromScope();
      else signal?.addEventListener("abort", abortFromScope, { once: true });
      const timeout = setTimeout(() => abortController.abort(new Error("LLM request timeout")), timeoutMs);
      let assistantContent = "";
      let finalAssistantContent = "";
      try {
        const upstreamResponse = await llm.createStreamResponse({
          providerId,
          model: modelId,
          messages: context.messages,
          settings: effectiveSettings,
          signal: abortController.signal,
        });
        for await (const event of llm.streamDeltas({ providerId, response: upstreamResponse })) {
          if (typeof event === "string") {
            if (!event) continue;
            assistantContent += event;
            onStreamDelta?.(event);
            continue;
          }
          if (!event || typeof event !== "object") continue;
          if (event.type === "final") {
            if (typeof event.content === "string" && event.content.trim()) finalAssistantContent = event.content;
            continue;
          }
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (!delta) continue;
          assistantContent += delta;
          onStreamDelta?.(delta);
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          throw new ChatApplicationError(getAbortReasonMessage(abortController.signal) || "Request cancelled", {
            code: error?.code || signal?.reason?.code || "CHAT_REQUEST_ABORTED",
            status: signal?.reason?.code === "CHAT_SCOPE_MUTATED" ? 409 : 500,
            session: errorSession,
            userMessage,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortFromScope);
      }

      const normalizedAssistantContent = (finalAssistantContent || assistantContent).trim();
      if (!normalizedAssistantContent) fail("Empty model response", { code: "CHAT_EMPTY_MODEL_RESPONSE" });
      const committed = await commitAssistant({
        userId,
        sessionId,
        presetId,
        userMessage,
        assistantContent: normalizedAssistantContent,
      });
      return {
        kind: "completed",
        stream: true,
        session: committed.session,
        userMessage,
        assistantMessage: committed.assistantMessage,
        context,
      };
    } catch (error) {
      if (error instanceof ChatApplicationError) {
        if (!error.session && errorSession) error.session = errorSession;
        if (!error.userMessage && userMessage) error.userMessage = userMessage;
        throw error;
      }
      throw new ChatApplicationError(error?.message || "Internal Server Error", {
        code: error?.code || "CHAT_MESSAGE_SEND_FAILED",
        status: ["CHAT_IDEMPOTENCY_CONFLICT", "CHAT_TURN_STALE", "CHAT_SCOPE_MUTATED"].includes(error?.code) ? 409 : 500,
        session: errorSession,
        userMessage,
      });
    }
  }

  return async function sendMessage(input = {}) {
    const userId = input.userId;
    const sessionId = normalizePositiveId(input.sessionId);
    const content = String(input.content || "").trim();
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    if (!sessionId) fail("Invalid sessionId", { status: 400, code: "CHAT_SESSION_ID_INVALID" });
    if (!idempotencyKey) {
      fail("Idempotency-Key header is required", { status: 400, code: "CHAT_IDEMPOTENCY_KEY_REQUIRED" });
    }

    const session = await chatRepository.getSession(userId, sessionId);
    if (!session) fail("Session not found", { status: 404, code: "CHAT_SESSION_NOT_FOUND" });
    const presetId = settings.getSessionPresetId(session);
    if (!presetId) fail("Session has no valid preset", { status: 409, code: "CHAT_SESSION_PRESET_INVALID" });

    return scopeCoordinator.enqueueByKey(
      scopeCoordinator.buildKey(userId, presetId),
      ({ signal }) => executeInScope({ ...input, userId, sessionId, content, idempotencyKey }, signal),
      { cancellable: true, signal: input.signal },
    );
  };
}

module.exports = { createSendMessageUseCase, normalizeIdempotencyKey, normalizePositiveId };
