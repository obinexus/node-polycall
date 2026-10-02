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
 * Returns {cli, reason}; cli is null (with the reason) when unavailable.
 * With POLYCALL_REQUIRE_CLI=1 a missing CLI is an error, not a skip.
 */
function findCli() {
  const explicit = process.env.POLYCALL_CLI;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`POLYCALL_CLI=${explicit} does not exist`);
    return { cli: explicit, reason: '' };
  }
  const probe = spawnSync('polycall', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0) return { cli: 'polycall', reason: '' };
  const reason = 'polycall CLI not available (set POLYCALL_CLI or put polycall on PATH)';
  if (process.env.POLYCALL_REQUIRE_CLI === '1') throw new Error(reason);
  return { cli: null, reason };
}

/**
 * describe() for a suite that needs the real core. Without a CLI the suite
 * is registered as ONE skipped test carrying the reason, so the run summary
 * counts it under 'skipped' instead of silently showing nothing.
 */
function coreSuite(name, cliInfo, body) {
  const { describe, test } = require('node:test');
  if (cliInfo.cli) return describe(name, body);
  return test(name, { skip: cliInfo.reason }, () => {});
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
  const proc = spawn(cli, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const proc = spawn(cli, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  fs.writeFileSync(polycallfile, 'daemon_endpoint=127.0.0.1:0\ntls_enabled=false\n');
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
  findCli, coreSuite, randomToken, tempDir, runCli, waitFor,
  startPeerServe, startRuntime, startDaemon, deadEndpoint, standardPayloads
};
