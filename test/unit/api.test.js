'use strict';

// Adapter unit tests: node-polycall's own logic (status table, framing,
// argument validation). They do not involve the C core; the core
// interoperability tests live in test/core/.

const test = require('node:test');
const assert = require('node:assert/strict');
const polycall = require('../..');

test('status codes and names match polycall.h / polycall_strerror()', () => {
  const expected = {
    OK: 0, E_INVALID_ARGUMENT: -1, E_NO_MEMORY: -2, E_INVALID_HANDLE: -3, E_TIMEOUT: -4,
    E_TRANSPORT: -5, E_PROTOCOL: -6, E_NOT_FOUND: -7, E_AUTH: -8, E_REMOTE: -9,
    E_TOO_LARGE: -10, E_BUSY: -11, E_CANCELLED: -12, E_CONFIG: -13, E_ADDRESS_IN_USE: -14,
    E_UNSUPPORTED: -15, E_PERMISSION: -16, E_CLOSED: -17, E_INTERNAL: -18
  };
  assert.deepEqual({ ...polycall.Status }, expected);
  for (const [name, code] of Object.entries(expected)) {
    assert.ok(polycall.strerror(code).startsWith(`POLYCALL_${name}: `), `${name}: ${polycall.strerror(code)}`);
    assert.equal(polycall.statusName(code), `POLYCALL_${name}`);
  }
  assert.equal(polycall.strerror(-4), 'POLYCALL_E_TIMEOUT: deadline exceeded');
  assert.equal(polycall.strerror(12345), 'POLYCALL_E_UNKNOWN: unknown status code');
  assert.equal(polycall.strerror(-19), 'POLYCALL_E_UNKNOWN: unknown status code');
});

test('PolycallError carries status, name and detail', () => {
  const error = new polycall.PolycallError(-5, 'connection refused');
  assert.ok(error instanceof Error);
  assert.equal(error.status, -5);
  assert.equal(error.code, 'POLYCALL_E_TRANSPORT');
  assert.equal(error.statusName, 'POLYCALL_E_TRANSPORT');
  assert.equal(error.strerror, 'POLYCALL_E_TRANSPORT: peer unreachable, refused or reset');
  assert.equal(error.detail, 'connection refused');
  assert.match(error.message, /^POLYCALL_E_TRANSPORT: connection refused$/);
});

test('version / ABI constants', () => {
  assert.equal(polycall.abiVersion(), 1);
  assert.equal(polycall.ABI_VERSION, 1);
  assert.equal(polycall.RPC_VERSION, 1);
  assert.equal(polycall.PROTOCOL, 'polycall-peer/1');
  assert.equal(polycall.version(), require('../../package.json').version);
  assert.equal(polycall.limits.PEER_MAX_PAYLOAD, 1048576);
  assert.equal(polycall.limits.CALL_MAX_OUTPUT, 1048576);
  assert.equal(polycall.limits.PEER_ID_MAX, 64);
  assert.equal(polycall.limits.ENDPOINT_MAX, 128);
});

test('PCR1 frame encode/decode (docs/RPC.md layout)', () => {
  const frame = polycall.frame.encode(1, 0xdeadbeef, '{"a":1}');
  assert.equal(frame.length, 16 + 7);
  assert.equal(frame.subarray(0, 4).toString('ascii'), 'PCR1');
  assert.equal(frame[4], 1);
  assert.equal(frame[5], 0);
  assert.equal(frame.readUInt16BE(6), 0);
  assert.equal(frame.readUInt32BE(8), 0xdeadbeef);
  assert.equal(frame.readUInt32BE(12), 7);
  assert.deepEqual(polycall.frame.decodeHeader(frame), { type: 1, flags: 0, corr: 0xdeadbeef, length: 7 });
  const bad = Buffer.from(frame);
  bad.write('XCR1', 0, 'ascii');
  assert.throws(() => polycall.frame.decodeHeader(bad), { status: polycall.Status.E_PROTOCOL });
  const huge = Buffer.from(frame);
  huge.writeUInt32BE((1 << 20) + 1, 12);
  assert.throws(() => polycall.frame.decodeHeader(huge), { status: polycall.Status.E_PROTOCOL });
  assert.throws(() => polycall.frame.encode(1, 1, Buffer.alloc((1 << 20) + 1)), { status: polycall.Status.E_TOO_LARGE });
});

test('call() argument validation happens before any I/O', async () => {
  const E = polycall.Status.E_INVALID_ARGUMENT;
  await assert.rejects(polycall.call('nohostport', 'debug', 'echo', null), { status: E });
  await assert.rejects(polycall.call('127.0.0.1:1', '', 'echo', null), { status: E });
  await assert.rejects(polycall.call('127.0.0.1:1', 'debug', 'echo', null, { timeoutMs: 0 }), { status: E });
  await assert.rejects(polycall.call('127.0.0.1:1', 'debug', 'echo', null, { timeoutMs: 600001 }), { status: E });
  await assert.rejects(polycall.callJson('127.0.0.1:1', 'debug', 'echo', '{not json'), { status: E });
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(polycall.call('127.0.0.1:1', 'debug', 'echo', cyclic), { status: E });
});

test('ids follow [A-Za-z0-9._-]{1,63}', () => {
  assert.equal(polycall.isValidId('alpha-1.node_2'), true);
  assert.equal(polycall.isValidId('a'.repeat(63)), true);
  assert.equal(polycall.isValidId('a'.repeat(64)), false);
  assert.equal(polycall.isValidId(''), false);
  assert.equal(polycall.isValidId('has space'), false);
  assert.equal(polycall.isValidId('slash/'), false);
  assert.equal(polycall.isValidId(42), false);
});

test('ESM entry point exposes the same API', async () => {
  const esm = await import('../../index.mjs');
  assert.equal(esm.call, polycall.call);
  assert.equal(esm.PeerNode, polycall.PeerNode);
  assert.equal(esm.default, polycall);
});
