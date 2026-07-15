const test = require("node:test");
const assert = require("node:assert/strict");

const configPath = require.resolve("../../config");
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { llmConfig: { timeoutMs: 1000 } } };
const openai = require("../../services/llm/adapters/openaiCompatible/chatCompletions");
const anthropic = require("../../services/llm/adapters/anthropicMessages/chatCompletions");

function bodyFromChunks(chunks) {
  return (async function* stream() {
    for (const chunk of chunks) yield Buffer.from(chunk);
  })();
}

async function collect(iterator) {
  const values = [];
  for await (const value of iterator) values.push(value);
  return values;
}

test("OpenAI SSE accepts LF, CRLF, CR, comments, chunk splits, multi-data and an EOF tail", async () => {
  const first = JSON.stringify({ choices: [{ delta: { content: "一" } }] });
  const second = JSON.stringify({ choices: [{ delta: { content: "二" } }] });
  const multiline = `${second.slice(0, 20)}\n${second.slice(20)}`;
  const chunks = [
    `: keepalive\r\ndata: ${first}\r`,
    `\n\r\ndata: ${multiline.split("\n")[0]}\rdata: ${multiline.split("\n")[1]}\r\rdata: [DO`,
    `NE]`,
  ];
  assert.deepEqual(await collect(openai.streamChatCompletionDeltas({ response: { body: bodyFromChunks(chunks) } })), ["一", "二"]);
});

test("OpenAI SSE parses a valid JSON frame at EOF without a trailing blank line", async () => {
  const payload = JSON.stringify({ choices: [{ delta: { content: "尾帧" } }] });
  const byteChunks = [...Buffer.from(`data: ${payload}`)].map((byte) => Buffer.from([byte]));
  assert.deepEqual(
    await collect(openai.streamChatCompletionDeltas({ response: { body: bodyFromChunks(byteChunks) } })),
    ["尾帧"],
  );
});

test("Anthropic SSE accepts CRLF and flushes its EOF tail", async () => {
  const start = JSON.stringify({ type: "content_block_start", content_block: { type: "text", text: "A" } });
  const delta = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "B" } });
  const result = await collect(anthropic.streamChatCompletionDeltas({
    response: { body: bodyFromChunks([`: ping\r\ndata: ${start}\r\n\r\ndata: ${delta}`]) },
  }));
  assert.deepEqual(result, [{ type: "delta", delta: "A" }, { type: "delta", delta: "B" }]);
});
