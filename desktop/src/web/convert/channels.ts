/**
 * NIP-29 channel event conversion.
 *
 * Ports `channel_info_from_event`, `channel_detail_from_event` and
 * `channel_members_from_event` from `src-tauri/src/nostr_convert.rs`. The wire
 * shapes returned here are the `RawChannel` / `RawChannelDetail` /
 * `RawChannelMember` records `tauriChannels.ts` already knows how to decode.
 */

import type { SignedEvent } from "@/web/sign";
import {
  dTag,
  firstTagValue,
  hasTag,
  tagValues,
  tagsNamed,
  timestampToIso,
} from "@/web/convert/tags";

/** kind:39000 — channel metadata (addressable by `d`). */
export const KIND_CHANNEL_METADATA = 39000;
/** kind:39002 — channel membership (addressable by `d`). */
export const KIND_CHANNEL_MEMBERS = 39002;

/** Wire shape of a channel, matching `RawChannel` in `tauriChannels.ts`. */
export type RawChannel = {
  id: string;
  name: string;
  channel_type: string;
  visibility: "open" | "private";
  description: string;
  topic: string | null;
  purpose: string | null;
  member_count: number;
  member_pubkeys: string[];
  last_message_at: string | null;
  archived_at: string | null;
  participants: string[];
  participant_pubkeys: string[];
  is_member: boolean;
  ttl_seconds: number | null;
  ttl_deadline: string | null;
};

/** Wire shape of a channel detail, matching `RawChannelDetail`. */
export type RawChannelDetail = RawChannel & {
  created_by: string;
  created_at: string;
  updated_at: string;
  topic_set_by: string | null;
  topic_set_at: string | null;
  purpose_set_by: string | null;
  purpose_set_at: string | null;
  topic_required: boolean;
  max_members: number | null;
  nip29_group_id: string | null;
};

/** Wire shape of a channel member, matching `RawChannelMember`. */
export type RawChannelMember = {
  pubkey: string;
  role: string;
  is_agent: boolean;
  joined_at: string | null;
  display_name: string | null;
};

function channelType(event: SignedEvent): string {
  // An explicit ["t", type] wins; relays that predate it mark DMs with
  // ["hidden"], and everything else is a stream.
  return (
    firstTagValue(event, "t") ?? (hasTag(event, "hidden") ? "dm" : "stream")
  );
}

function visibility(event: SignedEvent): "open" | "private" {
  const tag = firstTagValue(event, "visibility");
  if (hasTag(event, "private") || tag === "private") {
    return "private";
  }
  return "open";
}

function archivedAt(event: SignedEvent): string | null {
  // The tag carries no timestamp of its own, so the event's own `created_at`
  // stands in — the frontend only tests this field for presence.
  return firstTagValue(event, "archived") === "true"
    ? timestampToIso(event.created_at)
    : null;
}

function ttlSeconds(event: SignedEvent): number | null {
  const raw = firstTagValue(event, "ttl");
  if (raw === null) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Convert a kind:39000 metadata event into the channel list wire shape. */
export function channelFromEvent(
  event: SignedEvent,
  isMember: boolean,
): RawChannel | null {
  const id = dTag(event);
  if (id === null) {
    return null;
  }
  // For DM-type channels the p-tags name the participants.
  const participants = tagValues(event, "p");
  return {
    id,
    name: firstTagValue(event, "name") ?? "",
    channel_type: channelType(event),
    visibility: visibility(event),
    description: firstTagValue(event, "about") ?? "",
    topic: firstTagValue(event, "topic"),
    purpose: firstTagValue(event, "purpose"),
    member_count: 0,
    member_pubkeys: [],
    last_message_at: null,
    archived_at: archivedAt(event),
    participants,
    participant_pubkeys: participants,
    is_member: isMember,
    ttl_seconds: ttlSeconds(event),
    ttl_deadline: firstTagValue(event, "ttl_deadline"),
  };
}

/** Convert a kind:39000 metadata event into the channel detail wire shape. */
export function channelDetailFromEvent(
  event: SignedEvent,
  isMember: boolean,
): RawChannelDetail | null {
  const channel = channelFromEvent(event, isMember);
  if (!channel) {
    return null;
  }
  const createdAt = timestampToIso(event.created_at);
  return {
    ...channel,
    created_by: event.pubkey,
    created_at: createdAt,
    updated_at: createdAt,
    topic_set_by: null,
    topic_set_at: null,
    purpose_set_by: null,
    purpose_set_at: null,
    topic_required: false,
    max_members: null,
    nip29_group_id: null,
  };
}

/**
 * Members of a kind:39002 event.
 *
 * Members are `["p", pubkey, relay?, role?]`; the role defaults to `member`,
 * and `bot` is what marks a member as an agent. kind:39002 carries no per-member
 * join timestamp, so `joined_at` is null.
 */
export function membersFromEvent(event: SignedEvent): RawChannelMember[] {
  if (dTag(event) === null) {
    return [];
  }
  const seen = new Set<string>();
  const members: RawChannelMember[] = [];
  for (const tag of tagsNamed(event, "p")) {
    const pubkey = tag[1];
    if (!pubkey || seen.has(pubkey)) {
      continue;
    }
    seen.add(pubkey);
    const role = tag[3] || "member";
    members.push({
      pubkey,
      role,
      is_agent: role === "bot",
      joined_at: null,
      display_name: null,
    });
  }
  return members;
}
