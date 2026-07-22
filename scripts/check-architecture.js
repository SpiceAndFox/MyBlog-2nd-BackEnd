const fs = require("node:fs");
const path = require("node:path");

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "archive",
  "devplans",
  "logs",
  "node_modules",
  "reports",
  "test",
  "uploads",
]);

const FROZEN_INTERNAL_IMPORT_DEBT = Object.freeze([]);

const ROOT_ENVIRONMENT_BOUNDARIES = new Set([
  "regenerateChatRag.js",
]);

function isEnvironmentBoundary(relativePath) {
  return relativePath.startsWith("app/composition/")
    || relativePath.startsWith("config/")
    || relativePath.startsWith("scripts/")
    || ROOT_ENVIRONMENT_BOUNDARIES.has(relativePath);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function listJavaScriptFiles(rootDir) {
  const files = [];

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.join(directory, entry.name));
    }
  }

  visit(rootDir);
  return files;
}

function extractStaticSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g,
    /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g,
    /\b(?:import|export)\s+(?:[^;"']*?\s+from\s+)?(["'])([^"']+)\1/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) specifiers.add(match[2]);
  }
  return [...specifiers];
}

function readAliases(rootDir) {
  const packagePath = path.join(rootDir, "package.json");
  if (!fs.existsSync(packagePath)) return {};
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return packageJson._moduleAliases || {};
}

function resolveJavaScriptTarget(candidate) {
  const candidates = [candidate, `${candidate}.js`, path.join(candidate, "index.js")];
  for (const current of candidates) {
    try {
      if (fs.statSync(current).isFile() && current.endsWith(".js")) return path.resolve(current);
    } catch {
      // A missing candidate is an external package, JSON asset, or optional path.
    }
  }
  return null;
}

function resolveLocalSpecifier({ importer, specifier, rootDir, aliases }) {
  let candidate = null;
  if (specifier.startsWith(".")) {
    candidate = path.resolve(path.dirname(importer), specifier);
  } else {
    const alias = Object.keys(aliases)
      .sort((left, right) => right.length - left.length)
      .find((name) => specifier === name || specifier.startsWith(`${name}/`));
    if (alias) {
      const suffix = specifier === alias ? "" : specifier.slice(alias.length + 1);
      candidate = path.resolve(rootDir, aliases[alias], suffix);
    }
  }
  if (!candidate) return null;

  const target = resolveJavaScriptTarget(candidate);
  if (!target) return null;
  const relative = path.relative(rootDir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

function moduleOwner(relativePath) {
  const parts = relativePath.split("/");
  return parts[0] === "modules" && parts.length >= 3 ? parts[1] : null;
}

function isModulePublicEntry(relativePath) {
  const parts = relativePath.split("/");
  return parts.length === 3
    && parts[0] === "modules"
    && ["index.js", "admin.js"].includes(parts[2]);
}

function debtKey(importer, target) {
  return `${importer} -> ${target}`;
}

function findCycles(graph) {
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];

  function visit(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graph.get(node) || []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);

    const selfCycle = component.length === 1 && (graph.get(component[0]) || new Set()).has(component[0]);
    if (component.length > 1 || selfCycle) cycles.push(component.sort());
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) visit(node);
  }
  return cycles.sort((left, right) => left[0].localeCompare(right[0]));
}

function analyzeArchitecture({
  rootDir = path.resolve(__dirname, ".."),
  allowedInternalImports = FROZEN_INTERNAL_IMPORT_DEBT,
} = {}) {
  const normalizedRoot = path.resolve(rootDir);
  const files = listJavaScriptFiles(normalizedRoot);
  const aliases = readAliases(normalizedRoot);
  const relativeByAbsolute = new Map(files.map((file) => [file, toPosix(path.relative(normalizedRoot, file))]));
  const graph = new Map([...relativeByAbsolute.values()].map((file) => [file, new Set()]));
  const allowedByKey = new Map(allowedInternalImports.map((entry) => [debtKey(entry.importer, entry.target), entry]));
  const observedDebt = new Set();
  const boundaryViolations = [];
  const environmentViolations = [];
  let edgeCount = 0;

  for (const importer of files) {
    const importerRelative = relativeByAbsolute.get(importer);
    const importerOwner = moduleOwner(importerRelative);
    const source = fs.readFileSync(importer, "utf8");
    if (/\bprocess\s*\.\s*env\b/.test(source) && !isEnvironmentBoundary(importerRelative)) {
      environmentViolations.push(`process.env is restricted to configuration/startup boundaries: ${importerRelative}`);
    }
    for (const specifier of extractStaticSpecifiers(source)) {
      const target = resolveLocalSpecifier({ importer, specifier, rootDir: normalizedRoot, aliases });
      if (!target || !relativeByAbsolute.has(target)) continue;
      const targetRelative = relativeByAbsolute.get(target);
      graph.get(importerRelative).add(targetRelative);
      edgeCount += 1;

      const targetOwner = moduleOwner(targetRelative);
      if (targetOwner && targetOwner !== importerOwner && !isModulePublicEntry(targetRelative)) {
        const key = debtKey(importerRelative, targetRelative);
        if (allowedByKey.has(key)) observedDebt.add(key);
        else boundaryViolations.push(`Internal module import is forbidden: ${key}`);
      }
      if (importerRelative.startsWith("shared/") && targetOwner) {
        boundaryViolations.push(`shared must not depend on a business module: ${debtKey(importerRelative, targetRelative)}`);
      }
      if (importerOwner && targetRelative.startsWith("app/composition/")) {
        boundaryViolations.push(`Business modules must not depend on app/composition: ${debtKey(importerRelative, targetRelative)}`);
      }
    }
  }

  const staleDebt = [...allowedByKey.keys()]
    .filter((key) => !observedDebt.has(key))
    .map((key) => `Frozen internal-import debt is stale and must be removed from the allowlist: ${key}`);
  const cycles = findCycles(graph);
  const cycleViolations = cycles.map((cycle) => `Circular local dependency: ${cycle.join(" -> ")} -> ${cycle[0]}`);

  return Object.freeze({
    files: [...graph.keys()].sort(),
    edgeCount,
    allowedInternalImports: [...observedDebt].sort(),
    boundaryViolations: [...new Set([...boundaryViolations, ...staleDebt])].sort(),
    cycles,
    environmentViolations: [...new Set(environmentViolations)].sort(),
    errors: [...new Set([...boundaryViolations, ...environmentViolations, ...staleDebt, ...cycleViolations])].sort(),
  });
}

function formatReport(result) {
  if (result.errors.length) {
    return [
      `Architecture check failed with ${result.errors.length} error(s):`,
      ...result.errors.map((error) => `- ${error}`),
    ].join("\n");
  }
  const lines = [
    `Architecture check passed (${result.files.length} JavaScript files, ${result.edgeCount} local dependency edges, no cycles).`,
  ];
  if (result.allowedInternalImports.length) {
    lines.push(`Frozen internal-import debt (${result.allowedInternalImports.length}, no additions allowed):`);
    lines.push(...result.allowedInternalImports.map((entry) => `- ${entry}`));
  }
  return lines.join("\n");
}

function runCli() {
  const result = analyzeArchitecture();
  const report = formatReport(result);
  (result.errors.length ? console.error : console.log)(report);
  if (result.errors.length) process.exitCode = 1;
}

if (require.main === module) runCli();

module.exports = {
  FROZEN_INTERNAL_IMPORT_DEBT,
  analyzeArchitecture,
  extractStaticSpecifiers,
  formatReport,
  isEnvironmentBoundary,
};
