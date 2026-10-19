'use strict';

const { Status, fail } = require('./status');

// Limits shared with polycall.h.
const PEER_ID_MAX = 64; // buffer size incl. NUL -> ids are 1..63 bytes
const MESSAGE_ID_MAX = 64;
const ENDPOINT_MAX = 128;
const PEER_MAX_PAYLOAD = 1 << 20;
const CALL_MAX_OUTPUT = 1 << 20;

const ID_RE = /^[A-Za-z0-9._-]{1,63}$/;
const HOST_RE = /^[A-Za-z0-9._-]+$/;

/** True for a node / peer / message id: 1-63 bytes of [A-Za-z0-9._-]. */
function isValidId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

/**
 * Parse "host:port" the way the C library does (IPv4 dotted quad or a DNS
 * name; no IPv6). Returns {host, port} or null.
 */
function parseEndpoint(value, { allowPortZero = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length >= ENDPOINT_MAX) return null;
  const colon = value.lastIndexOf(':');
  if (colon <= 0 || colon === value.length - 1) return null;
  const host = value.slice(0, colon);
  const portText = value.slice(colon + 1);
  if (!HOST_RE.test(host) || !/^[0-9]+$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port > 65535 || (port === 0 && !allowPortZero)) return null;
  return { host, port };
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host.startsWith('127.');
}

/** Validate a timeout in ms; Infinity / -1 mean "wait indefinitely" when allowed. */
function checkTimeout(value, { name = 'timeoutMs', min = 0, max = 0xffffffff, allowInfinite = false } = {}) {
  if (allowInfinite && (value === Infinity || value === -1)) return Infinity;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw fail(Status.E_INVALID_ARGUMENT,
      `${name} must be an integer ${min}..${max}${allowInfinite ? ' (or Infinity)' : ''}`);
  }
  return value;
}

/** Bytes of a payload argument: Buffer, Uint8Array, ArrayBuffer or UTF-8 string. */
function toBuffer(payload) {
  if (payload === undefined || payload === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  throw fail(Status.E_INVALID_ARGUMENT, 'payload must be a Buffer, Uint8Array, ArrayBuffer or string');
}

module.exports = {
  PEER_ID_MAX,
  MESSAGE_ID_MAX,
  ENDPOINT_MAX,
  PEER_MAX_PAYLOAD,
  CALL_MAX_OUTPUT,
  isValidId,
  parseEndpoint,
  isLoopbackHost,
  checkTimeout,
  toBuffer
};
