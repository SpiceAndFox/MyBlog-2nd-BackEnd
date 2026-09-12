const { createHmac, randomUUID } = require("node:crypto");

function buildOpenCodeGoHeaders(provider, requestContext) {
  if (!["opencode-go-openai", "opencode-go-messages"].includes(provider.id)) return {};
  if (!provider.apiKey) throw new Error("OpenCode Go session headers require an API key");

  // Calls without a persisted conversation (e.g. auxiliary one-shot requests)
  // get their own identity instead of sharing routing across unrelated users.
  let identity = ["standalone", randomUUID()];
  if (requestContext !== undefined) {
    const { userId, sessionId } = requestContext || {};
    if (![userId, sessionId].every(value =>
      ["string", "number"].includes(typeof value) && String(value).trim())) {
      throw new Error("Chat provider requestContext requires userId and sessionId");
    }
    identity = ["conversation", String(userId), String(sessionId)];
  }

  // Stable across turns, protocol switches, workers and restarts. HMAC hides
  // internal IDs and isolates credentials, with a namespace separate from memory.
  const session = createHmac("sha256", provider.apiKey)
    .update(JSON.stringify(["chat-session-v1", ...identity]))
    .digest("hex");
  return { "User-Agent": "BlogBackEnd-chat/1.0", "x-opencode-session": session };
}

module.exports = { buildOpenCodeGoHeaders };
