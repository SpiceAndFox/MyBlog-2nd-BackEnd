const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FROZEN_INTERNAL_IMPORT_DEBT,
  analyzeArchitecture,
} = require("../../scripts/check-architecture");

test("the repository dependency graph has no cycles or unapproved module-internal imports", () => {
  const result = analyzeArchitecture();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.allowedInternalImports,
    FROZEN_INTERNAL_IMPORT_DEBT
      .map(({ importer, target }) => `${importer} -> ${target}`)
      .sort(),
  );
});

test("the architecture gate detects cycles and dependency-direction violations", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-architecture-gate-"));
  try {
    const fixtures = {
      "package.json": "{}",
      "cycle-a.js": 'require("./cycle-b");\n',
      "cycle-b.js": 'require("./cycle-a");\n',
      "modules/chat/index.js": 'require("../memory/internal");\n',
      "modules/memory/index.js": "module.exports = {};\n",
      "modules/memory/internal.js": "module.exports = {};\n",
      "shared/clock.js": 'require("../modules/memory");\n',
      "app/composition/index.js": "module.exports = {};\n",
      "modules/chat/application/useCase.js": 'require("../../../app/composition");\n',
      "services/leaky-config.js": "module.exports = process.env.SECRET;\n",
      "config/allowed.js": "module.exports = process.env.ALLOWED;\n",
    };
    for (const [relativePath, source] of Object.entries(fixtures)) {
      const target = path.join(rootDir, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }

    const result = analyzeArchitecture({ rootDir, allowedInternalImports: [] });
    assert.match(result.errors.join("\n"), /Internal module import is forbidden: modules\/chat\/index\.js -> modules\/memory\/internal\.js/);
    assert.match(result.errors.join("\n"), /shared must not depend on a business module/);
    assert.match(result.errors.join("\n"), /Business modules must not depend on app\/composition/);
    assert.match(result.errors.join("\n"), /process\.env is restricted.*services\/leaky-config\.js/);
    assert.doesNotMatch(result.errors.join("\n"), /config\/allowed\.js/);
    assert.equal(result.cycles.length, 1);
    assert.deepEqual(result.cycles[0], ["cycle-a.js", "cycle-b.js"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the migrated Chat HTTP adapter has no direct persistence, config, filesystem, or runtime authority", () => {
  const rootDir = path.resolve(__dirname, "../..");
  const source = fs.readFileSync(path.join(rootDir, "controllers/chatController.js"), "utf8");
  for (const forbidden of [
    /@models|models\/chat/,
    /services\/chat\/(?:memoryRuntime|scopeCoordinator|gistPipeline|avatarStorage|trashCleanup)/,
    /require\(["'](?:node:)?(?:fs|path|crypto)["']\)/,
    /require\(["']sharp["']\)/,
    /require\(["']\.\.\/config["']\)/,
  ]) assert.doesNotMatch(source, forbidden);

  for (const retiredPath of [
    "models/chatModel.js",
    "models/chatPresetModel.js",
    "models/chatMessageGistModel.js",
    "services/chat/gistPipeline.js",
    "services/chat/avatarStorage.js",
    "services/chat/trashCleanup.js",
  ]) assert.equal(fs.existsSync(path.join(rootDir, retiredPath)), false, `${retiredPath} should stay retired`);
});
