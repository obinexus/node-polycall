// ESM entry point: the same API as the CommonJS build.
import polycall from './index.js';

export default polycall;
export const {
  ABI_VERSION,
  RPC_VERSION,
  PROTOCOL,
  Status,
  PolycallError,
  strerror,
  statusName,
  version,
  abiVersion,
  runtimeInfo,
  limits,
  isValidId,
  call,
  callJson,
  callRaw,
  control,
  frame,
  PeerNode,
  openPeer,
  remote
} = polycall;
