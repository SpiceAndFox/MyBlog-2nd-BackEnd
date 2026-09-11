const { createHmac, randomUUID } = require("node:crypto");

let diagnosticRunId;

function sessionIdentity(request) {
  const scope = request.requestContext?.scope;
  if (scope !== undefined) {
    if (!scope || !["string", "number"].includes(typeof scope.userId)
      || !String(scope.userId).trim() || typeof scope.presetId !== "string" || !scope.presetId.trim()) {
      throw new Error("Memory provider requestContext.scope requires userId and presetId");
    }
    return ["scope", String(scope.userId), scope.presetId];
  }
  const taskId = request.requestContext?.taskId ?? request.userPayload?.task?.taskId;
  if (typeof taskId === "string" && taskId.trim()) return ["task", taskId];
  // Synthetic probes without an envelope belong to one diagnostic conversation per process.
  diagnosticRunId ||= randomUUID();
  return ["diagnostic", diagnosticRunId];
}

function buildProviderHeaders(config, policy, request) {
  if (policy.headerPolicy === "none") return {};
  if (policy.headerPolicy !== "opencode-session") throw new Error(`Unsupported header policy: ${policy.headerPolicy}`);
  if (!config.apiKey) throw new Error("Memory provider session headers require an API key");
  // Keyed IDs isolate credentials and hide low-entropy user/preset identifiers.
  // Stable across workers/restarts; changing credentials intentionally changes routing identity.
  const session = createHmac("sha256", config.apiKey)
    .update(JSON.stringify(["memory-session-v1", ...sessionIdentity(request)]))
    .digest("hex");
  return { "User-Agent": "BlogBackEnd-memory/1.0", "x-opencode-session": session };
}

module.exports = { buildProviderHeaders };
