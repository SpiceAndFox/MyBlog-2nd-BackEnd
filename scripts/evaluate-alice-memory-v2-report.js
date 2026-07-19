#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { evaluateAliceTaskReplay } = require("../evals/memory-v2/aliceAssertions");

function parseArgs(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
  if (argv.length !== 2 || argv[0] !== "--report" || !String(argv[1]).trim()) {
    throw new Error("Usage: npm run eval:memory-v2:alice -- --report <shadow-report.json>");
  }
  return { help: false, report: path.resolve(String(argv[1]).trim()) };
}

function printUsage(stream = process.stdout) {
  stream.write([
    "Usage:",
    "  npm run eval:memory-v2:alice -- --report <shadow-report.json>",
    "",
    "Evaluates a previously generated generic task shadow replay report against the Alice cases.",
    "",
  ].join("\n"));
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return { status: "help" };
  }
  const readFile = dependencies.readFile || fs.readFile;
  const report = JSON.parse(await readFile(options.report, "utf8"));
  const result = evaluateAliceTaskReplay(report);
  process.stdout.write(`${JSON.stringify({ evaluation: "alice", report: options.report, result }, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, printUsage, main };
