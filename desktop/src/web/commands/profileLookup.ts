/**
 * Shared kind:0 profile resolution.
 *
 * Ports `profile_info_from_event`. Several commands need the same lookup —
 * channel rosters, the users batch, the agent directory — so the parse and the
 * "latest event wins" rule live here rather than in each of them.
 */

import { queryRelay } from "@/web/relayHttp";
import type { SignedEvent } from "@/web/sign";
import { newestByAuthor } from "@/web/convert/tags";
import { verifiedOaOwnerPubkey } from "@/web/convert/nipOa";

/** Wire shape of a profile, matching `ProfileInfo` in the Tauri backend. */
export type RawProfile = {
  pubkey: string;
  display_name: string | null;
  avatar_url: string | null;
  about: string | null;
  nip05_handle: string | null;
  owner_pubkey: string | null;
  has_profile_event: boolean;
};

/** A profile record for a pubkey with no kind:0 event on the relay. */
export function emptyProfile(pubkey: string): RawProfile {
  return {
    pubkey,
    display_name: null,
    avatar_url: null,
    about: null,
    nip05_handle: null,
    owner_pubkey: null,
    has_profile_event: false,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Convert a kind:0 metadata event into a profile record. */
export function profileFromEvent(event: SignedEvent): RawProfile {
  let content: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      content = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed profile still identifies its author; only the labels are lost.
  }
  return {
    pubkey: event.pubkey,
    display_name:
      optionalString(content.display_name) ?? optionalString(content.name),
    avatar_url: optionalString(content.picture),
    about: optionalString(content.about),
    nip05_handle: optionalString(content.nip05),
    owner_pubkey: verifiedOaOwnerPubkey(event.tags, event.pubkey),
    has_profile_event: true,
  };
}

/** The newest kind:0 event per author, keyed by lowercase pubkey. */
export async function profilesByPubkey(
  pubkeys: string[],
): Promise<Map<string, RawProfile>> {
  if (pubkeys.length === 0) {
    return new Map();
  }
  const events = await queryRelay([
    { kinds: [0], authors: pubkeys, limit: pubkeys.length },
  ]).catch(() => [] as SignedEvent[]);
  return new Map(
    [...newestByAuthor(events)].map(([pubkey, event]) => [
      pubkey,
      profileFromEvent(event),
    ]),
  );
}

/** One profile, or an empty record when the relay holds no kind:0 for it. */
export async function profileFor(pubkey: string): Promise<RawProfile> {
  const events = await queryRelay([
    { kinds: [0], authors: [pubkey], limit: 1 },
  ]);
  return events[0] ? profileFromEvent(events[0]) : emptyProfile(pubkey);
}
