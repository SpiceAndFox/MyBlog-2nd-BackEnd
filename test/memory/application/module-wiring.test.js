const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const memoryEntry = require("../../../modules/memory");

function injectedPorts() {
  return {
    database: {
      async query() { return { rows: [], rowCount: 0 }; },
      async getClient() { throw new Error("not expected"); },
    },
    sourceReader: {
      async getByIds() { return []; },
      async listUpTo() { return []; },
      async getBoundary() { return 0; },
    },
    userTimeZoneReader: { async getTimeZone() { return "UTC"; } },
  };
}

test("Memory runtime entry is minimal and creates no cached default runtime", () => {
  assert.deepEqual(Object.keys(memoryEntry).sort(), ["createMemoryModule", "loadMemoryV2Config"]);
  const memory = memoryEntry.createMemoryModule(injectedPorts());
  const first = memory.createRuntime({ config: { enabled: false } });
  const second = memory.createRuntime({ config: { enabled: false } });
  assert.notEqual(first, second);
  assert.equal(first.enabled, false);
  assert.throws(
    () => memory.createContextAssembly({ config: { enabled: true }, recentWindowMaxChars: 1000 }),
    /explicitly created runtime/,
  );
});

test("Memory owns no Chat/Auth SQL and its domain Compiler performs no Repository I/O", () => {
  const memoryRoot = path.resolve(__dirname, "../../../modules/memory");
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(target);
    }
  };
  visit(memoryRoot);
  const memorySource = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(memorySource, /\b(?:chat_messages|chat_sessions)\b/);
  assert.doesNotMatch(memorySource, /\bFROM\s+users\b/i);

  const compiler = fs.readFileSync(path.join(memoryRoot, "domain/semanticCompiler.js"), "utf8");
  assert.doesNotMatch(compiler, /\b(?:async|await)\b/);
  assert.doesNotMatch(compiler, /\b(?:sourceReader|sourceRepository|getByIds)\b/);
});
