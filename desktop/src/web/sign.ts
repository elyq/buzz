/**
 * Event signing for the browser build.
 *
 * Ports the three signing paths the Tauri backend owns — arbitrary event
 * signing (`sign_event`), the NIP-42 relay handshake (`create_auth_event`) and
 * the NIP-98 HTTP `Authorization` header (`build_nip98_auth_header`) — onto the
 * in-page key held by `state`.
 */

import { finalizeEvent } from "nostr-tools/pure";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { requireSecretKey } from "@/web/state";

/** A signed Nostr event in the canonical seven-field wire shape. */
export type SignedEvent = {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
  sig: string;
};

/** NIP-98 HTTP Auth. */
const KIND_HTTP_AUTH = 27235;
/** NIP-42 relay authentication. */
const KIND_CLIENT_AUTH = 22242;

/** Sign an event template with the active identity. */
export function signEvent(template: {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
}): SignedEvent {
  return finalizeEvent(
    {
      kind: template.kind,
      content: template.content,
      tags: template.tags,
      created_at: template.created_at ?? Math.floor(Date.now() / 1000),
    },
    requireSecretKey(),
  ) as SignedEvent;
}

/** Sign the NIP-42 `AUTH` response for a relay challenge. */
export function signAuthEvent(input: {
  challenge: string;
  relayUrl: string;
}): SignedEvent {
  return signEvent({
    kind: KIND_CLIENT_AUTH,
    content: "",
    tags: [
      ["relay", input.relayUrl],
      ["challenge", input.challenge],
    ],
  });
}

/**
 * Build the `Authorization: Nostr <base64>` header for a relay HTTP request.
 *
 * Mirrors `build_nip98_auth_header_for_keys`: the `u`/`method` tags bind the
 * request, `payload` binds the body digest, and the random `nonce` keeps two
 * identical requests in the same second from colliding into one event id and
 * tripping the relay's replay detection.
 */
export function buildNip98AuthHeader(
  method: string,
  url: string,
  body: string,
): string {
  const event = signEvent({
    kind: KIND_HTTP_AUTH,
    content: "",
    tags: [
      ["u", url],
      ["method", method.toUpperCase()],
      ["payload", bytesToHex(sha256(new TextEncoder().encode(body)))],
      ["nonce", crypto.randomUUID()],
    ],
  });
  return `Nostr ${base64Utf8(JSON.stringify(event))}`;
}

/** `btoa` over UTF-8, which raw `btoa` cannot encode. */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
