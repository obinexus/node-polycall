// Type definitions for @obinexuscomputing/node-polycall
// (polycall_rpc v1 client + polycall-peer/1 peer, plain Node.js)

/// <reference types="node" />

/** Binding ABI v1 status codes (polycall.h). */
export declare const Status: Readonly<{
  OK: 0;
  E_INVALID_ARGUMENT: -1;
  E_NO_MEMORY: -2;
  E_INVALID_HANDLE: -3;
  E_TIMEOUT: -4;
  E_TRANSPORT: -5;
  E_PROTOCOL: -6;
  E_NOT_FOUND: -7;
  E_AUTH: -8;
  E_REMOTE: -9;
  E_TOO_LARGE: -10;
  E_BUSY: -11;
  E_CANCELLED: -12;
  E_CONFIG: -13;
  E_ADDRESS_IN_USE: -14;
  E_UNSUPPORTED: -15;
  E_PERMISSION: -16;
  E_CLOSED: -17;
  E_INTERNAL: -18;
}>;

export type StatusCode = (typeof Status)[keyof typeof Status];

/** The error every failing call rejects / throws with. */
export declare class PolycallError extends Error {
  constructor(status: number, detail?: string, extra?: Record<string, unknown>);
  readonly name: 'PolycallError';
  /** Negative POLYCALL_E_* value. */
  readonly status: number;
  /** "POLYCALL_E_TIMEOUT" etc. (same as statusName). */
  readonly code: string;
  readonly statusName: string;
  /** polycall_strerror() text, e.g. "POLYCALL_E_TIMEOUT: deadline exceeded". */
  readonly strerror: string;
  /** What polycall_last_error() would hold for the same failure. */
  readonly detail: string;
  /** Remote error object for E_REMOTE / E_NOT_FOUND / E_TIMEOUT / E_BUSY / E_AUTH replies. */
  readonly remote?: { code: string; message: string };
  /** JSON text of the remote error object (call / callJson). */
  readonly remoteJson?: string;
  /** HTTP status of a rejected peer request. */
  readonly httpStatus?: number;
  /** recv(): bytes the queued message needs when maxBytes was too small. */
  readonly needed?: number;
  /** send(): the message id used (retry with the same id). */
  readonly messageId?: string;
}

export declare const ABI_VERSION: 1;
export declare const RPC_VERSION: 1;
export declare const PROTOCOL: 'polycall-peer/1';

export declare function strerror(status: number): string;
export declare function statusName(status: number): string;
export declare function version(): string;
export declare function abiVersion(): 1;
export declare function isValidId(value: unknown): boolean;

export interface Limits {
  readonly PEER_ID_MAX: 64;
  readonly MESSAGE_ID_MAX: 64;
  readonly ENDPOINT_MAX: 128;
  readonly PEER_MAX_PAYLOAD: 1048576;
  readonly CALL_MAX_OUTPUT: 1048576;
  readonly MAX_CONNECTIONS: number;
  readonly MAX_REGISTRY: number;
  readonly INBOX_CAPACITY: number;
  readonly INBOX_BYTES: number;
  readonly DEDUP_WINDOW: number;
  readonly MAX_HEADER_BYTES: number;
  readonly MAX_BODY_BYTES: number;
  readonly MAX_PATH_BYTES: number;
  readonly INBOX_WAIT_MAX_MS: number;
}
export declare const limits: Limits;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CallOptions {
  /** 1..600000, default 5000; sent as deadline_ms. */
  timeoutMs?: number;
  /** Largest accepted output JSON (bytes), default 1 MiB. */
  maxOutput?: number;
}

/** Call SERVICE.OPERATION; resolves to the operation's output value. */
export declare function call(endpoint: string, service: string, operation: string,
  input?: unknown, options?: CallOptions): Promise<JsonValue>;
/** JSON text in, output JSON text out (like polycall_call()). */
export declare function callJson(endpoint: string, service: string, operation: string,
  inputJson?: string | null, options?: CallOptions): Promise<string>;
/** The RESPONSE payload exactly as received (success and failure alike). */
export declare function callRaw(endpoint: string, service: string, operation: string,
  input?: unknown, options?: { timeoutMs?: number }): Promise<string>;
/** A CONTROL request: 'ping' | 'health' | 'describe' | 'shutdown'. */
export declare function control(endpoint: string, action: string,
  options?: { authToken?: string; timeoutMs?: number }): Promise<any>;

export interface RuntimeInfo {
  status: string;
  version: string;
  abi: number;
  [key: string]: unknown;
}
export declare function runtimeInfo(endpoint: string,
  options?: { authToken?: string; timeoutMs?: number }): Promise<RuntimeInfo>;

export declare const frame: Readonly<{
  FrameType: Readonly<{ REQUEST: 1; RESPONSE: 2; CONTROL: 3; CONTROL_REPLY: 4 }>;
  HEADER_SIZE: 16;
  MAX_PAYLOAD: 1048576;
  encode(type: number, corr: number, payload: string | Buffer): Buffer;
  decodeHeader(buf: Buffer): { type: number; flags: number; corr: number; length: number };
}>;

export type Payload = Buffer | Uint8Array | ArrayBuffer | string;

export interface Message {
  /** Sender node id. */
  from: string;
  /** Message id. */
  id: string;
  /** Exact bytes. */
  payload: Buffer;
}

export interface PeerHealth {
  ok: true;
  protocol: 'polycall-peer/1';
  node_id: string;
  endpoint: string;
  status: 'ok' | 'stopping';
  peers: number;
  inbox: number;
  inbox_capacity: number;
  received: number;
  duplicates: number;
  rejected_busy: number;
  rejected_malformed: number;
  rejected_auth: number;
  sent_ok: number;
  sent_failed: number;
  uptime_ms: number;
  auth: boolean;
  implementation: string;
  registry?: Record<string, string>;
}

export interface OpenOptions {
  /** "host:port" to listen on (port 0 = ephemeral); omit for a send-only node. */
  bind?: string | null;
  /** Shared token ('' = none); required by this node and presented to peers. */
  authToken?: string;
  /** Inbox capacity in messages, 1..256 (default 256). */
  inboxCapacity?: number;
}

export declare class PeerNode {
  private constructor();
  static open(nodeId: string, options?: OpenOptions): Promise<PeerNode>;
  /** Bound "host:port" ('' for a send-only node). */
  readonly endpoint: string;
  readonly nodeId: string;
  readonly closed: boolean;
  register(peerId: string, endpoint: string): void;
  unregister(peerId: string): void;
  list(): Record<string, string>;
  health(): PeerHealth;
  ping(peer: string, options?: { timeoutMs?: number }): Promise<PeerHealth>;
  send(peer: string, payload: Payload,
    options?: { messageId?: string; timeoutMs?: number }): Promise<{ id: string; nodeId: string; duplicate: boolean }>;
  /** timeoutMs: 0 = poll, Infinity (default) = until a message, cancel() or close(). */
  recv(options?: { timeoutMs?: number; maxBytes?: number }): Promise<Message>;
  cancel(): void;
  close(): Promise<void>;
}

export declare function openPeer(nodeId: string, options?: OpenOptions): Promise<PeerNode>;

export declare const remote: Readonly<{
  health(endpoint: string, options?: { timeoutMs?: number }): Promise<PeerHealth>;
  peers(endpoint: string, options?: { authToken?: string; timeoutMs?: number }): Promise<Record<string, string>>;
  register(endpoint: string, id: string, peerEndpoint: string,
    options?: { authToken?: string; timeoutMs?: number }): Promise<{ ok: true; registered: string }>;
  inboxNext(endpoint: string, options?: { authToken?: string; timeoutMs?: number }): Promise<Message | null>;
}>;
