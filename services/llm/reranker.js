const { chatRagConfig } = require("../../config");

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

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
  return `Upstream reranker request failed (HTTP ${status})`;
}

function clipDocument(value, maxChars) {
  const text = String(value || "").trim();
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return text;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function buildRerankBody({ query, documents, topN }) {
  const body = {
    model: chatRagConfig.rerankerModel,
    query,
    documents,
    top_n: topN,
    return_documents: false,
  };

  // Only honored by SiliconFlow's Qwen3-Reranker family; omitted entirely for
  // other rerankers. Empty string is NOT sent (server then applies its default).
  const instruction = String(chatRagConfig.rerankerInstruction || "").trim();
  if (instruction) body.instruction = instruction;

  const rawBody = isPlainObject(chatRagConfig.rerankerRawBody) ? chatRagConfig.rerankerRawBody : {};
  const protectedKeys = new Set(["model", "query", "documents", "top_n", "return_documents", "instruction"]);
  for (const [key, value] of Object.entries(rawBody)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey || protectedKeys.has(normalizedKey)) continue;
    if (value === undefined) continue;
    body[normalizedKey] = value;
  }

  return body;
}

// Maps an upstream rerank response into a relevance-scored, desc-sorted list
// aligned to the input documents by their original index.
function normalizeScoredResults(results, documentCount) {
  const list = Array.isArray(results) ? results : [];
  const scored = [];

  for (const entry of list) {
    const index = Number(entry?.index);
    const relevanceScore = Number(entry?.relevance_score ?? entry?.relevanceScore ?? entry?.score);
    if (!Number.isInteger(index) || index < 0 || index >= documentCount) continue;
    if (!Number.isFinite(relevanceScore)) continue;
    scored.push({ index, relevanceScore });
  }

  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return scored;
}

async function rerankDocuments({ query, documents, signal } = {}) {
  if (!chatRagConfig.enabled) throw new Error("Chat RAG is disabled");
  if (!chatRagConfig.rerankerEnabled) throw new Error("Chat RAG reranker is disabled");
  if (chatRagConfig.rerankerProvider !== "openai-compatible") {
    throw new Error(`Unsupported reranker provider: ${chatRagConfig.rerankerProvider}`);
  }

  const normalizedQuery = String(query || "").trim();
  const list = Array.isArray(documents)
    ? documents.map((document) => clipDocument(document, chatRagConfig.rerankerMaxDocumentChars))
    : [];
  if (!normalizedQuery) throw new Error("Rerank query must be a non-empty string");
  if (!list.length || list.some((document) => !document)) {
    throw new Error("Rerank documents must be a non-empty list of non-empty strings");
  }

  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new Error("Reranker request timeout")),
    chatRagConfig.rerankerTimeoutMs
  );
  const abortFromParent = () => abortController.abort(signal?.reason || new Error("Request cancelled"));
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });

  const url = buildUrl(chatRagConfig.rerankerBaseUrl, "rerank");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${chatRagConfig.rerankerApiKey}`,
      },
      body: JSON.stringify(buildRerankBody({ query: normalizedQuery, documents: list, topN: list.length })),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const { json, text } = await readJsonSafe(response);
      const error = new Error(pickErrorMessage({ status: response.status, json, text }));
      error.status = response.status;
      error.upstream = "reranker";
      throw error;
    }

    const data = await response.json();
    return normalizeScoredResults(data?.results, list.length);
  } catch (error) {
    if (error?.upstream === "reranker") throw error;

    const wrapped = new Error(`Reranker request failed before HTTP response: ${error?.message || String(error)}`);
    wrapped.name = error?.name || "RerankerNetworkError";
    wrapped.cause = error;
    wrapped.upstream = "reranker";
    wrapped.retryable = true;
    wrapped.url = url;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

module.exports = {
  rerankDocuments,
  clipDocument,
  normalizeScoredResults,
};
