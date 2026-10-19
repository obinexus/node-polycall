'use strict';

// polycall-peer/1 (docs/PEER_PROTOCOL.md) in plain Node: a peer node owns
// its registry and inbox, listens over HTTP/1.1 + JSON, and delivers payloads
// directly to other nodes -- C (`polycall peer serve`, polycall_peer_*) or
// any other conforming implementation. No broker, no native addon.

const http = require('node:http');
const dns = require('node:dns');
const crypto = require('node:crypto');
const { Status, fail, PolycallError } = require('./status');
const {
  PEER_MAX_PAYLOAD, isValidId, parseEndpoint, isLoopbackHost, checkTimeout, toBuffer
} = require('./common');
const { exchange, statusFromHttp, errorCode, INBOX_RESPONSE_MAX } = require('./http-client');
const pkg = require('../package.json');

const PROTOCOL = 'polycall-peer/1';
const MAX_CONNECTIONS = 32;
const MAX_REGISTRY = 64;
const INBOX_CAPACITY = 256;
const INBOX_BYTES = 64 * 1024 * 1024;
const DEDUP_WINDOW = 1024;
const HEADER_TIMEOUT_MS = 5000;
const BODY_TIMEOUT_MS = 10000;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PATH_BYTES = 255;
const INBOX_WAIT_MAX_MS = 30000;
const DEFAULT_TIMEOUT_MS = 5000;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const KNOWN_PATHS = new Set(['/health', '/peers', '/receive', '/register', '/inbox/next']);
const REASONS = {
  200: 'OK', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 405: 'Method Not Allowed',
  408: 'Request Timeout', 409: 'Conflict', 411: 'Length Required', 413: 'Payload Too Large',
  414: 'URI Too Long', 431: 'Request Header Fields Too Large', 500: 'Internal Server Error',
  501: 'Not Implemented', 503: 'Service Unavailable', 505: 'HTTP Version Not Supported'
};

/** Strict, canonical, padded standard base64 -> Buffer, or null. */
function decodeBase64(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !B64_RE.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}

function secretEqual(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b) && String(given).length === String(expected).length;
}

function errorBody(code, message) {
  return JSON.stringify({ ok: false, error: { code, message } });
}

function writeJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  const payload = Buffer.from(body, 'utf8');
  res.writeHead(status, REASONS[status] || 'Status', {
    Server: PROTOCOL,
    Connection: 'close',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Content-Length': String(payload.length),
    ...extraHeaders
  });
  res.end(payload);
}

function rawResponse(status, code, message, extra = '') {
  const body = errorBody(code, message);
  return `HTTP/1.1 ${status} ${REASONS[status] || 'Status'}\r\nServer: ${PROTOCOL}\r\nConnection: close\r\n` +
    `Cache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
    `${extra}\r\n${body}`;
}

/** Resolve a bind/connect host to an IPv4 address (the protocol is IPv4-only). */
async function resolveV4(host) {
  if (/^[0-9.]+$/.test(host)) return host;
  const { address } = await dns.promises.lookup(host, { family: 4 });
  return address;
}

class PeerNode {
  #nodeId;
  #token;
  #endpoint = '';
  #server = null;
  #sockets = new Set();
  #closed = false;
  #stopping = false;
  #registry = new Map();
  #inbox = [];
  #inboxBytes = 0;
  #inboxCapacity;
  #waiters = [];
  #dedupRing = [];
  #dedupSet = new Set();
  #startedMs = Date.now();
  #stats = {
    received: 0, duplicates: 0, rejected_busy: 0, rejected_malformed: 0,
    rejected_auth: 0, sent_ok: 0, sent_failed: 0
  };

  constructor(secret, nodeId, token, inboxCapacity) {
    if (secret !== PeerNode.#construct) {
      throw new TypeError('use PeerNode.open(nodeId, options) to create a peer node');
    }
    this.#nodeId = nodeId;
    this.#token = token;
    this.#inboxCapacity = inboxCapacity;
  }

  static #construct = Symbol('PeerNode.construct');

  /**
   * Open a node. `bind` "host:port" (port 0 = ephemeral) makes it listen;
   * omitted/null = send-only. `authToken` ('' = none) is required by this
   * node on every request except GET /health and presented to peers.
   */
  static async open(nodeId, { bind = null, authToken = '', inboxCapacity = INBOX_CAPACITY } = {}) {
    if (!isValidId(nodeId)) {
      throw fail(Status.E_INVALID_ARGUMENT, 'node_id must be 1-63 characters of [A-Za-z0-9._-]');
    }
    const token = authToken === undefined || authToken === null ? '' : String(authToken);
    if (Buffer.byteLength(token) >= 256) throw fail(Status.E_INVALID_ARGUMENT, 'auth_token longer than 255 bytes');
    if (!Number.isInteger(inboxCapacity) || inboxCapacity < 1 || inboxCapacity > INBOX_CAPACITY) {
      throw fail(Status.E_INVALID_ARGUMENT, `inboxCapacity must be 1..${INBOX_CAPACITY}`);
    }
    const node = new PeerNode(PeerNode.#construct, nodeId, token, inboxCapacity);
    if (bind !== null && bind !== undefined) {
      const ep = parseEndpoint(bind, { allowPortZero: true });
      if (!ep) throw fail(Status.E_INVALID_ARGUMENT, `bind_endpoint '${bind}' is not host:port`);
      if (!isLoopbackHost(ep.host) && token === '') {
        throw fail(Status.E_CONFIG, `refusing to listen on non-loopback '${ep.host}' without an auth token`);
      }
      await node.#listen(ep);
    }
    return node;
  }

  async #listen(ep) {
    let address;
    try {
      address = await resolveV4(ep.host);
    } catch (error) {
      throw fail(Status.E_TRANSPORT, `cannot resolve '${ep.host}': ${error.code || error.message}`);
    }
    const server = http.createServer({
      maxHeaderSize: MAX_HEADER_BYTES,
      headersTimeout: HEADER_TIMEOUT_MS,
      requestTimeout: HEADER_TIMEOUT_MS + BODY_TIMEOUT_MS,
      keepAliveTimeout: 1000,
      connectionsCheckingInterval: 250,
      requireHostHeader: false
    }, (req, res) => {
      this.#serve(req, res).catch((error) => {
        writeJson(res, 500, errorBody('internal', error && error.message ? error.message : 'internal error'));
      });
    });
    server.on('connection', (socket) => {
      socket.polycallAdmitted = !this.#stopping && this.#sockets.size < MAX_CONNECTIONS;
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    server.on('clientError', (error, socket) => {
      if (!socket.writable) { socket.destroy(); return; }
      let status = 400;
      if (error.code === 'HPE_HEADER_OVERFLOW') status = 431;
      else if (error.code === 'ERR_HTTP_REQUEST_TIMEOUT') status = 408;
      else if (error.code === 'HPE_INVALID_TRANSFER_ENCODING' || error.code === 'HPE_UNEXPECTED_CONTENT_LENGTH') status = 501;
      if (status === 400) this.#stats.rejected_malformed += 1;
      socket.end(rawResponse(status, 'http.rejected', REASONS[status]));
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE') reject(fail(Status.E_ADDRESS_IN_USE, `cannot listen on ${ep.host}:${ep.port}: address in use`));
        else if (error.code === 'EACCES' || error.code === 'EPERM') reject(fail(Status.E_PERMISSION, `cannot listen on ${ep.host}:${ep.port}: ${error.code}`));
        else reject(fail(Status.E_TRANSPORT, `cannot listen on ${ep.host}:${ep.port}: ${error.code || error.message}`));
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: address, port: ep.port, backlog: 64, exclusive: true });
    });
    server.on('error', () => {});
    this.#server = server;
    this.#endpoint = `${ep.host}:${server.address().port}`;
  }

  // ------------------------------------------------------------------ state

  #check() {
    if (this.#closed) throw fail(Status.E_INVALID_HANDLE, `peer node '${this.#nodeId}' is closed`);
  }

  /** Bound "host:port" ('' for a send-only node). */
  get endpoint() { this.#check(); return this.#endpoint; }

  get nodeId() { this.#check(); return this.#nodeId; }

  get closed() { return this.#closed; }

  /** Add or replace peerId -> endpoint in THIS node's registry. */
  register(peerId, endpoint) {
    if (!isValidId(peerId)) throw fail(Status.E_INVALID_ARGUMENT, 'peer_id must be 1-63 characters of [A-Za-z0-9._-]');
    if (!parseEndpoint(endpoint)) throw fail(Status.E_INVALID_ARGUMENT, 'endpoint must be host:port (port 1-65535)');
    this.#check();
    if (!this.#registry.has(peerId) && this.#registry.size >= MAX_REGISTRY) {
      throw fail(Status.E_TOO_LARGE, `peer registry is full (max ${MAX_REGISTRY})`);
    }
    this.#registry.set(peerId, endpoint);
  }

  /** Remove peerId; E_NOT_FOUND when it is not registered. */
  unregister(peerId) {
    if (typeof peerId !== 'string' || peerId === '') throw fail(Status.E_INVALID_ARGUMENT, 'peer_id is empty');
    this.#check();
    if (!this.#registry.delete(peerId)) throw fail(Status.E_NOT_FOUND, `peer '${peerId}' is not registered`);
  }

  /** THIS node's registry as a plain object {id: "host:port"}. */
  list() {
    this.#check();
    return Object.fromEntries(this.#registry);
  }

  #healthObject(withRegistry) {
    const body = {
      ok: true,
      protocol: PROTOCOL,
      node_id: this.#nodeId,
      endpoint: this.#endpoint,
      status: this.#stopping ? 'stopping' : 'ok',
      peers: this.#registry.size,
      inbox: this.#inbox.length,
      inbox_capacity: this.#inboxCapacity,
      ...this.#stats,
      uptime_ms: Date.now() - this.#startedMs,
      auth: this.#token !== '',
      implementation: `node-polycall ${pkg.version}`
    };
    if (withRegistry) body.registry = Object.fromEntries(this.#registry);
    return body;
  }

  /** This node's health (node id, endpoint, peers, inbox, counters, registry). */
  health() {
    this.#check();
    return this.#healthObject(true);
  }

  #resolveTarget(peer) {
    const registered = this.#registry.get(peer);
    const endpoint = registered !== undefined ? registered : peer;
    if (registered === undefined && !peer.includes(':')) {
      throw fail(Status.E_NOT_FOUND, `peer '${peer}' is not registered on node '${this.#nodeId}'`);
    }
    const ep = parseEndpoint(endpoint);
    if (!ep) throw fail(Status.E_INVALID_ARGUMENT, `'${endpoint}' is not host:port`);
    return { ...ep, expected: registered !== undefined ? peer : '' };
  }

  /**
   * GET /health on `peer` (registered id or "host:port"). Resolves to the
   * peer's health object only when it answers healthy -- and, for a
   * registered id, under that id (E_PROTOCOL otherwise).
   */
  async ping(peer, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof peer !== 'string' || peer === '') throw fail(Status.E_INVALID_ARGUMENT, 'peer is empty');
    checkTimeout(timeoutMs);
    this.#check();
    const target = this.#resolveTarget(peer);
    const reply = await exchange({ ...target, method: 'GET', path: '/health', timeoutMs });
    const body = reply.json;
    if (reply.status !== 200 || !body || typeof body.node_id !== 'string' || typeof body.status !== 'string') {
      throw fail(Status.E_PROTOCOL, `${target.host}:${target.port} is not a healthy polycall peer (HTTP ${reply.status})`);
    }
    if (target.expected && body.node_id !== target.expected) {
      throw fail(Status.E_PROTOCOL, `${target.host}:${target.port} answers as '${body.node_id}', expected '${target.expected}'`);
    }
    if (body.status !== 'ok') throw fail(Status.E_BUSY, `peer '${body.node_id}' reports status '${body.status}'`);
    return body;
  }

  /**
   * Deliver `payload` (<= 1 MiB, binary-safe) to `peer`. Exactly one
   * delivery attempt; resolves {id, nodeId, duplicate} only on the
   * receiver's acknowledgement. Retry with the SAME messageId after a
   * failure: the receiver drops duplicates.
   */
  async send(peer, payload, { messageId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof peer !== 'string' || peer === '') throw fail(Status.E_INVALID_ARGUMENT, 'peer is empty');
    const bytes = toBuffer(payload);
    if (bytes.length > PEER_MAX_PAYLOAD) {
      throw fail(Status.E_TOO_LARGE, `payload of ${bytes.length} bytes exceeds the 1 MiB limit`);
    }
    let id = messageId;
    if (id === undefined || id === null || id === '') {
      id = crypto.randomUUID();
    } else if (!isValidId(id)) {
      throw fail(Status.E_INVALID_ARGUMENT, 'message_id must be 1-63 characters of [A-Za-z0-9._-]');
    }
    checkTimeout(timeoutMs);
    this.#check();
    let target;
    try {
      target = this.#resolveTarget(peer);
    } catch (error) {
      this.#stats.sent_failed += 1;
      throw error;
    }
    const body = `{"v":1,"id":${JSON.stringify(id)},"from":${JSON.stringify(this.#nodeId)},` +
      `"payload_b64":"${bytes.toString('base64')}"}`;
    try {
      const reply = await exchange({
        host: target.host, port: target.port, method: 'POST', path: '/receive',
        token: this.#token, body, timeoutMs
      });
      if (reply.status !== 200) {
        const code = errorCode(reply);
        throw fail(statusFromHttp(reply.status),
          `${target.host}:${target.port} refused '${id}' (HTTP ${reply.status} ${code || REASONS[reply.status] || ''})`.trim(),
          { httpStatus: reply.status, remote: code ? { code, message: reply.json.error.message || '' } : undefined });
      }
      const ack = reply.json;
      if (!ack || ack.ok !== true || ack.id !== id || typeof ack.node_id !== 'string') {
        throw fail(Status.E_PROTOCOL, `${target.host}:${target.port} answered 200 without acknowledging message '${id}'`);
      }
      if (target.expected && ack.node_id !== target.expected) {
        throw fail(Status.E_PROTOCOL, `message '${id}' was acknowledged by '${ack.node_id}', expected '${target.expected}'`);
      }
      this.#stats.sent_ok += 1;
      return { id, nodeId: ack.node_id, duplicate: ack.duplicate === true };
    } catch (error) {
      this.#stats.sent_failed += 1;
      if (error instanceof PolycallError && error.status === Status.E_TRANSPORT) {
        error.message = `${error.statusName}: delivery of '${id}' to ${target.host}:${target.port} failed: ${error.detail}`;
        error.detail = `delivery of '${id}' to ${target.host}:${target.port} failed: ${error.detail}`;
      }
      error.messageId = id;
      throw error;
    }
  }

  // ------------------------------------------------------------ inbox

  #pump() {
    while (this.#waiters.length > 0 && this.#inbox.length > 0) {
      const waiter = this.#waiters[0];
      const message = this.#inbox[0];
      if (waiter.maxBytes !== undefined && message.payload.length > waiter.maxBytes) {
        this.#waiters.shift();
        clearTimeout(waiter.timer);
        waiter.reject(fail(Status.E_TOO_LARGE,
          `payload buffer too small: message needs ${message.payload.length} bytes`,
          { needed: message.payload.length }));
        continue;
      }
      this.#waiters.shift();
      this.#inbox.shift();
      this.#inboxBytes -= message.payload.length;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  #wait(timeoutMs, maxBytes, label) {
    if (this.#inbox.length > 0 && this.#waiters.length === 0) {
      const message = this.#inbox[0];
      if (maxBytes !== undefined && message.payload.length > maxBytes) {
        return Promise.reject(fail(Status.E_TOO_LARGE,
          `payload buffer too small: message needs ${message.payload.length} bytes`,
          { needed: message.payload.length }));
      }
      this.#inbox.shift();
      this.#inboxBytes -= message.payload.length;
      return Promise.resolve(message);
    }
    if (timeoutMs === 0) {
      return Promise.reject(fail(Status.E_TIMEOUT, `no message within 0 ms`));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, maxBytes, label, timer: null };
      if (Number.isFinite(timeoutMs)) {
        waiter.timer = setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(fail(Status.E_TIMEOUT, `no message within ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.#waiters.push(waiter);
      this.#pump();
    });
  }

  /**
   * Take the oldest received message: resolves {from, id, payload: Buffer}.
   * timeoutMs 0 = poll, Infinity = until a message, cancel() or close().
   * With maxBytes, a larger message rejects E_TOO_LARGE (error.needed) and
   * stays queued.
   */
  recv({ timeoutMs = Infinity, maxBytes } = {}) {
    try {
      const timeout = checkTimeout(timeoutMs, { allowInfinite: true });
      if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 0)) {
        throw fail(Status.E_INVALID_ARGUMENT, 'maxBytes must be a non-negative integer');
      }
      this.#check();
      return this.#wait(timeout, maxBytes, 'recv');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Wake every recv() currently waiting on this node with E_CANCELLED. */
  cancel() {
    this.#check();
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(fail(Status.E_CANCELLED, 'receive was cancelled'));
    }
  }

  /**
   * Stop the listener, wake blocked receivers with E_CLOSED and release
   * everything. A second close() rejects E_INVALID_HANDLE.
   */
  async close() {
    if (this.#closed) throw fail(Status.E_INVALID_HANDLE, `peer node '${this.#nodeId}' is already closed`);
    this.#stopping = true;
    this.#closed = true;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(fail(Status.E_CLOSED, 'peer node closed while waiting'));
    }
    if (this.#server) {
      const server = this.#server;
      this.#server = null;
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        for (const socket of this.#sockets) socket.destroy();
      });
    }
    this.#inbox = [];
    this.#inboxBytes = 0;
    this.#registry.clear();
  }

  // ------------------------------------------------------------ server

  #store(from, id, payload) {
    const key = `${from}\u001f${id}`;
    if (this.#dedupSet.has(key)) {
      this.#stats.duplicates += 1;
      return { duplicate: true };
    }
    if (this.#inbox.length >= this.#inboxCapacity || this.#inboxBytes + payload.length > INBOX_BYTES) {
      this.#stats.rejected_busy += 1;
      return { busy: true };
    }
    this.#inbox.push({ from, id, payload });
    this.#inboxBytes += payload.length;
    this.#stats.received += 1;
    this.#dedupRing.push(key);
    this.#dedupSet.add(key);
    if (this.#dedupRing.length > DEDUP_WINDOW) this.#dedupSet.delete(this.#dedupRing.shift());
    this.#pump();
    return { duplicate: false };
  }

  #authorized(req) {
    if (this.#token === '') return true;
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    return secretEqual(header.slice(7), this.#token);
  }

  #readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(Object.assign(new Error('body too large'), { httpStatus: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
      req.on('aborted', () => reject(Object.assign(new Error('aborted'), { httpStatus: 0 })));
    });
  }

  async #serve(req, res) {
    req.on('error', () => {});
    res.on('error', () => {});
    if (!req.socket.polycallAdmitted) {
      this.#stats.rejected_busy += 1;
      const stopping = this.#stopping;
      writeJson(res, 503, errorBody(stopping ? 'node.stopping' : 'server.busy',
        stopping ? 'node is shutting down' : 'too many concurrent connections; retry later'),
      { 'Retry-After': '1' });
      req.resume();
      return;
    }
    if (req.headers['transfer-encoding'] !== undefined) {
      writeJson(res, 501, errorBody('http.rejected', REASONS[501]));
      req.resume();
      return;
    }
    if (Buffer.byteLength(req.url) > MAX_PATH_BYTES) {
      writeJson(res, 414, errorBody('http.rejected', REASONS[414]));
      req.resume();
      return;
    }
    if (req.httpVersion !== '1.1' && req.httpVersion !== '1.0') {
      writeJson(res, 505, errorBody('http.rejected', REASONS[505]));
      req.resume();
      return;
    }
    const lengthHeader = req.headers['content-length'];
    const length = lengthHeader === undefined ? -1 : Number(lengthHeader);
    if (req.method === 'POST' && lengthHeader === undefined) {
      writeJson(res, 411, errorBody('http.rejected', REASONS[411]));
      req.resume();
      return;
    }
    if (length > MAX_BODY_BYTES) {
      this.#stats.rejected_malformed += 1;
      writeJson(res, 413, errorBody('http.rejected', REASONS[413]));
      req.resume();
      return;
    }
    let body;
    try {
      body = await this.#readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error.httpStatus === 413) {
        this.#stats.rejected_malformed += 1;
        writeJson(res, 413, errorBody('http.rejected', REASONS[413]));
      }
      return;
    }

    const path = req.url;
    if (path === '/health') {
      if (req.method !== 'GET') {
        writeJson(res, 405, errorBody('http.method', 'use GET'), { Allow: 'GET' });
      } else {
        writeJson(res, 200, JSON.stringify(this.#healthObject(false)));
      }
      return;
    }
    if (!KNOWN_PATHS.has(path)) {
      writeJson(res, 404, errorBody('http.not_found', 'unknown path'));
      return;
    }
    if (!this.#authorized(req)) {
      this.#stats.rejected_auth += 1;
      writeJson(res, 401, errorBody(req.headers.authorization ? 'auth.denied' : 'auth.required',
        'this node requires its shared token (Authorization: Bearer)'), { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    if (path === '/peers') {
      if (req.method !== 'GET') {
        writeJson(res, 405, errorBody('http.method', 'use GET'), { Allow: 'GET' });
      } else {
        writeJson(res, 200, JSON.stringify({ ok: true, node_id: this.#nodeId, peers: Object.fromEntries(this.#registry) }));
      }
      return;
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, errorBody('http.method', 'use POST'), { Allow: 'POST' });
      return;
    }
    if (path === '/receive') this.#handleReceive(res, body);
    else if (path === '/register') this.#handleRegister(res, body);
    else await this.#handleInboxNext(res, body);
  }

  #handleReceive(res, body) {
    let message;
    try {
      message = JSON.parse(body.toString('utf8'));
    } catch (_error) {
      message = null;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#stats.rejected_malformed += 1;
      writeJson(res, 400, errorBody('request.malformed', 'body is not a JSON object'));
      return;
    }
    if (message.v !== 1) {
      this.#stats.rejected_malformed += 1;
      writeJson(res, 400, errorBody('protocol.version', 'expected "v":1'));
      return;
    }
    const { from, id } = message;
    const payloadB64 = message.payload_b64;
    if (!isValidId(from) || !isValidId(id) || typeof payloadB64 !== 'string') {
      this.#stats.rejected_malformed += 1;
      writeJson(res, 400, errorBody('request.malformed',
        'need string from, id ([A-Za-z0-9._-]{1,63}) and payload_b64'));
      return;
    }
    const payload = decodeBase64(payloadB64);
    if (!payload) {
      this.#stats.rejected_malformed += 1;
      writeJson(res, 400, errorBody('request.malformed', 'payload_b64 is not valid base64'));
      return;
    }
    if (payload.length > PEER_MAX_PAYLOAD) {
      this.#stats.rejected_malformed += 1;
      writeJson(res, 413, errorBody('payload.too_large', 'payload exceeds 1 MiB'));
      return;
    }
    const stored = this.#store(from, id, payload);
    if (stored.busy) {
      writeJson(res, 503, errorBody('inbox.full', 'receiver inbox is full; retry later with the same id'),
        { 'Retry-After': '1' });
      return;
    }
    writeJson(res, 200, JSON.stringify({
      ok: true, status: 'received', node_id: this.#nodeId, id, duplicate: stored.duplicate
    }));
  }

  #handleRegister(res, body) {
    let request = null;
    try { request = JSON.parse(body.toString('utf8')); } catch (_error) { request = null; }
    const id = request && request.node_id;
    const endpoint = request && request.endpoint;
    if (!isValidId(id) || !parseEndpoint(endpoint)) {
      writeJson(res, 400, errorBody('request.malformed', 'need node_id ([A-Za-z0-9._-]{1,63}) and endpoint host:port'));
      return;
    }
    if (!this.#registry.has(id) && this.#registry.size >= MAX_REGISTRY) {
      writeJson(res, 409, errorBody('registry.full', 'peer registry is full'));
      return;
    }
    this.#registry.set(id, endpoint);
    writeJson(res, 200, JSON.stringify({ ok: true, registered: id }));
  }

  async #handleInboxNext(res, body) {
    let request;
    try { request = JSON.parse(body.length ? body.toString('utf8') : '{}'); } catch (_error) { request = null; }
    let timeoutMs = -1;
    if (request && typeof request === 'object' && !Array.isArray(request)) {
      timeoutMs = request.timeout_ms === undefined ? 0 : request.timeout_ms;
    }
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > INBOX_WAIT_MAX_MS) {
      writeJson(res, 400, errorBody('request.malformed', 'timeout_ms must be 0..30000'));
      return;
    }
    let message = null;
    try {
      message = await this.#wait(Math.floor(timeoutMs), undefined, 'http');
    } catch (_error) {
      message = null; // timeout, cancel or close: "no message"
    }
    if (!message) {
      writeJson(res, 200, '{"ok":true,"message":null}');
      return;
    }
    writeJson(res, 200, `{"ok":true,"message":{"from":${JSON.stringify(message.from)},` +
      `"id":${JSON.stringify(message.id)},"payload_b64":"${message.payload.toString('base64')}"}}`);
  }
}

// ------------------------------------------------------------------ remote
// Out-of-process helpers: talk to any running polycall-peer/1 node (the
// same requests `polycall peer health|peers|register|recv` make).

function remoteTarget(endpoint) {
  const ep = parseEndpoint(endpoint);
  if (!ep) throw fail(Status.E_INVALID_ARGUMENT, `'${endpoint}' is not host:port`);
  return ep;
}

function remoteFailure(reply, what) {
  const code = errorCode(reply);
  return fail(statusFromHttp(reply.status), `${what}: HTTP ${reply.status}${code ? ` ${code}` : ''}`,
    { httpStatus: reply.status, remote: code ? { code, message: reply.json.error.message || '' } : undefined });
}

/** GET /health of a node (no token needed). */
async function remoteHealth(endpoint, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ep = remoteTarget(endpoint);
  const reply = await exchange({ ...ep, method: 'GET', path: '/health', timeoutMs });
  if (reply.status !== 200 || !reply.json) throw remoteFailure(reply, `health of ${endpoint}`);
  return reply.json;
}

/** GET /peers: the node's own registry. */
async function remotePeers(endpoint, { authToken = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ep = remoteTarget(endpoint);
  const reply = await exchange({ ...ep, method: 'GET', path: '/peers', token: authToken, timeoutMs });
  if (reply.status !== 200 || !reply.json) throw remoteFailure(reply, `peers of ${endpoint}`);
  return reply.json.peers;
}

/** POST /register: add id -> peerEndpoint to the remote node's registry. */
async function remoteRegister(endpoint, id, peerEndpoint, { authToken = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ep = remoteTarget(endpoint);
  const body = JSON.stringify({ node_id: id, endpoint: peerEndpoint });
  const reply = await exchange({ ...ep, method: 'POST', path: '/register', token: authToken, body, timeoutMs });
  if (reply.status !== 200 || !reply.json) throw remoteFailure(reply, `register on ${endpoint}`);
  return reply.json;
}

/**
 * POST /inbox/next: take the oldest message from a running node's inbox.
 * Resolves {from, id, payload} or null when none arrived within timeoutMs.
 */
async function remoteInboxNext(endpoint, { authToken = '', timeoutMs = 0 } = {}) {
  checkTimeout(timeoutMs, { max: INBOX_WAIT_MAX_MS });
  const ep = remoteTarget(endpoint);
  const reply = await exchange({
    ...ep, method: 'POST', path: '/inbox/next', token: authToken,
    body: JSON.stringify({ timeout_ms: timeoutMs }), timeoutMs: timeoutMs + 5000, maxResponse: INBOX_RESPONSE_MAX
  });
  if (reply.status !== 200 || !reply.json) throw remoteFailure(reply, `inbox of ${endpoint}`);
  const message = reply.json.message;
  if (message === null || message === undefined) return null;
  const payload = decodeBase64(message.payload_b64);
  if (!payload || !isValidId(message.from) || !isValidId(message.id)) {
    throw fail(Status.E_PROTOCOL, `${endpoint} returned a malformed message`);
  }
  return { from: message.from, id: message.id, payload };
}

module.exports = {
  PROTOCOL,
  PeerNode,
  decodeBase64,
  remoteHealth,
  remotePeers,
  remoteRegister,
  remoteInboxNext,
  limits: Object.freeze({
    MAX_CONNECTIONS, MAX_REGISTRY, INBOX_CAPACITY, INBOX_BYTES, DEDUP_WINDOW,
    MAX_HEADER_BYTES, MAX_BODY_BYTES, MAX_PATH_BYTES, INBOX_WAIT_MAX_MS
  })
};
