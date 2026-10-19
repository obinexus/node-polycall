'use strict';

// One-request-per-connection HTTP/1.1 client for polycall-peer/1.

const http = require('node:http');
const { Status, fail } = require('./status');

const RESPONSE_MAX = 64 * 1024; // replies are small JSON documents (PEER_RESP_MAX)
const INBOX_RESPONSE_MAX = 4 * 1024 * 1024; // /inbox/next carries a base64 payload

const TRANSPORT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRNOTAVAIL', 'ERR_STREAM_DESTROYED'
]);

/**
 * Perform one exchange. Resolves {status, body (string), json (parsed or null)}.
 * Rejects E_TRANSPORT (refused/reset/unreachable), E_TIMEOUT (deadline),
 * E_PROTOCOL (not HTTP / oversized reply).
 */
function exchange({ host, port, method, path, token, body, timeoutMs, maxResponse = RESPONSE_MAX }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const headers = { Accept: 'application/json', 'User-Agent': 'node-polycall (polycall-peer/1)', Connection: 'close' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    } else if (method === 'POST') {
      headers['Content-Length'] = '0';
    }

    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        request.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };

    const request = http.request({ host, port, family: 4, method, path, headers, agent: false });
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => done(fail(Status.E_TIMEOUT, `timed out talking to ${host}:${port}`)), timeoutMs)
      : null;

    request.on('response', (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxResponse) {
          done(fail(Status.E_PROTOCOL, `reply from ${host}:${port} is too large`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_error) { json = null; }
        done(null, { status: response.statusCode, headers: response.headers, body: text, json });
      });
      response.on('error', (error) => done(fail(Status.E_TRANSPORT,
        `connection lost while reading the reply from ${host}:${port} (${error.code || error.message})`)));
    });
    request.on('error', (error) => {
      if (error && error.code && error.code.startsWith('HPE_')) {
        done(fail(Status.E_PROTOCOL, `${host}:${port} did not answer with HTTP (${error.code})`));
      } else if (error && TRANSPORT_CODES.has(error.code)) {
        done(fail(Status.E_TRANSPORT, `${host}:${port}: ${error.code}`));
      } else {
        done(fail(Status.E_TRANSPORT, `${host}:${port}: ${error && (error.code || error.message)}`));
      }
    });
    if (payload) request.end(payload); else request.end();
  });
}

/** Map an HTTP failure status to a binding status (same table as the C client). */
function statusFromHttp(httpStatus) {
  switch (httpStatus) {
    case 401: return Status.E_AUTH;
    case 413: return Status.E_TOO_LARGE;
    case 503: return Status.E_BUSY;
    case 400: return Status.E_REMOTE;
    case 404: case 405: case 501: case 505: return Status.E_PROTOCOL;
    default: return Status.E_REMOTE;
  }
}

function errorCode(reply) {
  const error = reply && reply.json && reply.json.error;
  return error && typeof error.code === 'string' ? error.code : '';
}

module.exports = { exchange, statusFromHttp, errorCode, RESPONSE_MAX, INBOX_RESPONSE_MAX };
