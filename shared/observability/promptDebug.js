function removeUndefined(entry) {
  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined) delete entry[key];
  }
  return entry;
}

function buildPromptPayload(options = {}, stream) {
  const settings = options.settings && typeof options.settings === "object"
    ? options.settings
    : undefined;
  const requestContext = options.requestContext && typeof options.requestContext === "object"
    ? options.requestContext
    : {};
  return removeUndefined({
    stream: Boolean(stream),
    userId: requestContext.userId,
    sessionId: requestContext.sessionId,
    presetId: settings?.systemPromptPresetId,
    providerId: options.providerId,
    modelId: options.model,
    messages: options.messages,
    settings,
  });
}

function createPromptDebugDecorator({ enabled = false, write } = {}) {
  const active = enabled === true && typeof write === "function";

  function writePrompt(options, stream) {
    try {
      write("chat_api_request", buildPromptPayload(options, stream));
    } catch {
      // Prompt debug must never affect request handling.
    }
  }

  function decorate(port) {
    if (!active) return port;
    if (!port || typeof port !== "object") {
      throw new Error("Prompt debug decorator requires an LLM port");
    }
    if (typeof port.complete !== "function" || typeof port.createStreamResponse !== "function") {
      throw new Error("Prompt debug decorator requires complete() and createStreamResponse()");
    }
    return Object.freeze({
      ...port,
      complete: (options) => {
        writePrompt(options, false);
        return port.complete(options);
      },
      createStreamResponse: (options) => {
        writePrompt(options, true);
        return port.createStreamResponse(options);
      },
    });
  }

  return Object.freeze({ enabled: active, decorate });
}

module.exports = { createPromptDebugDecorator };