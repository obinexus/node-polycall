'use strict';

// Optional native layer: the REAL libpolycall, loaded through Node's built-in
// FFI (`node:ffi`: Node.js >= 26; 26.7 needs --experimental-ffi, 26.10 has it
// on by default; it is still experimental). It needs no addon and no
// compiler. The rest of node-polycall (RPC client, PeerNode) speaks the wire
// protocols and works without it.
//
// Loading follows docs/BINDING_ABI.md: $POLYCALL_LIBRARY (or options.path)
// first, then the platform name (polycall.dll / libpolycall.dll on Windows,
// libpolycall.so.1 on Linux, libpolycall.1.dylib on macOS). Every symbol is
// resolved up front and polycall_ffi_abi_version() must be 1; a missing
// library, a missing symbol (a 1.0 library) or another ABI is a clear
// PolycallError naming the library -- never a crash on first use.
//
// The library never returns memory to free: every output goes into a Buffer
// this module owns (snprintf rules), and polycall_strerror() returns a static
// string that is only read.

const { Status, fail } = require('./status');
const { CALL_MAX_OUTPUT } = require('./common');

const ABI_VERSION = 1;
const SIZE_T = process.arch === 'ia32' || process.arch === 'arm' ? 'uint32' : 'uint64';
const SIGNATURES = Object.freeze({
  polycall_ffi_abi_version: { return: 'int32', arguments: [] },
  polycall_ffi_version: { return: 'int32', arguments: ['buffer', 'int32'] },
  polycall_strerror: { return: 'pointer', arguments: ['int32'] },
  polycall_last_error: { return: 'int32', arguments: ['buffer', SIZE_T] },
  polycall_ffi_run_config: { return: 'int32', arguments: ['string', 'int32'] },
  polycall_ffi_describe: { return: 'int32', arguments: ['string', 'buffer', 'int32'] },
  polycall_call: {
    return: 'int32',
    arguments: ['string', 'string', 'string', 'string', 'uint32', 'buffer', SIZE_T, 'buffer']
  }
});
const SYMBOLS = Object.freeze(Object.keys(SIGNATURES));
const REMOTE_STATUSES = new Set([Status.E_REMOTE, Status.E_NOT_FOUND, Status.E_TIMEOUT, Status.E_BUSY, Status.E_AUTH]);

let ffiModule;
let ffiError;

/** node:ffi, or null (with the reason in ffiError) when this Node.js has none. */
function loadFfi() {
  if (ffiModule !== undefined) return ffiModule;
  try {
    ffiModule = require('node:ffi');
  } catch (error) {
    ffiModule = null;
    ffiError = `node:ffi is not available in Node.js ${process.version} (${error.code || error.message}); ` +
      'native loading needs Node.js >= 26 with node:ffi enabled (start it with --experimental-ffi, ' +
      'or NODE_OPTIONS=--experimental-ffi, where FFI is not on by default)';
  }
  return ffiModule;
}

/** {ok, reason}: whether this runtime can load libpolycall at all. */
function available() {
  return loadFfi() ? { ok: true, reason: '' } : { ok: false, reason: ffiError };
}

/** Library names tried, in order, when no explicit path is given. */
function platformNames(platform = process.platform) {
  if (platform === 'win32') return ['polycall.dll', 'libpolycall.dll'];
  if (platform === 'darwin') return ['libpolycall.1.dylib'];
  return ['libpolycall.so.1'];
}

const sizeArg = (n) => (SIZE_T === 'uint64' ? BigInt(n) : n);
const readSize = (buf) => (SIZE_T === 'uint64' ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0));
const cString = (buf, n) => buf.toString('utf8', 0, Math.max(0, Math.min(n, buf.length - 1)));

function requireText(value, name, { allowNull = false } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw fail(Status.E_INVALID_ARGUMENT, `${name} must be a string`);
  }
  if (typeof value !== 'string') throw fail(Status.E_INVALID_ARGUMENT, `${name} must be a string`);
  if (value.includes('\0')) throw fail(Status.E_INVALID_ARGUMENT, `${name} must not contain NUL characters`);
  return value;
}

/** A loaded, ABI-checked libpolycall. Create it with load(). */
class NativeLibrary {
  constructor(dynamicLibrary, functions, path) {
    this._lib = dynamicLibrary;
    this._fn = functions;
    this._closed = false;
    /** The name or path that was loaded. */
    this.path = path;
  }

  _f() {
    if (this._closed) throw fail(Status.E_INVALID_HANDLE, `${this.path} was closed`);
    return this._fn;
  }

  /** polycall_ffi_abi_version() of the loaded library (1). */
  abiVersion() {
    return this._f().polycall_ffi_abi_version();
  }

  /** polycall_ffi_version(): the library version, e.g. "1.1.0". */
  version() {
    const f = this._f();
    let buf = Buffer.alloc(32);
    let n = f.polycall_ffi_version(buf, buf.length);
    if (n >= buf.length) {
      buf = Buffer.alloc(n + 1);
      n = f.polycall_ffi_version(buf, buf.length);
    }
    if (n < 0) throw fail(n, 'polycall_ffi_version failed');
    return cString(buf, n);
  }

  /** polycall_strerror(status): the library's own static name for a code. */
  strerror(status) {
    if (!Number.isInteger(status) || status < -0x80000000 || status > 0x7fffffff) {
      throw fail(Status.E_INVALID_ARGUMENT, 'status must be a 32-bit integer');
    }
    const pointer = this._f().polycall_strerror(status);
    if (!pointer) throw fail(Status.E_INTERNAL, 'polycall_strerror returned NULL');
    return loadFfi().toString(pointer);
  }

  /** polycall_last_error(): this thread's detail for its most recent failed call. */
  lastError() {
    const f = this._f();
    let buf = Buffer.alloc(1024);
    let n = f.polycall_last_error(buf, sizeArg(buf.length));
    if (n >= buf.length) {
      buf = Buffer.alloc(n + 1);
      n = f.polycall_last_error(buf, sizeArg(buf.length));
    }
    return cString(buf, n);
  }

  _error(status, fallback, extra) {
    const detail = this.lastError() || fallback;
    return fail(status, detail, { native: true, library: this.path, ...extra });
  }

  /**
   * polycall_ffi_run_config(path, strict ? 1 : 0). strict (the default) is
   * "validate for running with this build": unknown keys are errors and
   * tls_enabled=true is E_UNSUPPORTED. Returns Status.OK or throws
   * PolycallError (E_INVALID_ARGUMENT, E_NOT_FOUND, E_CONFIG, E_UNSUPPORTED).
   */
  runConfig(configPath, strict = true) {
    const file = requireText(configPath, 'configPath', { allowNull: true });
    const status = this._f().polycall_ffi_run_config(file, strict ? 1 : 0);
    if (status !== Status.OK) throw this._error(status, `run_config(${configPath}) failed`);
    return Status.OK;
  }

  /** polycall_ffi_describe(path): the parsed JSON description of a configuration file. */
  describe(configPath) {
    const f = this._f();
    const file = requireText(configPath, 'configPath', { allowNull: true });
    let buf = Buffer.alloc(4096); // grown to the exact size when the description is longer
    let n = f.polycall_ffi_describe(file, buf, buf.length);
    if (n >= buf.length) {
      buf = Buffer.alloc(n + 1);
      n = f.polycall_ffi_describe(file, buf, buf.length);
    }
    if (n < 0) throw this._error(n, `describe(${configPath}) failed`);
    return JSON.parse(cString(buf, n));
  }

  /**
   * polycall_call(): one polycall_rpc v1 round trip, executed once and never
   * retried. SYNCHRONOUS -- it blocks the event loop for up to timeoutMs;
   * prefer the asynchronous call() / callJson() of this package in servers.
   * Returns the operation's output JSON text. Failures throw PolycallError;
   * for E_REMOTE / E_NOT_FOUND / E_TIMEOUT / E_BUSY / E_AUTH replies
   * `error.remoteJson` / `error.remote` carry the remote error object, and
   * E_TOO_LARGE carries `error.needed` (the operation already ran).
   */
  callSync(endpoint, service, operation, inputJson = null, { timeoutMs = 5000, maxOutput = CALL_MAX_OUTPUT } = {}) {
    const f = this._f();
    const args = [
      requireText(endpoint, 'endpoint', { allowNull: true }),
      requireText(service, 'service', { allowNull: true }),
      requireText(operation, 'operation', { allowNull: true }),
      requireText(inputJson, 'inputJson', { allowNull: true })
    ];
    // uint32 domain only; the library itself enforces 1..600000.
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 0xffffffff) {
      throw fail(Status.E_INVALID_ARGUMENT, 'timeoutMs must be an integer 0..4294967295');
    }
    if (!Number.isInteger(maxOutput) || maxOutput < 0 || maxOutput > CALL_MAX_OUTPUT) {
      throw fail(Status.E_INVALID_ARGUMENT, `maxOutput must be an integer 0..${CALL_MAX_OUTPUT}`);
    }
    const out = Buffer.alloc(maxOutput + 1);
    const outLen = Buffer.alloc(8);
    const status = f.polycall_call(...args, timeoutMs, out, sizeArg(out.length), outLen);
    const length = readSize(outLen);
    if (status === Status.OK) return cString(out, length);
    if (status === Status.E_TOO_LARGE) {
      throw this._error(status, 'output buffer too small', { needed: length });
    }
    if (REMOTE_STATUSES.has(status) && length > 0) {
      const remoteJson = cString(out, length);
      let remote;
      try {
        const parsed = JSON.parse(remoteJson);
        remote = { code: String(parsed.code || ''), message: String(parsed.message || '') };
      } catch (_error) {
        remote = undefined;
      }
      throw this._error(status, `${service}.${operation} failed`, { remoteJson, remote });
    }
    throw this._error(status, `${service}.${operation} failed`);
  }

  /** Release this handle (dlclose). Later calls throw E_INVALID_HANDLE; a second close is a no-op. */
  close() {
    if (this._closed) return;
    this._closed = true;
    this._lib.close();
  }

  get closed() {
    return this._closed;
  }
}

function describeLoadFailure(error) {
  return (error && (error.message || String(error))) || 'unknown error';
}

/**
 * Load libpolycall and check it. options.path wins, then $POLYCALL_LIBRARY,
 * then the platform names. An explicit path that cannot be loaded is an
 * error (never silently replaced by another library). Throws PolycallError:
 * E_UNSUPPORTED (no node:ffi, missing ABI v1 symbol, ABI mismatch) or
 * E_NOT_FOUND (library not loadable), with `library` set.
 */
function load(options = {}) {
  const ffi = loadFfi();
  if (!ffi) throw fail(Status.E_UNSUPPORTED, ffiError, { native: true });

  const env = options.env || process.env;
  const explicit = options.path || env.POLYCALL_LIBRARY || '';
  const candidates = explicit ? [explicit] : platformNames();
  const failures = [];
  let dynamicLibrary = null;
  let loaded = null;
  for (const candidate of candidates) {
    try {
      dynamicLibrary = new ffi.DynamicLibrary(candidate);
      loaded = candidate;
      break;
    } catch (error) {
      failures.push(`${candidate}: ${describeLoadFailure(error)}`);
    }
  }
  if (!dynamicLibrary) {
    const how = explicit
      ? `${options.path ? 'options.path' : 'POLYCALL_LIBRARY'}=${explicit} cannot be loaded`
      : `libpolycall not found (tried ${candidates.join(', ')}; set POLYCALL_LIBRARY to its path)`;
    throw fail(Status.E_NOT_FOUND, `${how}: ${failures.join('; ')}`, { native: true, library: explicit || candidates.join(', ') });
  }

  const functions = {};
  for (const symbol of SYMBOLS) {
    try {
      functions[symbol] = dynamicLibrary.getFunction(symbol, SIGNATURES[symbol]);
    } catch (error) {
      dynamicLibrary.close();
      throw fail(Status.E_UNSUPPORTED,
        `${loaded} does not export ${symbol}: it is not a libpolycall with binding ABI ${ABI_VERSION} ` +
        `(polycall >= 1.1.0) (${describeLoadFailure(error)})`, { native: true, library: loaded, symbol });
    }
  }
  const abi = functions.polycall_ffi_abi_version();
  if (abi !== ABI_VERSION) {
    dynamicLibrary.close();
    throw fail(Status.E_UNSUPPORTED,
      `${loaded} implements binding ABI ${abi}; node-polycall needs ABI ${ABI_VERSION}`,
      { native: true, library: loaded, abi });
  }
  return new NativeLibrary(dynamicLibrary, functions, loaded);
}

module.exports = {
  ABI_VERSION,
  SYMBOLS,
  NativeLibrary,
  available,
  platformNames,
  load
};
