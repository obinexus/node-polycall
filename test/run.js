'use strict';

// Test runner: `node test/run.js [unit|core]`. Lists the test files itself
// so the same command works on every supported Node version and shell.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const which = process.argv[2];
const groups = which ? [which] : ['unit', 'core'];
const files = [];
for (const group of groups) {
  const dir = path.join(__dirname, group);
  if (!fs.existsSync(dir)) {
    console.error(`unknown test group: ${group}`);
    process.exit(2);
  }
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.endsWith('.test.js')) files.push(path.join(dir, name));
  }
}
const reporter = process.env.NODE_POLYCALL_TEST_REPORTER || 'spec';
const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
