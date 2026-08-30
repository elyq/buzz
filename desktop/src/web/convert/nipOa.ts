/**
 * NIP-OA (Owner Attestation) verification.
 *
 * A kind:0 profile marks its subject as an agent by carrying an `auth` tag the
 * owner signed for the agent's key. Ported from `profile_valid_oa_owner_pubkey`
 * in `src-tauri/src/nostr_convert.rs` and its `buzz-sdk` verifier, and matching
 * `mobile/lib/shared/crypto/nip_oa.dart` line for line.
 *
 * Verification is against the *profile event's author*, so a forged or stale
 * marker copied onto someone else's profile cannot turn a person into an agent
 * in mention search.
 *
 *   tag       ["auth", "<owner pubkey hex>", "<conditions>", "<sig hex>"]
 *   preimage  "nostr:agent-auth:" + agent pubkey hex + ":" + conditions
 *   signature BIP-340 Schnorr over SHA-256(preimage), by the owner key
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";

const CLAUSE_PATTERN = /^(?:kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/;
const MAX_CLAUSE_VALUE = 4294967295;
const MAX_KIND = 65535;

/**
 * Validate the `conditions` string: empty, or `&`-joined clauses of `kind=<n>`,
 * `created_at<<n>` or `created_at><n>` written in canonical decimal.
 */
function validConditions(conditions: string): boolean {
  if (conditions.length === 0) {
    return true;
  }
  if (/\s/.test(conditions)) {
    return false;
  }
  for (const clause of conditions.split("&")) {
    const match = CLAUSE_PATTERN.exec(clause);
    if (!match) {
      return false;
    }
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value > MAX_CLAUSE_VALUE) {
      return false;
    }
    if (clause.startsWith("kind=") && value > MAX_KIND) {
      return false;
    }
  }
  return true;
}

/**
 * The owner pubkey attested by the first valid `auth` tag, or `null`.
 *
 * `agentPubkey` must be the pubkey of the event the tags came from.
 */
export function verifiedOaOwnerPubkey(
  tags: string[][],
  agentPubkey: string,
): string | null {
  const agent = agentPubkey.toLowerCase();

  for (const tag of tags) {
    if (tag.length !== 4 || tag[0] !== "auth") {
      continue;
    }
    const owner = tag[1].toLowerCase();
    const conditions = tag[2];
    const sig = tag[3];

    // Self-attestation proves nothing, so it is rejected outright.
    if (owner === agent || owner.length !== 64 || sig.length !== 128) {
      continue;
    }
    if (!validConditions(conditions)) {
      continue;
    }

    try {
      const digest = sha256(
        new TextEncoder().encode(`nostr:agent-auth:${agent}:${conditions}`),
      );
      if (schnorr.verify(hexToBytes(sig), digest, hexToBytes(owner))) {
        return owner;
      }
    } catch {
      // Malformed hex is an invalid tag, not a hard failure — keep scanning
      // the remaining tags for a valid attestation.
    }
  }

  return null;
}
