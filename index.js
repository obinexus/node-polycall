'use strict';

// node-polycall: a dependency-free Node.js binding for Polycall.
//
//  * polycall_rpc v1 client  -- call(), callJson(), callRaw(), control()
//    against `polycall start` / `polycall daemon start` (docs/RPC.md)
//  * polycall-peer/1 peer    -- PeerNode (server + client) and the remote
//    helpers, interoperable with `polycall peer serve` and the C library's
//    polycall_peer_* nodes (docs/PEER_PROTOCOL.md)
//
// It speaks the wire protocols in plain JavaScript and needs no native addon
// or compiler. The optional `native` layer loads the real libpolycall
// through node:ffi (Node.js >= 26 with --experimental-ffi) for
// polycall_ffi_run_config / describe / call and the library version check.

const { Status, strerror, statusName, PolycallError } = require('./lib/status');
const common = require('./lib/common');
const rpc = require('./lib/rpc');
const peer = require('./lib/peer');
const native = require('./lib/native');
const pkg = require('./package.json');

/** Binding ABI generation whose semantics (status codes, limits) this package follows. */
const ABI_VERSION = 1;
/** polycall_rpc wire version spoken by the RPC client. */
const RPC_VERSION = 1;

/** This package's version. */
function version() {
  return pkg.version;
}

/** Always 1: the binding ABI v1 status codes and limits are what this package reports. */
function abiVersion() {
  return ABI_VERSION;
}

/**
 * Ask a running runtime / daemon for its health over the CONTROL channel and
 * check it is compatible: resolves {version, abi, ...}. Rejects E_PROTOCOL if
 * the reply carries no version.
 */
async function runtimeInfo(endpoint, options = {}) {
  const data = await rpc.control(endpoint, 'health', options);
  if (!data || typeof data.version !== 'string') {
    throw new PolycallError(Status.E_PROTOCOL, `${endpoint} did not report a runtime version`);
  }
  return data;
}

module.exports = Object.freeze({
  ABI_VERSION,
  RPC_VERSION,
  PROTOCOL: peer.PROTOCOL,
  Status,
  PolycallError,
  strerror,
  statusName,
  version,
  abiVersion,
  runtimeInfo,
  limits: Object.freeze({
    PEER_ID_MAX: common.PEER_ID_MAX,
    MESSAGE_ID_MAX: common.MESSAGE_ID_MAX,
    ENDPOINT_MAX: common.ENDPOINT_MAX,
    PEER_MAX_PAYLOAD: common.PEER_MAX_PAYLOAD,
    CALL_MAX_OUTPUT: common.CALL_MAX_OUTPUT,
    ...peer.limits
  }),
  isValidId: common.isValidId,
  call: rpc.call,
  callJson: rpc.callJson,
  callRaw: rpc.callRaw,
  control: rpc.control,
  frame: Object.freeze({
    FrameType: rpc.FrameType,
    HEADER_SIZE: rpc.HEADER_SIZE,
    MAX_PAYLOAD: rpc.MAX_PAYLOAD,
    encode: rpc.encodeFrame,
    decodeHeader: rpc.decodeHeader
  }),
  PeerNode: peer.PeerNode,
  openPeer: (nodeId, options) => peer.PeerNode.open(nodeId, options),
  remote: Object.freeze({
    health: peer.remoteHealth,
    peers: peer.remotePeers,
    register: peer.remoteRegister,
    inboxNext: peer.remoteInboxNext
  }),
  native: Object.freeze({
    ABI_VERSION: native.ABI_VERSION,
    SYMBOLS: native.SYMBOLS,
    NativeLibrary: native.NativeLibrary,
    available: native.available,
    platformNames: native.platformNames,
    load: native.load
  })
});
