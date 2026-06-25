'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPTS = [
  'render-templates.verify.js',
  'scope-boundary.verify.js',
  'embedding-templates.verify.js',
  'header-trim.verify.js',
  'params.verify.js',
  'migration.verify.js',
  'chunker.verify.js',
  'indexer.verify.js',
  'repo.verify.js',
  'wave2-integration.verify.js',
  'mmr-config.verify.js',
  'mmr.verify.js',
  'reranker-integration.verify.js',
  'wave3-integration.verify.js',
];

const nodeBin = process.execPath;
const dir = __dirname;

let ok = 0;

for (const script of SCRIPTS) {
  const scriptPath = path.join(dir, script);
  const result = spawnSync(nodeBin, ['--use-env-proxy', scriptPath], {
    stdio: 'inherit',
  });

  if (result.status === 0) {
    ok += 1;
    console.log(`${script}: OK`);
  } else {
    console.log(`${script}: FAIL (exit ${result.status})`);
  }
}

console.log(`${ok}/${SCRIPTS.length} OK`);
process.exit(ok === SCRIPTS.length ? 0 : 1);
