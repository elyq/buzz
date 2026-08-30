/**
 * Channel list, detail, membership and write commands.
 *
 * Ports `commands/channels.rs` and its `channels/fetch.rs` helper. The two-phase
 * fetch shape is preserved because it is what bounds cost: phase 1 resolves the
 * channels this identity belongs to, phase 2 fans out member counts and
 * last-message timestamps only over that resolved set.
 */

import type { CommandArgs, CommandTable } from "@/web/ipc";
import {
  channelDetailFromEvent,
  channelFromEvent,
  KIND_CHANNEL_MEMBERS,
  KIND_CHANNEL_METADATA,
  membersFromEvent,
  type RawChannel,
  type RawChannelMember,
} from "@/web/convert/channels";
import { dTag, firstTagValue, timestampToIso } from "@/web/convert/tags";
import {
  buildAddMember,
  buildChannelUpdate,
  buildCreateChannel,
  buildDeleteChannel,
  buildDmHide,
  buildDmOpen,
  buildMembershipChange,
  buildRemoveMember,
} from "@/web/convert/eventBuilders";
import { publish } from "@/web/publish";
import {
  queryAllRelayPages,
  queryRelay,
  type RelayFilter,
} from "@/web/relayHttp";
import { requirePubkey } from "@/web/state";
import type { SignedEvent } from "@/web/sign";
import { profilesByPubkey } from "@/web/commands/profileLookup";

const DIRECTORY_PAGE_SIZE = 500;
/** Aligned with the relay's aggregate explicit-`#h` request bound. */
const LAST_MESSAGE_BATCH_SIZE = 128;
/** Bounds the kind:0 join on a large roster; past this, names resolve lazily. */
const MEMBER_PROFILE_JOIN_LIMIT = 500;
/** kind:30622 — NIP-DV hidden-DM snapshot. */
const KIND_DM_VISIBILITY = 30622;
/**
 * Human-visible channel activity that drives sidebar Recent ordering. Keep
 * aligned with `CHANNEL_MESSAGE_EVENT_KINDS` in `shared/constants/kinds.ts`.
 */
const CHANNEL_RECENCY_EVENT_KINDS = [9, 40002, 45001, 45003];

/** Channels this identity created whose kind:39002 has not yet propagated. */
const pendingOwnedChannels = new Map<string, Set<string>>();

function pendingOwnedIds(owner: string): string[] {
  return [...(pendingOwnedChannels.get(owner) ?? [])];
}

function markPendingOwned(owner: string, channelId: string): void {
  const existing = pendingOwnedChannels.get(owner) ?? new Set<string>();
  existing.add(channelId);
  pendingOwnedChannels.set(owner, existing);
}

function clearPendingOwned(owner: string, channelId: string): void {
  pendingOwnedChannels.get(owner)?.delete(channelId);
}

/** Drop the pending-owner overlay, e.g. when the community changes. */
export function resetPendingOwnedChannels(): void {
  pendingOwnedChannels.clear();
}

/**
 * FNV-1a over the canonical channel projection.
 *
 * `last_message_at` is excluded so ordinary message traffic does not invalidate
 * the caller's not-modified short-circuit for the channel list itself.
 */
function computeChannelsHash(channels: RawChannel[]): string {
  const projection = [...channels]
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .map(({ last_message_at: _lastMessageAt, ...rest }) => rest);
  const canonical = JSON.stringify(projection);

  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(canonical)) {
    hash = (hash ^ BigInt(byte)) & mask;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function lastMessageFilter(channelId: string): RelayFilter {
  return {
    kinds: CHANNEL_RECENCY_EVENT_KINDS,
    "#h": [channelId],
    limit: 1,
  };
}

async function queryLastMessages(channelIds: string[]): Promise<SignedEvent[]> {
  const events: SignedEvent[] = [];
  for (
    let index = 0;
    index < channelIds.length;
    index += LAST_MESSAGE_BATCH_SIZE
  ) {
    const batch = channelIds
      .slice(index, index + LAST_MESSAGE_BATCH_SIZE)
      .map(lastMessageFilter);
    events.push(...(await queryRelay(batch)));
  }
  return events;
}

/** Whether the fetch includes the unbounded all-open directory scan. */
type DirectoryScope = "member-only" | "include-open-directory";

async function fetchChannels(scope: DirectoryScope): Promise<RawChannel[]> {
  const myPubkey = requirePubkey();
  const pendingIds = pendingOwnedIds(myPubkey);

  const [memberMetaEvents, openMetaEvents, hiddenDms] = await Promise.all([
    (async () => {
      // Step 1: kind:39002 events listing this pubkey as a member.
      const memberEvents = await queryAllRelayPages(
        { kinds: [KIND_CHANNEL_MEMBERS], "#p": [myPubkey] },
        DIRECTORY_PAGE_SIZE,
      );
      const memberChannelIds = [
        ...new Set(
          memberEvents.map(dTag).filter((id): id is string => id !== null),
        ),
      ].sort();

      // Real membership has landed, so the pending-owner overlay must go —
      // otherwise a later leave could not flip `is_member` back to false.
      for (const id of memberChannelIds) {
        clearPendingOwned(myPubkey, id);
      }

      if (memberChannelIds.length === 0) {
        return [];
      }
      // kind:39000 is addressable: exactly one event per `d`, so a limit equal
      // to the id count is both necessary and sufficient.
      return queryRelay([
        {
          kinds: [KIND_CHANNEL_METADATA],
          "#d": memberChannelIds,
          limit: memberChannelIds.length,
        },
      ]);
    })(),
    (async () => {
      if (scope === "include-open-directory") {
        return queryAllRelayPages(
          { kinds: [KIND_CHANNEL_METADATA] },
          DIRECTORY_PAGE_SIZE,
        );
      }
      if (pendingIds.length === 0) {
        return [];
      }
      return queryRelay([
        {
          kinds: [KIND_CHANNEL_METADATA],
          "#d": pendingIds,
          limit: pendingIds.length,
        },
      ]);
    })(),
    (async () => {
      // Tolerant: a failure means no DMs are hidden, not a failed fetch.
      try {
        const events = await queryRelay([
          { kinds: [KIND_DM_VISIBILITY], "#p": [myPubkey], limit: 1 },
        ]);
        const newest = events.reduce<SignedEvent | null>(
          (best, event) =>
            !best || event.created_at > best.created_at ? event : best,
          null,
        );
        return new Set(
          newest
            ? newest.tags
                .filter((tag) => tag[0] === "h" && tag.length >= 2)
                .map((tag) => tag[1])
            : [],
        );
      } catch {
        return new Set<string>();
      }
    })(),
  ]);

  const memberDTags = new Set(
    memberMetaEvents.map(dTag).filter((id): id is string => id !== null),
  );

  const channels: RawChannel[] = [];
  for (const event of memberMetaEvents) {
    const channel = channelFromEvent(event, true);
    if (channel) {
      channels.push(channel);
    }
  }
  for (const event of openMetaEvents) {
    const id = dTag(event);
    if (id !== null && memberDTags.has(id)) {
      continue;
    }
    // The overlay marks channels this identity just created whose owner
    // membership has not propagated yet.
    const isPendingOwner =
      id !== null && pendingOwnedChannels.get(myPubkey)?.has(id) === true;
    const channel = channelFromEvent(event, isPendingOwner);
    if (channel) {
      channels.push(channel);
    }
  }

  const channelIds = channels.map((channel) => channel.id);
  if (channelIds.length > 0) {
    const [memberCountEvents, messageEvents] = await Promise.all([
      // Member counts degrade to zero on failure — they are advisory.
      queryRelay([
        {
          kinds: [KIND_CHANNEL_MEMBERS],
          "#d": channelIds,
          limit: channelIds.length,
        },
      ]).catch(() => [] as SignedEvent[]),
      // Timestamps drive the user-selected Recent ordering, so a failure must
      // abort rather than masquerade as an authoritative empty result.
      queryLastMessages(channelIds),
    ]);

    const membership = new Map<string, string[]>();
    for (const event of memberCountEvents) {
      const id = dTag(event);
      if (id !== null) {
        membership.set(
          id,
          membersFromEvent(event).map((member) => member.pubkey),
        );
      }
    }

    const lastMessageAt = new Map<string, number>();
    for (const event of messageEvents) {
      const id = firstTagValue(event, "h");
      if (id === null) {
        continue;
      }
      const existing = lastMessageAt.get(id);
      if (existing === undefined || event.created_at > existing) {
        lastMessageAt.set(id, event.created_at);
      }
    }

    for (const channel of channels) {
      const pubkeys = membership.get(channel.id);
      if (pubkeys) {
        channel.member_count = pubkeys.length;
        channel.member_pubkeys = pubkeys;
      }
      const timestamp = lastMessageAt.get(channel.id);
      if (timestamp !== undefined) {
        channel.last_message_at = timestampToIso(timestamp);
      }
    }
  }

  return hiddenDms.size === 0
    ? channels
    : channels.filter(
        (channel) =>
          channel.channel_type !== "dm" || !hiddenDms.has(channel.id),
      );
}

async function channelMetadataEvent(
  channelId: string,
): Promise<SignedEvent | null> {
  const events = await queryRelay([
    { kinds: [KIND_CHANNEL_METADATA], "#d": [channelId], limit: 1 },
  ]);
  return events[0] ?? null;
}

async function channelFromEventId(channelId: string): Promise<RawChannel> {
  const event = await channelMetadataEvent(channelId);
  const channel = event ? channelFromEvent(event, true) : null;
  if (!channel) {
    throw new Error("channel not found");
  }
  return channel;
}

export const channelCommands: CommandTable = {
  get_channels: async (args: CommandArgs) => {
    const channels = await fetchChannels("member-only");
    const lastMessages: Record<string, string> = {};
    for (const channel of channels) {
      if (channel.last_message_at) {
        lastMessages[channel.id] = channel.last_message_at;
      }
    }
    const hash = computeChannelsHash(channels);
    // Not-modified short-circuit. `last_messages` still ships so the sidebar
    // can update its timestamps without re-rendering the whole list.
    const notModified = args.knownHash === hash;
    return {
      hash,
      channels: notModified ? null : channels,
      last_messages: lastMessages,
    };
  },

  get_open_channel_directory: () => fetchChannels("include-open-directory"),

  get_channel_details: async (args: CommandArgs) => {
    const event = await channelMetadataEvent(String(args.channelId ?? ""));
    const detail = event ? channelDetailFromEvent(event, true) : null;
    if (!detail) {
      throw new Error("channel not found");
    }
    return detail;
  },

  get_channel_members: async (args: CommandArgs) => {
    const events = await queryRelay([
      {
        kinds: [KIND_CHANNEL_MEMBERS],
        "#d": [String(args.channelId ?? "")],
        limit: 1,
      },
    ]);
    if (!events[0]) {
      throw new Error("channel members not found");
    }
    const members: RawChannelMember[] = membersFromEvent(events[0]);

    // Batch the kind:0 join, capped so the query cost stays bounded on large
    // rosters. Members past the cap keep a null display name and the UI falls
    // back to its own profile caches; `bot` flags are roster-derived and
    // therefore unaffected by the cap.
    const joinPubkeys = members
      .slice(0, MEMBER_PROFILE_JOIN_LIMIT)
      .map((member) => member.pubkey);
    if (joinPubkeys.length > 0) {
      const profiles = await profilesByPubkey(joinPubkeys);
      for (const member of members) {
        member.display_name =
          profiles.get(member.pubkey.toLowerCase())?.display_name ?? null;
      }
    }
    return { members, next_cursor: null };
  },

  create_channel: async (args: CommandArgs) => {
    const channelId = crypto.randomUUID();
    const visibility = String(args.visibility ?? "open");
    const channelType = String(args.channelType ?? "stream");
    if (visibility !== "open" && visibility !== "private") {
      throw new Error(`invalid visibility: ${visibility}`);
    }
    if (channelType !== "stream" && channelType !== "forum") {
      throw new Error(`invalid channel_type: ${channelType}`);
    }
    await publish(
      buildCreateChannel({
        channelId,
        name: String(args.name ?? ""),
        visibility,
        channelType,
        description:
          typeof args.description === "string" ? args.description : null,
        ttlSeconds:
          typeof args.ttlSeconds === "number" ? args.ttlSeconds : null,
      }),
    );
    // Owner membership is published by the relay and may lag the create, so
    // the channel is held in the pending-owner overlay until it lands.
    markPendingOwned(requirePubkey(), channelId);
    return channelFromEventId(channelId).catch(() => ({
      id: channelId,
      name: String(args.name ?? ""),
      channel_type: channelType,
      visibility,
      description: String(args.description ?? ""),
      topic: null,
      purpose: null,
      member_count: 1,
      member_pubkeys: [requirePubkey()],
      last_message_at: null,
      archived_at: null,
      participants: [],
      participant_pubkeys: [],
      is_member: true,
      ttl_seconds: typeof args.ttlSeconds === "number" ? args.ttlSeconds : null,
      ttl_deadline: null,
    }));
  },

  // Starter-channel recovery is a relay-side convenience the browser build has
  // no equivalent for; the directory scan below is what the caller actually
  // consumes.
  ensure_starter_channels: () => fetchChannels("include-open-directory"),

  join_channel: async (args: CommandArgs) => {
    await publish(buildMembershipChange(String(args.channelId ?? ""), "join"));
    return null;
  },

  leave_channel: async (args: CommandArgs) => {
    await publish(buildMembershipChange(String(args.channelId ?? ""), "leave"));
    return null;
  },

  update_channel: async (args: CommandArgs) => {
    const input = (args.input ?? args) as Record<string, unknown>;
    const channelId = String(input.channelId ?? "");
    const tags: string[][] = [];
    if (typeof input.name === "string") {
      tags.push(["name", input.name]);
    }
    if (typeof input.description === "string") {
      tags.push(["about", input.description]);
    }
    if (typeof input.visibility === "string") {
      tags.push(["visibility", input.visibility]);
    }
    if (typeof input.ttlSeconds === "number") {
      tags.push(["ttl", String(input.ttlSeconds)]);
    }
    await publish(buildChannelUpdate(channelId, tags));
    const event = await channelMetadataEvent(channelId);
    const detail = event ? channelDetailFromEvent(event, true) : null;
    if (!detail) {
      throw new Error("channel not found");
    }
    return detail;
  },

  set_channel_topic: async (args: CommandArgs) => {
    await publish(
      buildChannelUpdate(String(args.channelId ?? ""), [
        ["topic", String(args.topic ?? "")],
      ]),
    );
    return null;
  },

  set_channel_purpose: async (args: CommandArgs) => {
    await publish(
      buildChannelUpdate(String(args.channelId ?? ""), [
        ["purpose", String(args.purpose ?? "")],
      ]),
    );
    return null;
  },

  archive_channel: async (args: CommandArgs) => {
    await publish(
      buildChannelUpdate(String(args.channelId ?? ""), [["archived", "true"]]),
    );
    return null;
  },

  unarchive_channel: async (args: CommandArgs) => {
    await publish(
      buildChannelUpdate(String(args.channelId ?? ""), [["archived", "false"]]),
    );
    return null;
  },

  delete_channel: async (args: CommandArgs) => {
    await publish(buildDeleteChannel(String(args.channelId ?? "")));
    return null;
  },

  add_channel_members: async (args: CommandArgs) => {
    const channelId = String(args.channelId ?? "");
    const pubkeys = (args.pubkeys as string[] | undefined) ?? [];
    const role = typeof args.role === "string" ? args.role : null;
    const added: string[] = [];
    const errors: Array<{ pubkey: string; error: string }> = [];
    for (const pubkey of pubkeys) {
      try {
        await publish(buildAddMember(channelId, pubkey, role));
        added.push(pubkey);
      } catch (error) {
        errors.push({
          pubkey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { added, errors };
  },

  remove_channel_member: async (args: CommandArgs) => {
    await publish(
      buildRemoveMember(
        String(args.channelId ?? ""),
        String(args.pubkey ?? ""),
      ),
    );
    return null;
  },

  change_channel_member_role: async (args: CommandArgs) => {
    await publish(
      buildAddMember(
        String(args.channelId ?? ""),
        String(args.pubkey ?? ""),
        String(args.newRole ?? "member"),
      ),
    );
    return null;
  },

  open_dm: async (args: CommandArgs) => {
    const pubkeys = (args.pubkeys as string[] | undefined) ?? [];
    const { event } = await publish(buildDmOpen(pubkeys));
    // The relay answers a DM open by publishing the channel's kind:39000; poll
    // briefly for it rather than guessing an id the relay owns.
    const participants = [
      ...new Set([requirePubkey(), ...pubkeys.map((p) => p.toLowerCase())]),
    ].sort();
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidates = await queryRelay([
        {
          kinds: [KIND_CHANNEL_METADATA],
          "#p": [requirePubkey()],
          since: event.created_at - 5,
        },
      ]).catch(() => [] as SignedEvent[]);
      for (const candidate of candidates) {
        const channel = channelFromEvent(candidate, true);
        if (
          channel &&
          channel.channel_type === "dm" &&
          [...new Set(channel.participant_pubkeys.map((p) => p.toLowerCase()))]
            .sort()
            .join(",") === participants.join(",")
        ) {
          return channel;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("the relay did not open a DM channel");
  },

  hide_dm: async (args: CommandArgs) => {
    await publish(buildDmHide(String(args.channelId ?? "")));
    return null;
  },
};
