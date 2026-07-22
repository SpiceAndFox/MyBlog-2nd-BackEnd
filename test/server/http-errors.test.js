const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

function replaceModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const logged = [];
replaceModule("../../logger", {
  logger: { error(event, detail) { logged.push([event, detail]); } },
  withRequestContext(_req, detail) { return detail; },
});
const errorHandler = require("../../middleware/errorHandler");

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

async function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("the global error adapter preserves existing error statuses and redacts details", async () => {
  const app = express();
  app.get("/unexpected", (_req, _res, next) => next(new Error("database secret")));
  app.get("/unprocessable", (_req, res, next) => {
    res.status(422);
    next(new Error("validation detail"));
  });
  app.use(errorHandler);
  const server = await listen(app);
  const { port } = server.address();
  try {
    const unexpected = await fetch(`http://127.0.0.1:${port}/unexpected`);
    assert.equal(unexpected.status, 500);
    assert.deepEqual(await unexpected.json(), { error: "Internal Server Error" });

    const unprocessable = await fetch(`http://127.0.0.1:${port}/unprocessable`);
    assert.equal(unprocessable.status, 422);
    assert.deepEqual(await unprocessable.json(), { error: "Internal Server Error" });
    assert.deepEqual(logged.map(([event, detail]) => [event, detail.statusCode]), [
      ["request_error", 500],
      ["request_error", 422],
    ]);
  } finally {
    await close(server);
  }
});

test("the global error adapter delegates when response headers were already sent", () => {
  const failure = new Error("stream failed");
  let delegated = null;
  errorHandler(failure, {}, { statusCode: 200, headersSent: true }, (error) => { delegated = error; });
  assert.equal(delegated, failure);
});
