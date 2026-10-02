# node-polycall

Dependency-free Node.js binding for [Polycall](https://github.com/obinexus/polycall):

* a **`polycall_rpc` v1 client** (PCR1 framing, [docs/RPC.md](https://github.com/obinexus/polycall/blob/main/docs/RPC.md))
  for calling operations on a running `polycall start` / `polycall daemon start` runtime, and
* a **`polycall-peer/1` peer node** (server *and* client,
  [docs/PEER_PROTOCOL.md](https://github.com/obinexus/polycall/blob/main/docs/PEER_PROTOCOL.md))
  that exchanges payloads directly with the C library's peer nodes
  (`polycall peer serve`, `polycall_peer_*`) and with other implementations.

It is written in plain JavaScript on `node:net` / `node:http`: no native
addon, no compiler, no runtime dependencies. It does **not** load
`libpolycall`; it speaks the wire protocols, and reports failures with the
same status codes and names as the C binding ABI v1 (`polycall.h`).

Package name: `@obinexuscomputing/node-polycall` (not published to npm; the
manifest is marked `"private": true`). Tested on Node.js 20, 22 and 26.

> This replaces the earlier 1.0.0 prototype (`PolyCallClient`, `Router`,
> `StateMachine` ...), which spoke an invented protocol that no Polycall
> runtime implements and whose client could not be constructed.

## Install

From a checkout or a packed tarball (`npm pack`):

```sh
npm install ./obinexuscomputing-node-polycall-1.1.0.tgz
```

## RPC client

```js
const polycall = require('@obinexuscomputing/node-polycall');

// against `polycall start` (prints its endpoint) or `polycall daemon start`
const out = await polycall.call('127.0.0.1:8084', 'inventory', 'get', { item_id: 'widget-a' });
// -> { item_id: 'widget-a', quantity: 42, in_stock: true }

await polycall.callJson('127.0.0.1:8084', 'debug', 'echo', '[1,"x"]'); // '{"echo":[1,"x"]}'
await polycall.runtimeInfo('127.0.0.1:8084');                          // { version, abi, ... }
```

One TCP connection, one REQUEST frame, one RESPONSE frame, **never retried**
(non-idempotent operations are safe). `timeoutMs` (1..600000, default 5000)
is sent as `deadline_ms`. Failures reject with `PolycallError`:

| condition | `error.status` |
| --- | --- |
| `operation.unknown` | `E_NOT_FOUND` (-7) |
| `deadline.exceeded`, or no reply in time | `E_TIMEOUT` (-4) |
| `server.busy` | `E_BUSY` (-11) |
| `auth.denied` | `E_AUTH` (-8) |
| any other operation error (`input.invalid`, `item.unknown` ...) | `E_REMOTE` (-9), `error.remote = {code, message}` |
| cannot connect / dropped | `E_TRANSPORT` (-5) |
| bad frame / reply | `E_PROTOCOL` (-6) |
| bad argument, invalid input JSON (before any I/O) | `E_INVALID_ARGUMENT` (-1) |

`callRaw()` returns the RESPONSE payload exactly as received;
`control(endpoint, 'ping'|'health'|'describe'|'shutdown', {authToken})`
sends a CONTROL frame.

## Peer node

```js
const { PeerNode } = require('@obinexuscomputing/node-polycall');

const node = await PeerNode.open('alpha', { bind: '127.0.0.1:0', authToken: process.env.POLYCALL_DEV_TOKEN });
node.register('beta', '127.0.0.1:9002');          // THIS node's registry only
await node.ping('beta');                          // checks the answering node id
await node.send('beta', Buffer.from([0, 1, 2]), { messageId: 'm-1' });
const { from, id, payload } = await node.recv({ timeoutMs: 5000 });
node.cancel();                                    // wakes waiting recv() with E_CANCELLED
await node.close();                               // wakes them with E_CLOSED; 2nd close -> E_INVALID_HANDLE
```

| method | notes |
| --- | --- |
| `PeerNode.open(id, {bind, authToken, inboxCapacity})` | `bind` omitted = send-only; non-loopback bind without a token -> `E_CONFIG` |
| `endpoint`, `nodeId`, `list()`, `health()` | local state; any use after `close()` -> `E_INVALID_HANDLE` |
| `register(id, 'host:port')`, `unregister(id)` | `unregister` of an unknown id -> `E_NOT_FOUND` |
| `ping(peer)` | `GET /health`; for a registered id the answering `node_id` must match (`E_PROTOCOL`) |
| `send(peer, bytes, {messageId, timeoutMs})` | <= 1 MiB (`E_TOO_LARGE` before I/O), one attempt, OK only on the receiver's acknowledgement under the expected id; retry with the **same** id after `E_TIMEOUT`/`E_BUSY` |
| `recv({timeoutMs, maxBytes})` | `0` = poll, `Infinity` = wait; too-small `maxBytes` -> `E_TOO_LARGE` with `error.needed`, message stays queued |

The node serves `GET /health`, `GET /peers`, `POST /register`,
`POST /receive` and `POST /inbox/next` exactly as the protocol specifies
(Bearer token on everything but `/health`, `Connection: close`,
`Content-Length` required, `Transfer-Encoding` -> 501, 16 KiB headers,
255-byte paths, 32 concurrent connections -> 503 `server.busy`, inbox
256 messages / 64 MiB -> 503 `inbox.full`, duplicates of `(sender, id)`
within the last 1024 messages stored once, receiving never registers the
sender).

`polycall.remote.health|peers|register|inboxNext(endpoint, ...)` talk to any
running node from outside it, like `polycall peer health|peers|register|recv`.

## Errors

Every failure is a `PolycallError` with `status` (negative `POLYCALL_E_*`
value), `code`/`statusName` (`'POLYCALL_E_TIMEOUT'`), `strerror` (the exact
`polycall_strerror()` text) and `detail`. `polycall.Status`,
`polycall.strerror()` and `polycall.statusName()` expose the table.

## TypeScript

`index.d.ts` is shipped (`"types"`); ESM (`import { call } from ...`) and
CommonJS (`require`) are both supported.

## Tests

```sh
npm test                 # unit + core
npm run test:unit        # adapter unit tests (no core needed)
POLYCALL_CLI=/opt/polycall/bin/polycall npm run test:core
```

`test/core/` runs against the **real** C core: `polycall start`,
`polycall daemon start` and `polycall peer serve` nodes, exchanging empty,
UTF-8, binary-with-NUL, exactly-1-MiB and 1-MiB+1 payloads in both
directions with bytes, sender id and message id verified at the receiver,
plus duplicates, auth failures, dead peers, wrong identities, backpressure,
concurrent senders and cancel/close. When no `polycall` CLI is found
(`POLYCALL_CLI` or `PATH`) the core suites are reported as **skipped**; set
`POLYCALL_REQUIRE_CLI=1` to make that a failure.

## License

MIT -- see [LICENSE](LICENSE).
