'use strict';

// polycall_rpc v1 client (docs/RPC.md): a 16-byte PCR1 header followed by a
// UTF-8 JSON payload. One TCP connection, one frame each way, never retried.

const net = require('node:net');
const crypto = require('node:crypto');
const { Status, fail } = require('./status');
const { parseEndpoint, checkTimeout, CALL_MAX_OUTPUT } = require('./common');

const MAGIC = Buffer.from('PCR1', 'ascii');
const HEADER_SIZE = 16;
const MAX_PAYLOAD = 1 << 20;
const FrameType = Object.freeze({ REQUEST: 1, RESPONSE: 2, CONTROL: 3, CONTROL_REPLY: 4 });
const MAX_TIMEOUT_MS = 600000;
const TRANSPORT_SLACK_MS = 2000; // same slack the C client adds over the deadline

/** Encode one frame. `payload` is a string (UTF-8) or a Buffer. */
function encodeFrame(type, corr, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (body.length > MAX_PAYLOAD) {
    throw fail(Status.E_TOO_LARGE, `frame payload of ${body.length} bytes exceeds the 1 MiB limit`);
  }
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt8(type, 4);
  header.writeUInt8(0, 5);
  header.writeUInt16BE(0, 6);
  header.writeUInt32BE(corr >>> 0, 8);
  header.writeUInt32BE(body.length, 12);
  return Buffer.concat([header, body]);
}

/**
 * Decode a frame header. Returns {type, flags, corr, length} or throws
 * E_PROTOCOL for a bad magic / oversize length.
 */
function decodeHeader(buf) {
  if (buf.length < HEADER_SIZE) throw fail(Status.E_PROTOCOL, 'short frame header');
  if (!buf.subarray(0, 4).equals(MAGIC)) throw fail(Status.E_PROTOCOL, 'bad frame magic (expected PCR1)');
  const length = buf.readUInt32BE(12);
  if (length > MAX_PAYLOAD) throw fail(Status.E_PROTOCOL, `frame length ${length} exceeds 1 MiB`);
  return { type: buf.readUInt8(4), flags: buf.readUInt8(5), corr: buf.readUInt32BE(8), length };
}

function exchange(endpoint, type, payload, waitMs) {
  const ep = parseEndpoint(endpoint);
  if (!ep) return Promise.reject(fail(Status.E_INVALID_ARGUMENT, 'endpoint must be host:port'));
  const corr = crypto.randomBytes(4).readUInt32BE(0);
  let frame;
  try {
    frame = encodeFrame(type, corr, payload);
  } catch (error) {
    return Promise.reject(error);
  }
  const expectedType = type === FrameType.REQUEST ? FrameType.RESPONSE : FrameType.CONTROL_REPLY;

  return new Promise((resolve, reject) => {
    let settled = false;
    let chunks = [];
    let have = 0;
    let header = null;
    const socket = net.connect({ host: ep.host, port: ep.port, family: 4 });

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(fail(Status.E_TIMEOUT, `no reply from ${endpoint} within the deadline`));
    }, waitMs);

    socket.on('connect', () => socket.write(frame));
    socket.on('data', (data) => {
      chunks.push(data);
      have += data.length;
      try {
        if (!header && have >= HEADER_SIZE) {
          const all = Buffer.concat(chunks);
          chunks = [all];
          header = decodeHeader(all);
        }
        if (header && have >= HEADER_SIZE + header.length) {
          const all = Buffer.concat(chunks);
          if (header.type !== expectedType) {
            throw fail(Status.E_PROTOCOL, `${endpoint} answered with frame type ${header.type}`);
          }
          if (header.corr !== corr) {
            throw fail(Status.E_PROTOCOL, `${endpoint} answered with correlation id ${header.corr}, expected ${corr}`);
          }
          finish(null, all.subarray(HEADER_SIZE, HEADER_SIZE + header.length).toString('utf8'));
        }
      } catch (error) {
        finish(error.status ? error : fail(Status.E_PROTOCOL, `${endpoint} sent a malformed frame`));
      }
    });
    socket.on('error', (error) => {
      finish(fail(Status.E_TRANSPORT, `cannot reach a polycall runtime at ${endpoint} (${error.code || error.message})`));
    });
    socket.on('close', () => {
      finish(fail(Status.E_TRANSPORT, `${endpoint} closed the connection before a complete reply`));
    });
  });
}

function parseReply(endpoint, text) {
  let reply;
  try {
    reply = JSON.parse(text);
  } catch (_error) {
    throw fail(Status.E_PROTOCOL, `reply from ${endpoint} is not JSON`);
  }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    throw fail(Status.E_PROTOCOL, `reply from ${endpoint} is not a JSON object`);
  }
  return reply;
}

function statusForRemoteCode(code) {
  switch (code) {
    case 'server.busy': return Status.E_BUSY;
    case 'operation.unknown': return Status.E_NOT_FOUND;
    case 'deadline.exceeded': return Status.E_TIMEOUT;
    case 'auth.denied': return Status.E_AUTH;
    default: return Status.E_REMOTE;
  }
}

function serializeInput(input) {
  if (input === undefined) return 'null';
  let text;
  try {
    text = JSON.stringify(input);
  } catch (error) {
    throw fail(Status.E_INVALID_ARGUMENT, `input is not JSON-serializable: ${error.message}`);
  }
  if (text === undefined) throw fail(Status.E_INVALID_ARGUMENT, 'input is not JSON-serializable');
  return text;
}

function requestPayload(service, operation, inputJson, timeoutMs) {
  if (typeof service !== 'string' || service === '' || typeof operation !== 'string' || operation === '') {
    throw fail(Status.E_INVALID_ARGUMENT, 'service and operation are required');
  }
  checkTimeout(timeoutMs, { min: 1, max: MAX_TIMEOUT_MS });
  return `{"service":${JSON.stringify(service)},"operation":${JSON.stringify(operation)},` +
    `"deadline_ms":${timeoutMs},"input":${inputJson}}`;
}

/**
 * One polycall_rpc v1 round trip. Resolves to the RESPONSE payload exactly as
 * received (a JSON text) -- success or operation failure alike. Rejects only
 * for argument, transport, deadline and protocol failures.
 */
async function callRaw(endpoint, service, operation, input = null, { timeoutMs = 5000 } = {}) {
  const payload = requestPayload(service, operation, serializeInput(input), timeoutMs);
  return exchange(endpoint, FrameType.REQUEST, payload,
    Math.min(MAX_TIMEOUT_MS, timeoutMs + TRANSPORT_SLACK_MS));
}

function settle(endpoint, service, operation, text, maxOutput) {
  const reply = parseReply(endpoint, text);
  if (reply.ok === true) {
    const output = reply.output === undefined ? null : reply.output;
    const outputJson = JSON.stringify(output);
    if (Buffer.byteLength(outputJson) >= maxOutput) {
      throw fail(Status.E_TOO_LARGE, `reply output exceeds ${maxOutput} bytes (the operation already ran)`);
    }
    return { output, outputJson };
  }
  const error = reply.error && typeof reply.error === 'object' ? reply.error : {};
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  throw fail(statusForRemoteCode(code),
    `${service}.${operation} failed remotely: ${message || 'error'} (${code || 'unknown'})`,
    { remote: { code, message }, remoteJson: JSON.stringify(reply.error === undefined ? null : reply.error) });
}

/**
 * Call SERVICE.OPERATION on a running runtime / daemon and resolve to the
 * operation's output value. Mirrors polycall_call(): E_NOT_FOUND for
 * operation.unknown, E_TIMEOUT for deadline.exceeded, E_BUSY, E_AUTH,
 * otherwise E_REMOTE with `error.remote = {code, message}`.
 */
async function call(endpoint, service, operation, input = null, options = {}) {
  const { timeoutMs = 5000, maxOutput = CALL_MAX_OUTPUT } = options;
  const text = await callRaw(endpoint, service, operation, input, { timeoutMs });
  return settle(endpoint, service, operation, text, maxOutput).output;
}

/**
 * Same as call() but takes and returns JSON text, like polycall_call()'s
 * input_json / out. `inputJson` null -> null; invalid JSON -> E_INVALID_ARGUMENT
 * before any I/O.
 */
async function callJson(endpoint, service, operation, inputJson = null, options = {}) {
  const { timeoutMs = 5000, maxOutput = CALL_MAX_OUTPUT } = options;
  let input = null;
  if (inputJson !== null && inputJson !== undefined) {
    if (typeof inputJson !== 'string') throw fail(Status.E_INVALID_ARGUMENT, 'inputJson must be a string');
    try {
      input = JSON.parse(inputJson);
    } catch (error) {
      throw fail(Status.E_INVALID_ARGUMENT, `input_json is not valid JSON: ${error.message}`);
    }
  }
  const text = await callRaw(endpoint, service, operation, input, { timeoutMs });
  return settle(endpoint, service, operation, text, maxOutput).outputJson;
}

/**
 * A CONTROL request (`ping`, `health`, `describe`, `shutdown`). Resolves to
 * the reply's `data`; a `{"ok":false}` reply rejects (auth.denied -> E_AUTH).
 */
async function control(endpoint, action, { authToken, timeoutMs = 5000 } = {}) {
  if (typeof action !== 'string' || action === '') throw fail(Status.E_INVALID_ARGUMENT, 'action is required');
  checkTimeout(timeoutMs, { min: 1, max: MAX_TIMEOUT_MS });
  const body = { action };
  if (authToken) body.auth_token = String(authToken);
  const text = await exchange(endpoint, FrameType.CONTROL, JSON.stringify(body), timeoutMs);
  const reply = parseReply(endpoint, text);
  if (reply.ok === true) return reply.data === undefined ? null : reply.data;
  const error = reply.error && typeof reply.error === 'object' ? reply.error : {};
  const code = typeof error.code === 'string' ? error.code : '';
  throw fail(statusForRemoteCode(code), `control '${action}' failed: ${error.message || code || 'error'}`,
    { remote: { code, message: error.message || '' } });
}

module.exports = {
  FrameType,
  MAGIC,
  HEADER_SIZE,
  MAX_PAYLOAD,
  encodeFrame,
  decodeHeader,
  call,
  callJson,
  callRaw,
  control
};
