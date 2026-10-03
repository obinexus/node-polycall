'use strict';

// Test runner: `node test/run.js [unit|core]`. Lists the test files
// itself so the same command works on every supported Node version and shell.
//
// unit   adapter unit tests (no core needed)
// core   against the REAL C core through the polycall CLI (POLYCALL_CLI / PATH)
//
// A suite whose requirement is missing is reported as SKIPPED with the
// reason -- never as passed -- and this runner says so at the end.
// POLYCALL_REQUIRE_CLI=1 makes that a failure.

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
const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`,
  '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tapFile()}`, ...files],
{ stdio: 'inherit' });

function tapFile() {
  return path.join(require('node:os').tmpdir(), `node-polycall-test-${process.pid}.tap`);
}

let skipped = [];
try {
  const tap = fs.readFileSync(tapFile(), 'utf8');
  skipped = tap.split(/\r?\n/).filter((line) => /^\s*ok \d+ - .*# SKIP/.test(line)).map((line) => line.trim());
  fs.rmSync(tapFile(), { force: true });
} catch (_error) {
  // no TAP copy: the spec output above still lists skipped tests
}
if (skipped.length) {
  console.log(`\nnode-polycall: ${skipped.length} test(s) SKIPPED -- these were NOT verified on this run:`);
  for (const line of skipped) console.log(`  ${line}`);
}
process.exit(result.status === null ? 1 : result.status);
