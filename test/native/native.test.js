'use strict';

// The optional native layer (lib/native.js) against the REAL libpolycall,
// loaded through node:ffi: version + ABI check, polycall_strerror,
// polycall_last_error (per thread), polycall_ffi_run_config (valid, missing,
// invalid, strict, unsupported TLS, non-ASCII path), polycall_ffi_describe,
// polycall_call against `polycall start` / `polycall daemon start`, loader
// errors (missing library, a library without the ABI v1 symbols, ABI
// mismatch) and concurrent use from worker threads.
//
// Needs Node.js >= 26 with --experimental-ffi (test/run.js passes it) and
// the library ($POLYCALL_LIBRARY or the platform name). Without them the
// suite is reported as SKIPPED with the reason; POLYCALL_REQUIRE_NATIVE=1
// turns that into a failure.

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const polycall = require('../..');
const {
  findCli, findNative, nativeSuite, coreSuite, buildFakeLibrary, tempDir, runCli, randomToken,
  startRuntime, startDaemon, deadEndpoint
} = require('../helpers');

const { Status, native } = polycall;
const nativeInfo = findNative();
const cliInfo = findCli();
const { lib } = nativeInfo;

const VALID_RC = 'log_level=info\nmax_connections=100\nnetwork_timeout=5000\ntls_enabled=false\n';
const UNKNOWN_KEY_RC = 'log_level=info\nnot_a_polycall_key=1\n';
const MALFORMED_RC = 'this is not = a = valid line\n';
const TLS_INCOMPLETE_RC = 'log_level=info\ntls_enabled=true\n';
const TLS_COMPLETE_RC = 'log_level=info\ntls_enabled=true\ncert_file=/etc/polycall/cert.pem\nkey_file=/etc/polycall/key.pem\n';

function expectError(fn, status, check) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof polycall.PolycallError, `not a PolycallError: ${error && error.stack}`);
    assert.equal(error.status, status, `${error.message}`);
    assert.equal(error.code, polycall.statusName(status));
    if (check) check(error);
    return true;
  });
}

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker.js'), { workerData });
    let message;
    worker.once('message', (m) => { message = m; });
    worker.once('error', reject);
    worker.once('exit', (code) => (code === 0 ? resolve(message) : reject(new Error(`worker exited ${code}`))));
  });
}

nativeSuite('native layer vs the real libpolycall (node:ffi)', nativeInfo, () => {
  let dir;
  const file = (name, text) => {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (text !== undefined) fs.writeFileSync(target, text);
    return target;
  };
  before(() => { dir = tempDir('native'); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('library version + ABI check; every ABI v1 symbol resolved up front', async () => {
    assert.equal(lib.abiVersion(), 1);
    assert.equal(native.ABI_VERSION, 1);
    assert.match(lib.version(), /^1\.\d+\.\d+$/);
    assert.ok(lib.version() >= '1.1.0', `library ${lib.version()} predates binding ABI 1`);
    assert.deepEqual([...native.SYMBOLS].sort(), ['polycall_call', 'polycall_ffi_abi_version', 'polycall_ffi_describe',
      'polycall_ffi_run_config', 'polycall_ffi_version', 'polycall_last_error', 'polycall_strerror']);
    if (cliInfo.cli) {
      const cliVersion = (await runCli(cliInfo.cli, ['--version'])).stdout.toString('utf8');
      assert.ok(cliVersion.includes(lib.version()), `CLI ${cliVersion.trim()} vs library ${lib.version()}`);
    }
  });

  test('polycall_strerror: the library and the JS table agree for every code', () => {
    for (let code = -25; code <= 1; code += 1) {
      assert.equal(lib.strerror(code), polycall.strerror(code), `code ${code}`);
    }
    for (const code of [12345, -2147483648, 2147483647]) assert.equal(lib.strerror(code), polycall.strerror(code));
    assert.equal(lib.strerror(-4), 'POLYCALL_E_TIMEOUT: deadline exceeded');
    expectError(() => lib.strerror(1.5), Status.E_INVALID_ARGUMENT);
  });

  test('run_config: valid (strict), missing, NULL / empty, malformed -> status + name + detail', () => {
    assert.equal(lib.runConfig(file('ok/node-polycallrc', VALID_RC)), Status.OK);
    assert.equal(lib.lastError(), '', 'a successful call clears the detail');
    assert.equal(lib.runConfig(file('ok/node-polycallrc'), false), Status.OK);
    const missing = path.join(dir, 'missing', 'node-polycallrc');
    expectError(() => lib.runConfig(missing), Status.E_NOT_FOUND, (error) => {
      assert.ok(error.detail.includes(missing), error.detail);
      assert.equal(error.strerror, 'POLYCALL_E_NOT_FOUND: not found');
      assert.equal(error.native, true);
      assert.equal(error.library, lib.path);
    });
    expectError(() => lib.runConfig(null), Status.E_INVALID_ARGUMENT, (error) => assert.match(error.detail, /NULL|empty/i));
    expectError(() => lib.runConfig(''), Status.E_INVALID_ARGUMENT);
    expectError(() => lib.runConfig('a\0b'), Status.E_INVALID_ARGUMENT);
    expectError(() => lib.runConfig(file('bad/node-polycallrc', MALFORMED_RC)), Status.E_CONFIG,
      (error) => assert.match(error.detail, /malformed/i));
  });

  test('run_config strict vs validate: unknown key, incomplete and complete TLS', () => {
    const unknown = file('unknown/node-polycallrc', UNKNOWN_KEY_RC);
    assert.equal(lib.runConfig(unknown, false), Status.OK, 'validate mode: unknown key is a warning');
    expectError(() => lib.runConfig(unknown), Status.E_CONFIG, (error) => assert.match(error.detail, /not_a_polycall_key/));
    expectError(() => lib.runConfig(file('tls1/node-polycallrc', TLS_INCOMPLETE_RC)), Status.E_CONFIG);
    const tls = file('tls2/node-polycallrc', TLS_COMPLETE_RC);
    assert.equal(lib.runConfig(tls, false), Status.OK);
    expectError(() => lib.runConfig(tls), Status.E_UNSUPPORTED, (error) => assert.match(error.detail, /TLS/i));
  });

  test('non-ASCII configuration paths (UTF-8 end to end, incl. the detail text)', () => {
    const name = path.join('ünïcödé-Ωμέγα-漢字-🚀', 'node-polycallrc');
    const target = file(name, VALID_RC);
    assert.equal(lib.runConfig(target), Status.OK);
    assert.equal(lib.describe(target).values.log_level, 'info');
    const missing = path.join(dir, 'ünïcödé-Ωμέγα-漢字-🚀', 'nope', 'node-polycallrc');
    expectError(() => lib.runConfig(missing), Status.E_NOT_FOUND, (error) => assert.ok(error.detail.includes(missing), error.detail));
    const strict = file(path.join('ünïcödé-Ωμέγα-漢字-🚀', 'unknown-polycallrc'), UNKNOWN_KEY_RC);
    expectError(() => lib.runConfig(strict), Status.E_CONFIG);
  });

  test('describe: JSON description; errors carry status and detail', () => {
    const described = lib.describe(file('describe/node-polycallrc', VALID_RC));
    assert.equal(typeof described, 'object');
    assert.deepEqual(described.values, { log_level: 'info', max_connections: '100', network_timeout: '5000', tls_enabled: 'false' });
    expectError(() => lib.describe(path.join(dir, 'nope', 'node-polycallrc')), Status.E_NOT_FOUND);
    expectError(() => lib.describe(''), Status.E_INVALID_ARGUMENT);
    // a description longer than the first (4 KiB) buffer is fetched again at full size;
    // 128 values is the core's limit per file (POLYCALL_CONFIG_MAX_VALUES)
    const keys = Array.from({ length: 128 }, (_, i) => `custom_key_${i}=${'v'.repeat(200)}${i}`);
    const big = lib.describe(file('describe-big/node-polycallrc', `${keys.join('\n')}\n`));
    assert.ok(JSON.stringify(big).length > 16 * 1024, 'description exceeds the first buffer');
    assert.equal(big.values.custom_key_127, `${'v'.repeat(200)}127`);
    assert.equal(Object.keys(big.values).length, 128);
    assert.equal(big.warnings, 128, 'unknown keys are warnings in describe');
    // 129 values -> E_CONFIG. (The detail is the file's first warning, not "too many
    // configuration values": a core diagnostic defect, reported upstream.)
    expectError(() => lib.describe(file('describe-129/node-polycallrc', `${[...keys, 'custom_key_x=1'].join('\n')}\n`)),
      Status.E_CONFIG, (error) => assert.notEqual(error.detail, ''));
  });

  test('polycall_last_error is per thread (worker threads)', async () => {
    const valid = file('thread/node-polycallrc', VALID_RC);
    const missing = path.join(dir, 'thread', 'missing-polycallrc');
    const mainMissing = path.join(dir, 'thread', 'main-only-polycallrc');
    expectError(() => lib.runConfig(mainMissing), Status.E_NOT_FOUND);
    const mainDetail = lib.lastError();
    assert.ok(mainDetail.includes(mainMissing));
    const r = await runWorker({ mode: 'thread-local', libraryPath: lib.path, valid, missing });
    assert.equal(r.failed.status, Status.E_NOT_FOUND);
    assert.ok(r.failed.lastError.includes(missing), r.failed.lastError);
    assert.equal(r.ok.status, 0);
    assert.equal(r.afterOk, '');
    assert.equal(lib.lastError(), mainDetail, 'the worker never touched the main thread\'s detail');
  });

  test('concurrent run_config from 4 worker threads (300 calls each)', async () => {
    const valid = file('conc/node-polycallrc', VALID_RC);
    const invalid = file('conc/bad-polycallrc', MALFORMED_RC);
    const results = await Promise.all([0, 1, 2, 3].map((n) => runWorker({
      mode: 'stress', libraryPath: lib.path, valid, invalid, missing: path.join(dir, 'conc', `missing-${n}-polycallrc`), iterations: 300
    })));
    for (const r of results) {
      assert.deepEqual(r.wrong, []);
      assert.equal(r.ok + r.notFound + r.config, 300);
    }
  });

  test('close: later calls -> E_INVALID_HANDLE; a second close is a no-op', () => {
    const second = native.load({ path: lib.path });
    assert.equal(second.abiVersion(), 1);
    second.close();
    assert.equal(second.closed, true);
    expectError(() => second.abiVersion(), Status.E_INVALID_HANDLE);
    expectError(() => second.runConfig('x'), Status.E_INVALID_HANDLE);
    second.close();
    assert.equal(lib.abiVersion(), 1, 'other handles keep working');
  });

  describe('loader errors: clear PolycallError, never a crash', () => {
    test('POLYCALL_LIBRARY is honoured first', () => {
      const viaEnv = native.load({ env: { POLYCALL_LIBRARY: lib.path } });
      assert.equal(viaEnv.path, lib.path);
      assert.equal(viaEnv.abiVersion(), 1);
    });

    test('missing library / not a library -> E_NOT_FOUND naming it (no fallback to another library)', () => {
      const missing = path.join(dir, process.platform === 'win32' ? 'no-such-polycall.dll' : 'libno-such-polycall.so.1');
      expectError(() => native.load({ path: missing }), Status.E_NOT_FOUND, (error) => {
        assert.equal(error.library, missing);
        assert.ok(error.message.includes(missing), error.message);
      });
      expectError(() => native.load({ env: { POLYCALL_LIBRARY: missing } }), Status.E_NOT_FOUND,
        (error) => assert.match(error.message, /POLYCALL_LIBRARY=/));
      const junk = file(process.platform === 'win32' ? 'junk/polycall.dll' : 'junk/libpolycall.so.1', 'not a shared library\n');
      expectError(() => native.load({ path: junk }), Status.E_NOT_FOUND);
    });

    test('a shared library without the ABI v1 symbols -> E_UNSUPPORTED naming the symbol', () => {
      const system = process.platform === 'win32' ? 'kernel32.dll' : process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';
      expectError(() => native.load({ path: system }), Status.E_UNSUPPORTED, (error) => {
        assert.equal(error.symbol, 'polycall_ffi_abi_version');
        assert.match(error.message, /binding ABI 1/);
      });
    });

    const fixtureDir = tempDir('fixtures');
    after(() => fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const old = buildFakeLibrary('old', fixtureDir);
    const abi2 = buildFakeLibrary('abi2', fixtureDir);
    const fixtureSkip = (built) => (built.path ? false : (nativeInfo.required ? false : built.reason));

    test('old 1.0-style library (no binding ABI v1 symbols) -> E_UNSUPPORTED', { skip: fixtureSkip(old) }, () => {
      assert.ok(old.path, old.reason);
      expectError(() => native.load({ path: old.path }), Status.E_UNSUPPORTED, (error) => {
        assert.equal(error.symbol, 'polycall_ffi_abi_version');
        assert.equal(error.library, old.path);
      });
    });

    test('ABI mismatch (polycall_ffi_abi_version() == 2) -> E_UNSUPPORTED', { skip: fixtureSkip(abi2) }, () => {
      assert.ok(abi2.path, abi2.reason);
      expectError(() => native.load({ path: abi2.path }), Status.E_UNSUPPORTED, (error) => {
        assert.equal(error.abi, 2);
        assert.match(error.message, /ABI 2; node-polycall needs ABI 1/);
      });
    });
  });

  coreSuite('callSync (polycall_call) vs `polycall start` and `polycall daemon start`', cliInfo, () => {
    let runtime;
    let daemon;
    const token = randomToken();
    before(async () => {
      runtime = await startRuntime(cliInfo.cli);
      daemon = await startDaemon(cliInfo.cli, { token });
    });
    after(async () => {
      if (runtime) await runtime.stop();
      if (daemon) await daemon.stop();
    });

    test('success; identical to the JS client and to `polycall call`', async () => {
      const out = lib.callSync(runtime.endpoint, 'inventory', 'get', '{"item_id":"widget-a"}', { timeoutMs: 5000 });
      assert.deepEqual(JSON.parse(out), { item_id: 'widget-a', quantity: 42, in_stock: true });
      assert.deepEqual(JSON.parse(out), await polycall.call(runtime.endpoint, 'inventory', 'get', { item_id: 'widget-a' }));
      const echo = lib.callSync(runtime.endpoint, 'debug', 'echo', JSON.stringify({ text: 'héllo – 漢字 – 🚀', n: [1, null] }));
      assert.deepEqual(JSON.parse(echo), { echo: { text: 'héllo – 漢字 – 🚀', n: [1, null] } });
      assert.equal(lib.callSync(runtime.endpoint, 'debug', 'echo', null), '{"echo":null}');
      assert.deepEqual(JSON.parse(lib.callSync(daemon.endpoint, 'debug', 'echo', '{"hi":"daemon"}')), { echo: { hi: 'daemon' } });
    });

    test('unknown operation -> E_NOT_FOUND with the remote error object', () => {
      expectError(() => lib.callSync(runtime.endpoint, 'nope', 'op', null), Status.E_NOT_FOUND, (error) => {
        assert.equal(error.remote.code, 'operation.unknown');
        assert.equal(JSON.parse(error.remoteJson).code, 'operation.unknown');
        assert.match(error.detail, /operation\.unknown/);
      });
    });

    test('deadline -> E_TIMEOUT (deadline.exceeded); invalid input -> E_REMOTE', () => {
      expectError(() => lib.callSync(runtime.endpoint, 'debug', 'sleep', '{"ms":2000}', { timeoutMs: 200 }), Status.E_TIMEOUT,
        (error) => assert.equal(error.remote.code, 'deadline.exceeded'));
      expectError(() => lib.callSync(runtime.endpoint, 'inventory', 'get', '{}'), Status.E_REMOTE,
        (error) => assert.equal(error.remote.code, 'input.invalid'));
      expectError(() => lib.callSync(daemon.endpoint, 'inventory', 'get', '{"item_id":"nope"}'), Status.E_REMOTE,
        (error) => assert.equal(error.remote.code, 'item.unknown'));
    });

    test('argument checks in the library: invalid JSON, timeout 0 / 600001, bad endpoint -> E_INVALID_ARGUMENT', () => {
      expectError(() => lib.callSync(runtime.endpoint, 'debug', 'echo', '{"a":'), Status.E_INVALID_ARGUMENT,
        (error) => assert.match(error.detail, /not valid JSON/));
      expectError(() => lib.callSync(runtime.endpoint, 'debug', 'echo', null, { timeoutMs: 0 }), Status.E_INVALID_ARGUMENT,
        (error) => assert.match(error.detail, /1\.\.600000/));
      expectError(() => lib.callSync(runtime.endpoint, 'debug', 'echo', null, { timeoutMs: 600001 }), Status.E_INVALID_ARGUMENT);
      // both ends of 1..600000 pass the argument check (1 ms may legitimately expire remotely)
      assert.equal(lib.callSync(runtime.endpoint, 'debug', 'echo', '7', { timeoutMs: 600000 }), '{"echo":7}');
      try {
        assert.equal(lib.callSync(runtime.endpoint, 'debug', 'echo', '7', { timeoutMs: 1 }), '{"echo":7}');
      } catch (error) {
        assert.equal(error.status, Status.E_TIMEOUT, error.message);
      }
      expectError(() => lib.callSync('nohostport', 'debug', 'echo', null), Status.E_INVALID_ARGUMENT);
      expectError(() => lib.callSync(runtime.endpoint, '', 'echo', null), Status.E_INVALID_ARGUMENT);
      expectError(() => lib.callSync(runtime.endpoint, 'debug', 'echo', null, { timeoutMs: -1 }), Status.E_INVALID_ARGUMENT);
    });

    test('too-small output buffer -> E_TOO_LARGE with the exact size needed', () => {
      const full = lib.callSync(runtime.endpoint, 'inventory', 'get', '{"item_id":"widget-b"}');
      const need = Buffer.byteLength(full);
      expectError(() => lib.callSync(runtime.endpoint, 'inventory', 'get', '{"item_id":"widget-b"}', { maxOutput: need - 1 }),
        Status.E_TOO_LARGE, (error) => assert.equal(error.needed, need));
      assert.equal(lib.callSync(runtime.endpoint, 'inventory', 'get', '{"item_id":"widget-b"}', { maxOutput: need }), full);
    });

    test('no runtime -> E_TRANSPORT', async () => {
      const dead = await deadEndpoint();
      expectError(() => lib.callSync(dead, 'debug', 'echo', null, { timeoutMs: 2000 }), Status.E_TRANSPORT);
    });
  });
});
