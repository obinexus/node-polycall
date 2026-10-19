'use strict';

// Cross-language interop: node-polycall's PeerNode <-> the C library's peer
// node (`polycall peer serve`, `polycall peer send|recv|health|peers|register`).
// Every payload is checked byte-for-byte together with the sender id and the
// message id at the receiver.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const polycall = require('../..');
const {
  findCli, coreSuite, randomToken, tempDir, runCli, waitFor, startPeerServe, deadEndpoint, standardPayloads
} = require('../helpers');

const { PeerNode, Status } = polycall;
const cliInfo = findCli();
const { cli } = cliInfo;

coreSuite('Node peer <-> C peer (polycall peer serve)', cliInfo, () => {
  const token = randomToken();
  const env = { POLYCALL_DEV_TOKEN: token };
  const payloads = standardPayloads();
  let cnode; // C node that prints every message it receives
  let cquiet; // C node that keeps its inbox (read through /inbox/next)
  let node; // node-polycall node
  let dir;

  before(async () => {
    dir = tempDir('peer');
    cnode = await startPeerServe(cli, { nodeId: 'c-node', token, printMessages: true });
    cquiet = await startPeerServe(cli, { nodeId: 'c-quiet', token });
    node = await PeerNode.open('node-js', { bind: '127.0.0.1:0', authToken: token });
    node.register('c-node', cnode.endpoint);
    node.register('c-quiet', cquiet.endpoint);
  });
  after(async () => {
    if (node && !node.closed) await node.close();
    if (cnode) await cnode.stop();
    if (cquiet) await cquiet.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ping the C node by registered id (identity + protocol checked)', async () => {
    const health = await node.ping('c-node');
    assert.equal(health.node_id, 'c-node');
    assert.equal(health.protocol, 'polycall-peer/1');
    assert.match(health.implementation, /^libpolycall /);
    assert.equal(health.auth, true);
  });

  test('Node -> C: empty, UTF-8, binary with NUL, exactly 1 MiB (bytes, sender, id at the C receiver)', async () => {
    for (const [name, bytes] of Object.entries(payloads)) {
      const id = `n2c-${name}`;
      const ack = await node.send('c-node', bytes, { messageId: id, timeoutMs: 15000 });
      assert.deepEqual(ack, { id, nodeId: 'c-node', duplicate: false });
      const event = await cnode.waitForMessage(id);
      assert.equal(event.from, 'node-js', name);
      assert.equal(event.id, id);
      assert.equal(event.bytes, bytes.length, name);
      assert.ok(Buffer.from(event.payload_b64, 'base64').equals(bytes), `${name}: bytes differ`);
    }
  });

  test('Node -> C: 1 MiB + 1 is refused before any I/O', async () => {
    const before = (await polycall.remote.health(cnode.endpoint)).received;
    await assert.rejects(node.send('c-node', Buffer.alloc((1 << 20) + 1), { messageId: 'too-big' }), { status: Status.E_TOO_LARGE });
    assert.equal((await polycall.remote.health(cnode.endpoint)).received, before);
  });

  test('C -> Node: polycall peer send (bytes, sender, id at the Node receiver)', async () => {
    for (const [name, bytes] of Object.entries(payloads)) {
      const id = `c2n-${name}`;
      const file = path.join(dir, `${name}.bin`);
      fs.writeFileSync(file, bytes);
      const sent = await runCli(cli, ['peer', 'send', '--to', node.endpoint, '--payload-file', file,
        '--from', 'c-sender', '--id', id, '--timeout-ms', '15000'], { env });
      assert.equal(sent.status, 0, `${name}: ${sent.stderr}`);
      const message = await node.recv({ timeoutMs: 5000 });
      assert.equal(message.from, 'c-sender', name);
      assert.equal(message.id, id);
      assert.ok(message.payload.equals(bytes), `${name}: bytes differ (${message.payload.length} vs ${bytes.length})`);
    }
    const tooBig = path.join(dir, 'too-big.bin');
    fs.writeFileSync(tooBig, Buffer.alloc((1 << 20) + 1));
    const refused = await runCli(cli, ['peer', 'send', '--to', node.endpoint, '--payload-file', tooBig, '--id', 'c-too-big'], { env });
    assert.notEqual(refused.status, 0);
    await assert.rejects(node.recv({ timeoutMs: 200 }), { status: Status.E_TIMEOUT });
  });

  test('C out-of-process consumer: polycall peer recv --raw drains the Node inbox', async () => {
    const bytes = payloads.binaryNul;
    const self = await PeerNode.open('node-self', { authToken: token });
    try {
      await self.send(node.endpoint, bytes, { messageId: 'for-c-recv' });
    } finally {
      await self.close();
    }
    // '-t', not '--timeout-ms': the CLI's global parser swallows --timeout-ms and
    // 'peer recv' then waits its 5000 ms default (a core CLI defect).
    const got = await runCli(cli, ['peer', 'recv', '--to', node.endpoint, '--raw', '-t', '2000'], { env });
    assert.equal(got.status, 0, got.stderr);
    assert.ok(got.stdout.equals(bytes), 'C recv --raw bytes differ');
    const empty = await runCli(cli, ['peer', 'recv', '--to', node.endpoint, '-t', '100'], { env });
    assert.equal(empty.status, 6, 'no message -> deadline exit code');
  });

  test('C client talks to the Node node: health, register, peers', async () => {
    const health = await runCli(cli, ['peer', 'health', '--to', node.endpoint], { env });
    assert.equal(health.status, 0, health.stderr);
    const parsed = JSON.parse(health.stdout.toString('utf8'));
    assert.equal(parsed.node_id, 'node-js');
    assert.equal(parsed.protocol, 'polycall-peer/1');
    const reg = await runCli(cli, ['peer', 'register', '--to', node.endpoint, '--id', 'c-registered',
      '--peer-endpoint', '127.0.0.1:9'], { env });
    assert.equal(reg.status, 0, reg.stderr);
    assert.equal(node.list()['c-registered'], '127.0.0.1:9');
    const peers = await runCli(cli, ['peer', 'peers', '--to', node.endpoint], { env });
    assert.equal(JSON.parse(peers.stdout.toString('utf8')).peers['c-registered'], '127.0.0.1:9');
    node.unregister('c-registered');
  });

  test('Node out-of-process consumer: /inbox/next, /peers, /register on the C node', async () => {
    const bytes = payloads.utf8;
    await node.send('c-quiet', bytes, { messageId: 'to-quiet' });
    const message = await polycall.remote.inboxNext(cquiet.endpoint, { authToken: token, timeoutMs: 2000 });
    assert.equal(message.from, 'node-js');
    assert.equal(message.id, 'to-quiet');
    assert.ok(message.payload.equals(bytes));
    assert.equal(await polycall.remote.inboxNext(cquiet.endpoint, { authToken: token, timeoutMs: 0 }), null);
    await polycall.remote.register(cquiet.endpoint, 'via-node', '127.0.0.1:7', { authToken: token });
    assert.deepEqual(await polycall.remote.peers(cquiet.endpoint, { authToken: token }), { 'via-node': '127.0.0.1:7' });
  });

  test('duplicate message id is delivered once (both directions)', async () => {
    assert.equal((await node.send('c-node', 'dup', { messageId: 'dup-n2c' })).duplicate, false);
    assert.equal((await node.send('c-node', 'dup', { messageId: 'dup-n2c' })).duplicate, true);
    await cnode.waitForMessage('dup-n2c');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(cnode.messages().filter((m) => m.id === 'dup-n2c').length, 1);

    const dupsBefore = node.health().duplicates;
    for (let i = 0; i < 2; i += 1) {
      const sent = await runCli(cli, ['peer', 'send', '--to', node.endpoint, '--payload', 'dup',
        '--from', 'c-sender', '--id', 'dup-c2n'], { env });
      assert.equal(sent.status, 0, sent.stderr);
    }
    const message = await node.recv({ timeoutMs: 2000 });
    assert.equal(message.id, 'dup-c2n');
    await assert.rejects(node.recv({ timeoutMs: 300 }), { status: Status.E_TIMEOUT });
    assert.equal(node.health().duplicates, dupsBefore + 1);
  });

  test('registry ownership: each node owns its registry; receiving never registers the sender', async () => {
    const cPeers = await polycall.remote.peers(cnode.endpoint, { authToken: token });
    assert.deepEqual(cPeers, {}, 'C node registry must not contain node-js after receiving from it');
    assert.equal(node.list()['c-sender'], undefined, 'Node registry must not contain c-sender after receiving from it');
    assert.deepEqual(Object.keys(node.list()).sort(), ['c-node', 'c-quiet']);
  });

  test('auth failure in both directions', async () => {
    const intruder = await PeerNode.open('intruder', { authToken: 'wrong-token' });
    try {
      await assert.rejects(intruder.send(cnode.endpoint, 'x', { messageId: 'intrude' }), { status: Status.E_AUTH, httpStatus: 401 });
    } finally {
      await intruder.close();
    }
    const rejectedBefore = node.health().rejected_auth;
    const sent = await runCli(cli, ['peer', 'send', '--to', node.endpoint, '--payload', 'x', '--id', 'intrude'],
      { env: { POLYCALL_DEV_TOKEN: 'wrong-token' } });
    assert.equal(sent.status, 7, sent.stderr);
    assert.equal(node.health().rejected_auth, rejectedBefore + 1);
    await assert.rejects(node.recv({ timeoutMs: 100 }), { status: Status.E_TIMEOUT });
  });

  test('dead peer -> E_TRANSPORT; impostor identity -> E_PROTOCOL', async () => {
    const dead = await deadEndpoint();
    await assert.rejects(node.send(dead, 'x'), { status: Status.E_TRANSPORT });
    const cDead = await runCli(cli, ['peer', 'send', '--to', dead, '--payload', 'x'], { env });
    assert.equal(cDead.status, 5, 'C client: transport exit code');
    node.register('impostor', cnode.endpoint);
    await assert.rejects(node.send('impostor', 'x'), { status: Status.E_PROTOCOL });
    await assert.rejects(node.ping('impostor'), { status: Status.E_PROTOCOL });
    node.unregister('impostor');
  });

  test('concurrent senders: Node -> C and C -> Node, each message exactly once', async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `conc-n2c-${i}`);
    await Promise.all(ids.map((id) => node.send('c-node', id, { messageId: id })));
    for (const id of ids) {
      const event = await cnode.waitForMessage(id);
      assert.equal(Buffer.from(event.payload_b64, 'base64').toString('utf8'), id);
    }
    const cIds = Array.from({ length: 8 }, (_, i) => `conc-c2n-${i}`);
    const results = await Promise.all(cIds.map((id) => runCli(cli, ['peer', 'send', '--to', node.endpoint,
      '--payload', id, '--from', `c-sender-${id.slice(-1)}`, '--id', id], { env })));
    results.forEach((r) => assert.equal(r.status, 0, r.stderr));
    const got = new Map();
    for (let i = 0; i < cIds.length; i += 1) {
      const m = await node.recv({ timeoutMs: 5000 });
      assert.ok(!got.has(m.id), `duplicate ${m.id}`);
      got.set(m.id, m);
      assert.equal(m.payload.toString('utf8'), m.id);
      assert.equal(m.from, `c-sender-${m.id.slice(-1)}`);
    }
    assert.deepEqual([...got.keys()].sort(), [...cIds].sort());
  });

  test('backpressure: a full C inbox -> E_BUSY; draining makes room', async () => {
    const quiet = await startPeerServe(cli, { nodeId: 'c-full', token });
    try {
      node.register('c-full', quiet.endpoint);
      for (let i = 0; i < 256; i += 1) await node.send('c-full', 'x', { messageId: `fill-${i}` });
      await assert.rejects(node.send('c-full', 'x', { messageId: 'fill-256' }), { status: Status.E_BUSY, httpStatus: 503 });
      assert.equal((await polycall.remote.inboxNext(quiet.endpoint, { authToken: token })).id, 'fill-0');
      assert.equal((await node.send('c-full', 'x', { messageId: 'fill-256' })).duplicate, false);
    } finally {
      node.unregister('c-full');
      await quiet.stop();
    }
  });

  test('C sender sees E_BUSY from a full Node inbox', async () => {
    const small = await PeerNode.open('node-small', { bind: '127.0.0.1:0', authToken: token, inboxCapacity: 1 });
    try {
      const first = await runCli(cli, ['peer', 'send', '--to', small.endpoint, '--payload', 'a', '--id', 'b1'], { env });
      assert.equal(first.status, 0, first.stderr);
      const second = await runCli(cli, ['peer', 'send', '--to', small.endpoint, '--payload', 'b', '--id', 'b2'], { env });
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /503|inbox\.full|BUSY/i);
    } finally {
      await small.close();
    }
  });

  test('cancel / close wake a receive blocked while the C node is sending elsewhere', async () => {
    const blocked = node.recv();
    setTimeout(() => node.cancel(), 100);
    await assert.rejects(blocked, { status: Status.E_CANCELLED });
    const second = node.recv({ timeoutMs: Infinity });
    await waitFor(() => true, 10, 'tick');
    await node.close();
    await assert.rejects(second, { status: Status.E_CLOSED });
    await assert.rejects(node.close(), { status: Status.E_INVALID_HANDLE });
    const cHealth = await runCli(cli, ['peer', 'health', '--to', cnode.endpoint], { env });
    assert.equal(cHealth.status, 0, 'C node unaffected by the Node node closing');
  });
});
