/**
 * Active workspace state for the browser build.
 *
 * The Tauri build keeps the relay URL and the signing key in Rust (`AppState`
 * plus the on-disk `identity.key`). In the browser there is no backend, so the
 * same two values live here and are persisted by `identityStore`. Every
 * relay-backed command reads its scope from this module, so an identity or
 * community switch retargets the whole bridge at once.
 */

import { getPublicKey } from "nostr-tools/pure";

/** Relay URLs derived from a single configured community relay. */
export type RelayScope = {
  /** `ws://` or `wss://` origin used by the live subscription socket. */
  wsUrl: string;
  /** `http://` or `https://` origin used by `POST /query`, `/events`, media. */
  httpUrl: string;
};

type WorkspaceState = {
  scope: RelayScope | null;
  secretKey: Uint8Array | null;
  pubkey: string | null;
  /** Invite token captured at community setup, replayed on relay admission. */
  token: string | null;
};

const state: WorkspaceState = {
  scope: null,
  secretKey: null,
  pubkey: null,
  token: null,
};

/**
 * Normalize any relay URL spelling into the `ws`/`http` pair the app needs.
 *
 * The relay is host-scoped — it answers only on the host its community is
 * mapped to — so the host and port are preserved exactly and only the scheme
 * is translated.
 */
export function toRelayScope(relayUrl: string): RelayScope {
  const trimmed = relayUrl.trim().replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  const secure = parsed.protocol === "wss:" || parsed.protocol === "https:";
  const authority = parsed.host;
  return {
    wsUrl: `${secure ? "wss" : "ws"}://${authority}`,
    httpUrl: `${secure ? "https" : "http"}://${authority}`,
  };
}

/** Point the bridge at a relay. Clears nothing else — identity is separate. */
export function setRelayScope(relayUrl: string): RelayScope {
  const scope = toRelayScope(relayUrl);
  state.scope = scope;
  return scope;
}

/** The active relay scope, or `null` before a community has been applied. */
export function relayScope(): RelayScope | null {
  return state.scope;
}

/**
 * The active relay scope, or a thrown error.
 *
 * Commands that cannot answer without a relay use this so the failure surfaces
 * as a normal rejected invoke rather than a silent empty result.
 */
export function requireRelayScope(): RelayScope {
  if (!state.scope) {
    throw new Error("No relay is configured for this browser session.");
  }
  return state.scope;
}

/** Install the signing key for this session. Pass `null` to sign out. */
export function setSecretKey(secretKey: Uint8Array | null): void {
  state.secretKey = secretKey;
  state.pubkey = secretKey ? getPublicKey(secretKey) : null;
}

/** The active signing key, or `null` when no identity is loaded. */
export function secretKey(): Uint8Array | null {
  return state.secretKey;
}

/** The active signing key, or a thrown error when none is loaded. */
export function requireSecretKey(): Uint8Array {
  if (!state.secretKey) {
    throw new Error("No identity is loaded in this browser session.");
  }
  return state.secretKey;
}

/** Hex public key of the active identity, or `null` when signed out. */
export function pubkey(): string | null {
  return state.pubkey;
}

/** Hex public key of the active identity, or a thrown error when signed out. */
export function requirePubkey(): string {
  if (!state.pubkey) {
    throw new Error("No identity is loaded in this browser session.");
  }
  return state.pubkey;
}

/** Record the invite token captured during community setup. */
export function setToken(token: string | null): void {
  state.token = token;
}

/** The invite token for the active community, when one was supplied. */
export function token(): string | null {
  return state.token;
}
