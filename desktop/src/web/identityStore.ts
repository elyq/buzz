/**
 * Browser persistence for the Buzz signing identity.
 *
 * The Tauri build stores the secret key in an OS keyring plus an `identity.key`
 * file. A browser has neither, so the key is held in `localStorage` for this
 * origin — the same trade-off the Flutter client makes when it keeps an `nsec`
 * in per-community storage. The key never leaves the page: it is used only to
 * sign events locally, and the relay only ever receives signatures.
 *
 * Callers must treat the stored value as sensitive. It is deliberately kept out
 * of every other storage key so a quota sweep or community reset cannot drop it.
 */

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { decode, nsecEncode } from "nostr-tools/nip19";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const SECRET_KEY_STORAGE_KEY = "buzz-web-identity.v1";
const DISPLAY_NAME_STORAGE_KEY = "buzz-web-identity-display-name.v1";

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private-mode WebKit throws on any storage access. A missing identity is
    // recoverable (onboarding runs again); a thrown error blanks the app.
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Non-fatal: the session keeps working, the identity just will not survive
    // a reload. Surfacing this as a hard failure would block onboarding.
  }
}

/**
 * Parse an `nsec…` bech32 string or a 64-character hex key into raw bytes.
 *
 * Accepting both matches `import_identity` in the Tauri build, which takes
 * whichever spelling the user pastes.
 */
export function parseSecretKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed.toLowerCase());
  }
  const decoded = decode(trimmed);
  if (decoded.type !== "nsec") {
    throw new Error("Expected an nsec private key.");
  }
  return decoded.data;
}

/** Encode a raw secret key as the `nsec…` string the UI shows and exports. */
export function encodeSecretKey(secretKey: Uint8Array): string {
  return nsecEncode(secretKey);
}

/** The persisted secret key for this origin, or `null` when none is stored. */
export function loadStoredSecretKey(): Uint8Array | null {
  const stored = readStorage(SECRET_KEY_STORAGE_KEY);
  if (!stored) {
    return null;
  }
  try {
    const secretKey = parseSecretKey(stored);
    // Reject anything that cannot produce a public key rather than letting a
    // corrupt entry fail later inside the relay auth handshake.
    getPublicKey(secretKey);
    return secretKey;
  } catch {
    writeStorage(SECRET_KEY_STORAGE_KEY, null);
    return null;
  }
}

/** Persist `secretKey` for this origin, or clear it when passed `null`. */
export function storeSecretKey(secretKey: Uint8Array | null): void {
  writeStorage(
    SECRET_KEY_STORAGE_KEY,
    secretKey === null ? null : bytesToHex(secretKey),
  );
}

/** Create a fresh identity. The caller is responsible for persisting it. */
export function createSecretKey(): Uint8Array {
  return generateSecretKey();
}

/** Locally cached display name, shown before the kind:0 profile resolves. */
export function loadStoredDisplayName(): string {
  return readStorage(DISPLAY_NAME_STORAGE_KEY) ?? "";
}

/** Cache the display name resolved from the identity's kind:0 profile. */
export function storeDisplayName(displayName: string | null): void {
  writeStorage(DISPLAY_NAME_STORAGE_KEY, displayName?.trim() || null);
}
