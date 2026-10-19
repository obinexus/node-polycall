'use strict';

// polycall_rpc v1 client against the REAL runtime: `polycall start` and
// `polycall daemon start` from the C core. Skipped (reported as SKIP) only
// when no polycall CLI is available; POLYCALL_REQUIRE_CLI=1 makes that fatal.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const polycall = require('../..');
const { findCli, coreSuite, randomToken, runCli, startRuntime, startDaemon, deadEndpoint } = require('../helpers');

const { Status } = polycall;
const cliInfo = findCli();
const { cli } = cliInfo;

coreSuite('RPC client vs `polycall start` (C runtime)', cliInfo, () => {
  let runtime;
  let cliVersion;
  before(async () => {
    runtime = await startRuntime(cli);
    cliVersion = (await runCli(cli, ['--version'])).stdout.toString('utf8');
  });
  after(async () => { if (runtime) await runtime.stop(); });

  test('runtime version + ABI check over CONTROL', async () => {
    const info = await polycall.runtimeInfo(runtime.endpoint);
    assert.match(info.version, /^\d+\.\d+\.\d+$/);
    assert.ok(cliVersion.includes(info.version), `CLI says ${cliVersion.trim()}, runtime says ${info.version}`);
    assert.equal(typeof info.abi, 'number');
    const ping = await polycall.control(runtime.endpoint, 'ping');
    assert.equal(ping.pong, true);
    const described = await polycall.control(runtime.endpoint, 'describe');
    assert.ok(JSON.stringify(described).includes('inventory'), JSON.stringify(described));
  });

  test('success: inventory.get', async () => {
    assert.deepEqual(await polycall.call(runtime.endpoint, 'inventory', 'get', { item_id: 'widget-a' }),
      { item_id: 'widget-a', quantity: 42, in_stock: true });
    assert.deepEqual(await polycall.call(runtime.endpoint, 'inventory', 'get', { item_id: 'gadget-c' }),
      { item_id: 'gadget-c', quantity: 0, in_stock: false });
  });

  test('RESPONSE bytes identical to `polycall call` (C client)', async () => {
    const raw = await polycall.callRaw(runtime.endpoint, 'inventory', 'get', { item_id: 'widget-b' }, { timeoutMs: 2000 });
    const c = await runCli(cli, ['call', 'inventory', 'get', '--endpoint', runtime.endpoint,
      '--input-value', '{"item_id":"widget-b"}', '--timeout-ms', '2000']);
    assert.equal(c.status, 0, c.stderr);
    assert.equal(raw, c.stdout.toString('utf8').trim());
  });

  test('debug.echo round-trips UTF-8 and nested JSON exactly', async () => {
    const input = { text: 'héllo – 漢字 – 🚀', nested: [1, 2.5, null, true, { k: 'v' }], empty: {}, quote: '"\\' };
    assert.deepEqual(await polycall.call(runtime.endpoint, 'debug', 'echo', input), { echo: input });
    assert.equal(await polycall.callJson(runtime.endpoint, 'debug', 'echo', '[1,"x"]'), '{"echo":[1,"x"]}');
    assert.equal(await polycall.callJson(runtime.endpoint, 'debug', 'echo', null), '{"echo":null}');
  });

  test('unknown operation -> E_NOT_FOUND (operation.unknown)', async () => {
    await assert.rejects(polycall.call(runtime.endpoint, 'nope', 'op', null), (error) => {
      assert.equal(error.status, Status.E_NOT_FOUND);
      assert.equal(error.remote.code, 'operation.unknown');
      return true;
    });
  });

  test('deadline -> E_TIMEOUT (deadline.exceeded); within deadline succeeds', async () => {
    await assert.rejects(polycall.call(runtime.endpoint, 'debug', 'sleep', { ms: 2000 }, { timeoutMs: 200 }), (error) => {
      assert.equal(error.status, Status.E_TIMEOUT);
      assert.equal(error.remote.code, 'deadline.exceeded');
      return true;
    });
    assert.deepEqual(await polycall.call(runtime.endpoint, 'debug', 'sleep', { ms: 50 }, { timeoutMs: 2000 }), { slept_ms: 50 });
  });

  test('invalid input -> E_REMOTE (input.invalid / item.unknown); invalid JSON -> E_INVALID_ARGUMENT', async () => {
    await assert.rejects(polycall.call(runtime.endpoint, 'inventory', 'get', {}), (error) => {
      assert.equal(error.status, Status.E_REMOTE);
      assert.equal(error.remote.code, 'input.invalid');
      assert.equal(JSON.parse(error.remoteJson).code, 'input.invalid');
      return true;
    });
    await assert.rejects(polycall.call(runtime.endpoint, 'inventory', 'get', { item_id: 'nope' }), {
      status: Status.E_REMOTE, remote: { code: 'item.unknown', message: "no inventory item with id 'nope'" }
    });
    await assert.rejects(polycall.callJson(runtime.endpoint, 'debug', 'echo', '{"a":'), { status: Status.E_INVALID_ARGUMENT });
  });

  test('no runtime -> E_TRANSPORT', async () => {
    await assert.rejects(polycall.call(await deadEndpoint(), 'debug', 'echo', null), { status: Status.E_TRANSPORT });
  });

  test('concurrent calls on one runtime', async () => {
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) =>
      polycall.call(runtime.endpoint, 'debug', 'echo', { i })));
    results.forEach((result, i) => assert.deepEqual(result, { echo: { i } }));
  });
});

coreSuite('RPC client vs `polycall daemon start` (C daemon)', cliInfo, () => {
  const token = randomToken();
  let daemon;
  before(async () => { daemon = await startDaemon(cli, { token }); });
  after(async () => {
    if (daemon) {
      const stopped = await daemon.stop();
      assert.equal(stopped.status, 0, stopped.stderr);
    }
  });

  test('daemon answers calls; health over CONTROL', async () => {
    assert.equal(daemon.status.healthy, true);
    assert.deepEqual(await polycall.call(daemon.endpoint, 'debug', 'echo', { hi: 'daemon' }), { echo: { hi: 'daemon' } });
    const info = await polycall.runtimeInfo(daemon.endpoint);
    assert.equal(info.status, 'ok');
  });

  test('shutdown with the wrong token -> E_AUTH and the daemon keeps serving', async () => {
    await assert.rejects(polycall.control(daemon.endpoint, 'shutdown', { authToken: 'wrong-token' }), (error) => {
      assert.equal(error.status, Status.E_AUTH);
      assert.equal(error.remote.code, 'auth.denied');
      return true;
    });
    assert.deepEqual(await polycall.call(daemon.endpoint, 'inventory', 'get', { item_id: 'widget-a' }),
      { item_id: 'widget-a', quantity: 42, in_stock: true });
  });
});
