'use strict';

// Adapter unit tests for the JavaScript polycall-peer/1 implementation:
// two node-polycall nodes in one process plus raw-HTTP edge cases. These do
// not involve the C core (see test/core/ for C <-> Node interop).

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const polycall = require('../..');
const { deadEndpoint, standardPayloads } = require('../helpers');

const { PeerNode, Status } = polycall;
const TOKEN = `unit-${process.pid}-${Date.now()}`;

function rawRequest(endpoint, text) {
  const [host, port] = endpoint.split(':');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port) });
    const chunks = [];
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      const all = Buffer.concat(chunks).toString('utf8');
      const status = Number(all.slice(9, 12));
      const body = all.slice(all.indexOf('\r\n\r\n') + 4);
      resolve({ status, head: all.slice(0, all.indexOf('\r\n\r\n')), body });
    });
    socket.on('error', reject);
  });
}

async function sendWithRetry(sender, peer, payload, messageId) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sender.send(peer, payload, { messageId });
    } catch (error) {
      if (error.status !== Status.E_BUSY || attempt > 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
    }
  }
}

async function pair(t, options = {}) {
  const a = await PeerNode.open('alpha', { bind: '127.0.0.1:0', authToken: TOKEN, ...options.a });
  const b = await PeerNode.open('beta', { bind: '127.0.0.1:0', authToken: TOKEN, ...options.b });
  t.after(async () => {
    for (const node of [a, b]) if (!node.closed) await node.close();
  });
  a.register('beta', b.endpoint);
  b.register('alpha', a.endpoint);
  return { a, b };
}

test('open() validates its arguments', async () => {
  await assert.rejects(PeerNode.open('bad id'), { status: Status.E_INVALID_ARGUMENT });
  await assert.rejects(PeerNode.open('x'.repeat(64)), { status: Status.E_INVALID_ARGUMENT });
  await assert.rejects(PeerNode.open('n', { bind: 'nope' }), { status: Status.E_INVALID_ARGUMENT });
  await assert.rejects(PeerNode.open('n', { bind: '0.0.0.0:0' }), { status: Status.E_CONFIG });
  await assert.rejects(PeerNode.open('n', { authToken: 'x'.repeat(256) }), { status: Status.E_INVALID_ARGUMENT });
  assert.throws(() => new PeerNode(), TypeError);
  const sendOnly = await PeerNode.open('sender');
  assert.equal(sendOnly.endpoint, '');
  await sendOnly.close();
});

test('address in use -> E_ADDRESS_IN_USE', async (t) => {
  const first = await PeerNode.open('first', { bind: '127.0.0.1:0' });
  t.after(() => first.close());
  await assert.rejects(PeerNode.open('second', { bind: first.endpoint }), { status: Status.E_ADDRESS_IN_USE });
});

test('both directions, exact bytes, sender and message id', async (t) => {
  const { a, b } = await pair(t);
  for (const [name, bytes] of Object.entries(standardPayloads())) {
    const ack = await a.send('beta', bytes, { messageId: `ab-${name}` });
    assert.deepEqual(ack, { id: `ab-${name}`, nodeId: 'beta', duplicate: false });
    const got = await b.recv({ timeoutMs: 2000 });
    assert.equal(got.from, 'alpha');
    assert.equal(got.id, `ab-${name}`);
    assert.ok(got.payload.equals(bytes), name);
    await b.send('alpha', bytes, { messageId: `ba-${name}` });
    const back = await a.recv({ timeoutMs: 2000 });
    assert.equal(back.from, 'beta');
    assert.equal(back.id, `ba-${name}`);
    assert.ok(back.payload.equals(bytes), name);
  }
  await assert.rejects(a.send('beta', Buffer.alloc((1 << 20) + 1)), { status: Status.E_TOO_LARGE });
  assert.equal(b.health().received, 4);
});

test('duplicate (sender, message id) is stored once', async (t) => {
  const { a, b } = await pair(t);
  assert.equal((await a.send('beta', 'one', { messageId: 'dup-1' })).duplicate, false);
  assert.equal((await a.send('beta', 'one', { messageId: 'dup-1' })).duplicate, true);
  assert.equal((await b.recv({ timeoutMs: 1000 })).id, 'dup-1');
  await assert.rejects(b.recv({ timeoutMs: 100 }), { status: Status.E_TIMEOUT });
  assert.equal(b.health().duplicates, 1);
});

test('registry ownership: receiving never registers the sender', async (t) => {
  const a = await PeerNode.open('owner-a', { bind: '127.0.0.1:0' });
  const b = await PeerNode.open('owner-b', { bind: '127.0.0.1:0' });
  t.after(async () => { await a.close(); await b.close(); });
  a.register('owner-b', b.endpoint);
  await a.send('owner-b', 'hello');
  assert.deepEqual(b.list(), {});
  assert.deepEqual(a.list(), { 'owner-b': b.endpoint });
  a.unregister('owner-b');
  assert.throws(() => a.unregister('owner-b'), { status: Status.E_NOT_FOUND });
  await assert.rejects(a.send('owner-b', 'x'), { status: Status.E_NOT_FOUND });
  assert.throws(() => a.register('bad id', '127.0.0.1:1'), { status: Status.E_INVALID_ARGUMENT });
  assert.throws(() => a.register('ok', '127.0.0.1:0'), { status: Status.E_INVALID_ARGUMENT });
});

test('auth failure -> E_AUTH and the message is not stored', async (t) => {
  const b = await PeerNode.open('locked', { bind: '127.0.0.1:0', authToken: TOKEN });
  const a = await PeerNode.open('intruder', { authToken: 'wrong-token' });
  const anonymous = await PeerNode.open('anonymous');
  t.after(async () => { await a.close(); await b.close(); await anonymous.close(); });
  await assert.rejects(a.send(b.endpoint, 'x'), { status: Status.E_AUTH, httpStatus: 401 });
  await assert.rejects(anonymous.send(b.endpoint, 'x'), { status: Status.E_AUTH });
  assert.equal(b.health().received, 0);
  assert.equal(b.health().rejected_auth, 2);
  // /health stays open without a token
  assert.equal((await a.ping(b.endpoint)).node_id, 'locked');
});

test('dead peer -> E_TRANSPORT; wrong identity -> E_PROTOCOL', async (t) => {
  const { a, b } = await pair(t);
  const dead = await deadEndpoint();
  await assert.rejects(a.send(dead, 'x'), { status: Status.E_TRANSPORT });
  await assert.rejects(a.ping(dead), { status: Status.E_TRANSPORT });
  a.register('impostor', b.endpoint);
  await assert.rejects(a.send('impostor', 'x'), { status: Status.E_PROTOCOL });
  await assert.rejects(a.ping('impostor'), { status: Status.E_PROTOCOL });
  assert.equal(a.health().sent_failed, 2); // ping failures are not send failures
});

test('recv: timeout, too-small buffer keeps the message queued', async (t) => {
  const { a, b } = await pair(t);
  await assert.rejects(b.recv({ timeoutMs: 0 }), { status: Status.E_TIMEOUT });
  await assert.rejects(b.recv({ timeoutMs: 50 }), { status: Status.E_TIMEOUT });
  await a.send('beta', Buffer.alloc(100, 7), { messageId: 'big' });
  await assert.rejects(b.recv({ timeoutMs: 1000, maxBytes: 99 }), (error) => {
    assert.equal(error.status, Status.E_TOO_LARGE);
    assert.equal(error.needed, 100);
    return true;
  });
  assert.equal(b.health().inbox, 1);
  const got = await b.recv({ timeoutMs: 1000, maxBytes: 100 });
  assert.equal(got.id, 'big');
  assert.equal(got.payload.length, 100);
});

test('cancel and close wake a blocked recv', async () => {
  const node = await PeerNode.open('waker', { bind: '127.0.0.1:0' });
  const blocked = node.recv();
  setTimeout(() => node.cancel(), 50);
  await assert.rejects(blocked, { status: Status.E_CANCELLED });
  const blocked2 = node.recv({ timeoutMs: Infinity });
  setTimeout(() => node.close(), 50);
  await assert.rejects(blocked2, { status: Status.E_CLOSED });
});

test('double close, calls after close -> E_INVALID_HANDLE', async () => {
  const node = await PeerNode.open('closer', { bind: '127.0.0.1:0' });
  await node.close();
  await assert.rejects(node.close(), { status: Status.E_INVALID_HANDLE });
  assert.throws(() => node.endpoint, { status: Status.E_INVALID_HANDLE });
  assert.throws(() => node.nodeId, { status: Status.E_INVALID_HANDLE });
  assert.throws(() => node.list(), { status: Status.E_INVALID_HANDLE });
  assert.throws(() => node.health(), { status: Status.E_INVALID_HANDLE });
  assert.throws(() => node.register('x', '127.0.0.1:1'), { status: Status.E_INVALID_HANDLE });
  assert.throws(() => node.cancel(), { status: Status.E_INVALID_HANDLE });
  await assert.rejects(node.send('127.0.0.1:1', 'x'), { status: Status.E_INVALID_HANDLE });
  await assert.rejects(node.recv({ timeoutMs: 0 }), { status: Status.E_INVALID_HANDLE });
  await assert.rejects(node.ping('127.0.0.1:1'), { status: Status.E_INVALID_HANDLE });
});

test('concurrent senders: every message delivered exactly once', async (t) => {
  const receiver = await PeerNode.open('sink', { bind: '127.0.0.1:0', authToken: TOKEN });
  const senders = await Promise.all([0, 1, 2, 3].map((i) => PeerNode.open(`src-${i}`, { authToken: TOKEN })));
  t.after(async () => {
    await receiver.close();
    for (const s of senders) await s.close();
  });
  const sends = [];
  for (const [i, sender] of senders.entries()) {
    for (let j = 0; j < 20; j += 1) {
      // 80 concurrent requests exceed the 32-connection limit: a 503 (E_BUSY) means
      // 'retry later with the same id', which is exactly what a sender must do.
      sends.push(sendWithRetry(sender, receiver.endpoint, `${i}:${j}`, `m-${i}-${j}`));
    }
  }
  await Promise.all(sends);
  const seen = new Set();
  for (let k = 0; k < 80; k += 1) {
    const m = await receiver.recv({ timeoutMs: 2000 });
    const key = `${m.from}/${m.id}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
    assert.equal(m.payload.toString(), `${m.from.slice(4)}:${m.id.split('-')[2]}`);
  }
  assert.equal(seen.size, 80);
  await assert.rejects(receiver.recv({ timeoutMs: 0 }), { status: Status.E_TIMEOUT });
});

test('backpressure: a full inbox answers 503 -> E_BUSY', async (t) => {
  const { a } = await pair(t, { b: { inboxCapacity: 2 } });
  await a.send('beta', '1');
  await a.send('beta', '2');
  await assert.rejects(a.send('beta', '3', { messageId: 'third' }), { status: Status.E_BUSY, httpStatus: 503 });
});

test('HTTP transport rules (raw requests)', async (t) => {
  const node = await PeerNode.open('http', { bind: '127.0.0.1:0', authToken: TOKEN });
  t.after(() => node.close());
  const ep = node.endpoint;
  const auth = `Authorization: Bearer ${TOKEN}\r\n`;

  let r = await rawRequest(ep, 'GET /health HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.equal(r.status, 200);
  assert.match(r.head, /Connection: close/i);
  assert.equal(JSON.parse(r.body).protocol, 'polycall-peer/1');

  r = await rawRequest(ep, 'GET /nope HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.equal(r.status, 404);
  r = await rawRequest(ep, 'POST /health HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n');
  assert.equal(r.status, 405);
  assert.match(r.head, /Allow: GET/);
  r = await rawRequest(ep, 'GET /peers HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.equal(r.status, 401);
  assert.match(r.head, /WWW-Authenticate: Bearer/);
  assert.equal(JSON.parse(r.body).error.code, 'auth.required');
  r = await rawRequest(ep, 'GET /peers HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer wrong\r\n\r\n');
  assert.equal(JSON.parse(r.body).error.code, 'auth.denied');
  r = await rawRequest(ep, `GET /receive HTTP/1.1\r\nHost: x\r\n${auth}\r\n`);
  assert.equal(r.status, 405);
  assert.match(r.head, /Allow: POST/);
  r = await rawRequest(ep, `POST /receive HTTP/1.1\r\nHost: x\r\n${auth}Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n`);
  assert.equal(r.status, 501);
  r = await rawRequest(ep, `POST /receive HTTP/1.1\r\nHost: x\r\n${auth}\r\n`);
  assert.equal(r.status, 411);
  r = await rawRequest(ep, `GET /${'a'.repeat(300)} HTTP/1.1\r\nHost: x\r\n\r\n`);
  assert.equal(r.status, 414);
  r = await rawRequest(ep, `POST /receive HTTP/1.1\r\nHost: x\r\n${auth}Content-Length: ${3 * 1024 * 1024}\r\n\r\n`);
  assert.equal(r.status, 413);
  r = await rawRequest(ep, `GET /health HTTP/1.1\r\nHost: x\r\nX-Big: ${'b'.repeat(17 * 1024)}\r\n\r\n`);
  assert.equal(r.status, 431);

  const post = (body) => rawRequest(ep, `POST /receive HTTP/1.1\r\nHost: x\r\n${auth}Content-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  r = await post('[1]');
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.body).error.code, 'request.malformed');
  r = await post('{"v":2,"id":"a","from":"b","payload_b64":""}');
  assert.equal(JSON.parse(r.body).error.code, 'protocol.version');
  r = await post('{"v":"1","id":"a","from":"b","payload_b64":""}');
  assert.equal(JSON.parse(r.body).error.code, 'protocol.version');
  r = await post('{"v":1,"id":"bad id","from":"b","payload_b64":""}');
  assert.equal(r.status, 400);
  r = await post('{"v":1,"id":"a","from":"b","payload_b64":"YQ"}');
  assert.equal(r.status, 400, 'unpadded base64 is not canonical');
  r = await post('{"v":1,"id":"a","from":"b","payload_b64":"YR=="}');
  assert.equal(r.status, 400, 'non-canonical trailing bits');
  r = await post(`{"v":1,"id":"a","from":"b","payload_b64":"${Buffer.alloc((1 << 20) + 1).toString('base64')}"}`);
  assert.equal(r.status, 413);
  assert.equal(JSON.parse(r.body).error.code, 'payload.too_large');
  r = await post('{"v":1,"id":"ok-1","from":"raw","payload_b64":"YQ=="}');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, status: 'received', node_id: 'http', id: 'ok-1', duplicate: false });
  assert.equal(node.health().received, 1);
  assert.equal(node.health().rejected_malformed, 8);
});

test('remote helpers: /register, /peers, /inbox/next', async (t) => {
  const { a, b } = await pair(t);
  await polycall.remote.register(b.endpoint, 'gamma', '127.0.0.1:7', { authToken: TOKEN });
  assert.deepEqual(await polycall.remote.peers(b.endpoint, { authToken: TOKEN }), { alpha: a.endpoint, gamma: '127.0.0.1:7' });
  await assert.rejects(polycall.remote.peers(b.endpoint, { authToken: 'nope' }), { status: Status.E_AUTH });
  await assert.rejects(polycall.remote.register(b.endpoint, 'bad id', '127.0.0.1:7', { authToken: TOKEN }), { status: Status.E_REMOTE });
  assert.equal(await polycall.remote.inboxNext(b.endpoint, { authToken: TOKEN, timeoutMs: 0 }), null);
  await a.send('beta', Buffer.from([0, 255, 0]), { messageId: 'via-http' });
  const m = await polycall.remote.inboxNext(b.endpoint, { authToken: TOKEN, timeoutMs: 1000 });
  assert.equal(m.from, 'alpha');
  assert.equal(m.id, 'via-http');
  assert.ok(m.payload.equals(Buffer.from([0, 255, 0])));
  assert.equal((await polycall.remote.health(b.endpoint)).node_id, 'beta');
});
