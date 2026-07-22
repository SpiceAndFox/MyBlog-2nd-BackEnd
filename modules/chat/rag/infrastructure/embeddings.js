function createEmbeddingClient({ config: chatRagConfig, fetchImpl = globalThis.fetch, openRouterAttribution = {} } = {}) {
  if (!chatRagConfig || typeof chatRagConfig !== "object") throw new Error("Chat RAG embedding config is required");
  if (typeof fetchImpl !== "function") throw new Error("Chat RAG embedding fetch implementation is required");
  const attributionHeaders = Object.freeze({ ...openRouterAttribution });

function normalizeBaseUrl(baseUrl) {
  const url = new URL(String(baseUrl || "").trim());
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedPath = String(path || "")
    .trim()
    .replace(/^\/+/, "");
  return new URL(normalizedPath, normalizedBaseUrl).toString();
}

function buildHeaderExtensions() {
  const baseUrl = String(chatRagConfig.embeddingBaseUrl || "");
  if (!baseUrl.includes("openrouter.ai")) return {};
  return attributionHeaders;
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return { json: null, text: "" };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function pickErrorMessage({ status, json, text }) {
  if (json && typeof json === "object") {
    const message =
      json?.error?.message ||
      json?.error ||
      json?.message ||
      json?.msg ||
      (typeof json?.detail === "string" ? json.detail : null);
    if (message) return String(message);
  }
  if (text) return text.slice(0, 800);
  return `Upstream embedding request failed (HTTP ${status})`;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateEmbedding(embedding, { index } = {}) {
  if (!Array.isArray(embedding)) {
    throw new Error(`Invalid embedding at index ${index}: expected array`);
  }
  if (embedding.length !== chatRagConfig.embeddingDimensions) {
    throw new Error(
      `Invalid embedding dimensions at index ${index}: expected ${chatRagConfig.embeddingDimensions}, got ${embedding.length}`
    );
  }
  return embedding.map((value, dimensionIndex) => {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`Invalid embedding number at index ${index}, dimension ${dimensionIndex}`);
    }
    return number;
  });
}

function buildOpenAiCompatibleBody(texts) {
  const body = {
    model: chatRagConfig.embeddingModel,
    input: texts,
  };

  if (chatRagConfig.embeddingIncludeDimensionsParam) {
    body.dimensions = chatRagConfig.embeddingDimensions;
  }

  const rawBody = isPlainObject(chatRagConfig.embeddingRawBody) ? chatRagConfig.embeddingRawBody : {};
  const protectedKeys = new Set(["model", "input", "dimensions"]);
  for (const [key, value] of Object.entries(rawBody)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey || protectedKeys.has(normalizedKey)) continue;
    if (value === undefined) continue;
    body[normalizedKey] = value;
  }

  return body;
}

async function createEmbeddings({ texts, signal } = {}) {
  if (!chatRagConfig.enabled) throw new Error("Chat RAG is disabled");
  if (chatRagConfig.embeddingProvider !== "openai-compatible") {
    throw new Error(`Unsupported embedding provider: ${chatRagConfig.embeddingProvider}`);
  }

  const list = Array.isArray(texts) ? texts.map((text) => String(text || "").trim()) : [];
  if (!list.length || list.some((text) => !text)) {
    throw new Error("Embedding texts must be a non-empty list of non-empty strings");
  }

  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new Error("Embedding request timeout")),
    chatRagConfig.embeddingTimeoutMs
  );
  const abortFromParent = () => abortController.abort(signal?.reason || new Error("Request cancelled"));
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });

  const url = buildUrl(chatRagConfig.embeddingBaseUrl, "embeddings");

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        ...buildHeaderExtensions(),
        "Content-Type": "application/json",
        Authorization: `Bearer ${chatRagConfig.embeddingApiKey}`,
      },
      body: JSON.stringify(buildOpenAiCompatibleBody(list)),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const { json, text } = await readJsonSafe(response);
      const error = new Error(pickErrorMessage({ status: response.status, json, text }));
      error.status = response.status;
      error.upstream = "embedding";
      throw error;
    }

    const data = await response.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (rows.length !== list.length) {
      throw new Error(`Embedding response count mismatch: expected ${list.length}, got ${rows.length}`);
    }

    return rows.map((row, index) => validateEmbedding(row?.embedding, { index }));
  } catch (error) {
    if (error?.upstream === "embedding") throw error;

    const wrapped = new Error(`Embedding request failed before HTTP response: ${error?.message || String(error)}`);
    wrapped.name = error?.name || "EmbeddingNetworkError";
    wrapped.cause = error;
    wrapped.upstream = "embedding";
    wrapped.retryable = true;
    wrapped.url = url;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

return Object.freeze({
  createEmbeddings,
});
}

module.exports = { createEmbeddingClient };
