'use strict';

// Helpers for the tests that run against the REAL Polycall core: the
// `polycall` CLI (C) serving peer nodes, `polycall start` and
// `polycall daemon start`. Nothing here mocks the core.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync, execFile } = require('node:child_process');

/**
 * The polycall CLI to test against: $POLYCALL_CLI, else `polycall` on PATH.
 * Returns {cli, reason, required}; cli is null (with the reason) when
 * unavailable. POLYCALL_REQUIRE_CLI=1 sets `required`: coreSuite() then
 * registers a FAILING test instead of a skipped one.
 */
function findCli() {
  const required = process.env.POLYCALL_REQUIRE_CLI === '1';
  const explicit = process.env.POLYCALL_CLI;
  if (explicit) {
    if (!fs.existsSync(explicit)) return { cli: null, reason: `POLYCALL_CLI=${explicit} does not exist`, required: true };
    return { cli: explicit, reason: '', required };
  }
  const probe = spawnSync('polycall', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0) return { cli: 'polycall', reason: '', required };
  return { cli: null, reason: 'polycall CLI not available (set POLYCALL_CLI or put polycall on PATH)', required };
}

/**
 * describe() for a suite that needs the real core. When what it needs is
 * missing the suite is ONE test carrying the reason: skipped (counted under
 * 'skipped', never 'pass'), or failed when the requirement was made
 * mandatory (POLYCALL_REQUIRE_CLI=1 / POLYCALL_REQUIRE_NATIVE=1, or an
 * explicitly configured path that does not exist).
 */
function requirementSuite(name, info, ready, body) {
  const { describe, test } = require('node:test');
  if (ready) return describe(name, body);
  if (info.required) {
    return test(`${name} -- REQUIRED but unavailable`, () => {
      throw new Error(`${info.reason} (required: this is a failure, not a skip)`);
    });
  }
  return test(name, { skip: info.reason }, () => {});
}

function coreSuite(name, cliInfo, body) {
  return requirementSuite(name, cliInfo, Boolean(cliInfo.cli), body);
}

/**
 * The real libpolycall through node-polycall's native layer: $POLYCALL_LIBRARY,
 * else the platform name. Returns {lib, reason, required}; POLYCALL_REQUIRE_NATIVE=1
 * makes an unavailable library (or a Node.js without node:ffi) a failure.
 */
function findNative() {
  const native = require('../lib/native');
  const required = process.env.POLYCALL_REQUIRE_NATIVE === '1';
  const ffi = native.available();
  if (!ffi.ok) return { lib: null, reason: ffi.reason, required };
  try {
    return { lib: native.load(), reason: '', required };
  } catch (error) {
    return { lib: null, reason: `libpolycall not loadable: ${error.message}`, required: required || Boolean(process.env.POLYCALL_LIBRARY) };
  }
}

function nativeSuite(name, nativeInfo, body) {
  return requirementSuite(name, nativeInfo, Boolean(nativeInfo.lib), body);
}

/**
 * Compile test/fixtures/fake_polycall.c into a shared library with $CC (or
 * cc / gcc on PATH). kind 'old' = a 1.0-style library without the ABI v1
 * symbols, 'abi2' = all symbols but polycall_ffi_abi_version() == 2.
 * Returns {path, reason}; path is null (with the reason) without a compiler.
 */
function buildFakeLibrary(kind, dir) {
  const source = path.join(__dirname, 'fixtures', 'fake_polycall.c');
  const ext = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
  const out = path.join(dir, `fake-${kind}${ext}`);
  const compilers = process.env.CC ? [process.env.CC] : ['cc', 'gcc'];
  const args = ['-shared', ...(process.platform === 'win32' ? [] : ['-fPIC']),
    ...(kind === 'abi2' ? ['-DFAKE_ABI=2'] : []), '-o', out, source];
  const tried = [];
  for (const cc of compilers) {
    const r = spawnSync(cc, args, { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && fs.existsSync(out)) return { path: out, reason: '' };
    tried.push(`${cc}: ${r.error ? r.error.code || r.error.message : (r.stderr || `exit ${r.status}`).trim()}`);
  }
  return { path: null, reason: `no C compiler to build the ${kind} fixture library (set CC): ${tried.join('; ')}` };
}

// The CLI appends telemetry to ./.polycall/ of its working directory; run it
// from a scratch directory so tests never write into the repository.
let cliCwd = null;
function cliWorkDir() {
  if (!cliCwd) cliCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'node-polycall-cwd-'));
  return cliCwd;
}

function randomToken() {
  return `t-${crypto.randomBytes(12).toString('hex')}`;
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `node-polycall-${prefix}-`));
}

/** Run the CLI asynchronously (never spawnSync: the in-process node must keep serving). */
function runCli(cli, args, { env = {}, input, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cli, args, {
      env: { ...process.env, ...env },
      encoding: 'buffer',
      cwd: cliWorkDir(),
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout,
        stderr: stderr.toString('utf8')
      });
    });
    // a CLI that exits before reading stdin closes the pipe: that EPIPE is its own
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE' && error.code !== 'EOF') throw error; });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function waitFor(predicate, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error(`timed out waiting for ${what}`)); return; }
      setTimeout(tick, 25);
    };
    tick();
  });
}

/**
 * `polycall peer serve` (the C library's peer node). With printMessages the
 * node drains its inbox and prints each message (from, id, exact bytes as
 * base64) as a JSON line, which the tests parse.
 */
async function startPeerServe(cli, { nodeId, token = '', printMessages = false, peers = [] }) {
  const args = ['peer', 'serve', '--node-id', nodeId, '--endpoint', '127.0.0.1:0'];
  for (const peer of peers) args.push('--peer', peer);
  if (printMessages) args.push('--print-messages');
  const env = { ...process.env, POLYCALL_DEV_TOKEN: token };
  if (!token) delete env.POLYCALL_DEV_TOKEN;
  const proc = spawn(cli, args, { env, cwd: cliWorkDir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];
  let buffer = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) events.push(JSON.parse(line));
    }
  });
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  const listening = await waitFor(() => events.find((event) => event.event === 'listening') ||
    (proc.exitCode !== null && Promise.reject(new Error(`peer serve exited: ${stderr}`))), 10000, 'peer serve');
  return {
    proc,
    nodeId,
    endpoint: listening.endpoint,
    events,
    messages: () => events.filter((event) => event.event === 'message'),
    async waitForMessage(id, timeoutMs = 10000) {
      return waitFor(() => events.find((event) => event.event === 'message' && event.id === id), timeoutMs, `message ${id}`);
    },
    stderr: () => stderr,
    async stop() {
      if (proc.exitCode !== null) return;
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill();
      await exited;
    }
  };
}

/** `polycall start` on an ephemeral loopback port. */
async function startRuntime(cli, { authToken } = {}) {
  const dir = tempDir('rt');
  const endpointFile = path.join(dir, 'endpoint');
  const args = ['start', '--endpoint', '127.0.0.1:0', '--endpoint-file', endpointFile];
  if (authToken) args.push('--auth-token', authToken);
  const proc = spawn(cli, args, { cwd: cliWorkDir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  proc.stdout.resume();
  const endpoint = await waitFor(() => {
    if (proc.exitCode !== null) throw new Error(`polycall start exited ${proc.exitCode}: ${stderr}`);
    if (!fs.existsSync(endpointFile)) return null;
    const text = fs.readFileSync(endpointFile, 'utf8').trim();
    return text.includes(':') ? text : null;
  }, 10000, 'polycall start');
  return {
    proc,
    endpoint,
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise((resolve) => proc.once('exit', resolve));
        const args2 = ['stop', '--endpoint', endpoint];
        if (authToken) args2.push('--auth-token', authToken);
        await runCli(cli, args2, { timeoutMs: 10000 });
        const timer = setTimeout(() => proc.kill(), 5000);
        await exited;
        clearTimeout(timer);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** `polycall daemon start` for a temporary Polycallfile. */
async function startDaemon(cli, { token }) {
  const dir = tempDir('daemon');
  const polycallfile = path.join(dir, 'Polycallfile');
  // explicit ephemeral endpoint and a private state directory (relative to
  // the Polycallfile, so start/status/stop agree): never the shared
  // 127.0.0.1:8084 default, never another process's state
  fs.writeFileSync(polycallfile, 'daemon_endpoint=127.0.0.1:0\ndaemon_state_dir=state\ntls_enabled=false\n');
  const env = { POLYCALL_DEV_TOKEN: token };
  const started = await runCli(cli, ['daemon', 'start', polycallfile, '--timeout-ms', '10000'], { env });
  if (started.status !== 0) throw new Error(`daemon start failed (${started.status}): ${started.stderr}`);
  const status = await runCli(cli, ['--format', 'json', 'daemon', 'status', polycallfile], { env });
  const parsed = JSON.parse(status.stdout.toString('utf8'));
  return {
    endpoint: parsed.data.endpoint,
    status: parsed.data,
    async stop() {
      const stopped = await runCli(cli, ['daemon', 'stop', polycallfile], { env, timeoutMs: 20000 });
      fs.rmSync(dir, { recursive: true, force: true });
      return stopped;
    }
  };
}

/** A loopback port with nothing listening on it (for "dead peer" checks). */
async function deadEndpoint() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `127.0.0.1:${port}`;
}

/** Payloads every interop test sends (name -> exact bytes). */
function standardPayloads() {
  const allBytes = Buffer.alloc(256);
  for (let i = 0; i < 256; i += 1) allBytes[i] = i;
  const mib = Buffer.alloc(1 << 20);
  for (let i = 0; i < mib.length; i += 1) mib[i] = (i * 31 + 7) & 0xff;
  return {
    empty: Buffer.alloc(0),
    utf8: Buffer.from('héllo wörld – Ωμέγα – 漢字 – 🚀', 'utf8'),
    binaryNul: Buffer.concat([Buffer.from([0, 0, 1, 0]), allBytes, Buffer.from([0])]),
    exactlyOneMiB: mib
  };
}

module.exports = {
  findCli, coreSuite, findNative, nativeSuite, buildFakeLibrary, randomToken, tempDir, runCli, waitFor,
  startPeerServe, startRuntime, startDaemon, deadEndpoint, standardPayloads
};
