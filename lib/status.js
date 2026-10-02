'use strict';

// Status codes of the Polycall binding ABI v1 (polycall.h, docs/BINDING_ABI.md).
// node-polycall speaks the wire protocols directly, so it reports the same
// codes and names the C library would, and never invents new ones.

const Status = Object.freeze({
  OK: 0,
  E_INVALID_ARGUMENT: -1,
  E_NO_MEMORY: -2,
  E_INVALID_HANDLE: -3,
  E_TIMEOUT: -4,
  E_TRANSPORT: -5,
  E_PROTOCOL: -6,
  E_NOT_FOUND: -7,
  E_AUTH: -8,
  E_REMOTE: -9,
  E_TOO_LARGE: -10,
  E_BUSY: -11,
  E_CANCELLED: -12,
  E_CONFIG: -13,
  E_ADDRESS_IN_USE: -14,
  E_UNSUPPORTED: -15,
  E_PERMISSION: -16,
  E_CLOSED: -17,
  E_INTERNAL: -18
});

// Exactly the strings polycall_strerror() returns (src/core/status.c).
const STRERROR = Object.freeze({
  0: 'POLYCALL_OK: success',
  [-1]: 'POLYCALL_E_INVALID_ARGUMENT: invalid argument',
  [-2]: 'POLYCALL_E_NO_MEMORY: out of memory',
  [-3]: 'POLYCALL_E_INVALID_HANDLE: unknown, closed or stale handle',
  [-4]: 'POLYCALL_E_TIMEOUT: deadline exceeded',
  [-5]: 'POLYCALL_E_TRANSPORT: peer unreachable, refused or reset',
  [-6]: 'POLYCALL_E_PROTOCOL: malformed or unexpected reply',
  [-7]: 'POLYCALL_E_NOT_FOUND: not found',
  [-8]: 'POLYCALL_E_AUTH: authentication failed',
  [-9]: 'POLYCALL_E_REMOTE: remote side reported an error',
  [-10]: 'POLYCALL_E_TOO_LARGE: exceeds a limit or the buffer',
  [-11]: 'POLYCALL_E_BUSY: queue or connection limit reached',
  [-12]: 'POLYCALL_E_CANCELLED: cancelled',
  [-13]: 'POLYCALL_E_CONFIG: invalid configuration',
  [-14]: 'POLYCALL_E_ADDRESS_IN_USE: address already in use',
  [-15]: 'POLYCALL_E_UNSUPPORTED: not supported by this build',
  [-16]: 'POLYCALL_E_PERMISSION: permission denied',
  [-17]: 'POLYCALL_E_CLOSED: handle closed',
  [-18]: 'POLYCALL_E_INTERNAL: internal error'
});
const UNKNOWN = 'POLYCALL_E_UNKNOWN: unknown status code';

/** Same contract as polycall_strerror(): a static, never-empty name. */
function strerror(status) {
  return Object.prototype.hasOwnProperty.call(STRERROR, status) ? STRERROR[status] : UNKNOWN;
}

/** "POLYCALL_E_TIMEOUT" for -4, "POLYCALL_E_UNKNOWN" for an unknown code. */
function statusName(status) {
  const text = strerror(status);
  return text.slice(0, text.indexOf(':'));
}

/**
 * The one error type node-polycall throws / rejects with. It carries the
 * numeric status, its name, and the detail message (what polycall_last_error
 * would hold for the same failure in the C library).
 */
class PolycallError extends Error {
  constructor(status, detail, extra) {
    const name = statusName(status);
    super(detail ? `${name}: ${detail}` : strerror(status));
    this.name = 'PolycallError';
    this.status = status;
    this.code = name;
    this.statusName = name;
    this.strerror = strerror(status);
    this.detail = detail || '';
    if (extra && typeof extra === 'object') {
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined) this[key] = value;
      }
    }
  }
}

function fail(status, detail, extra) {
  return new PolycallError(status, detail, extra);
}

module.exports = { Status, strerror, statusName, PolycallError, fail };
