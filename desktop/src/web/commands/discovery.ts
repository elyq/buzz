/**
 * Home feed and message search commands.
 *
 * Ports `get_feed` and `search_messages` from `commands/messages.rs`, plus
 * `search_response_from_events` from `nostr_convert.rs`.
 */

import type { CommandArgs, CommandTable } from "@/web/ipc";
import { queryRelay, type RelayFilter } from "@/web/relayHttp";
import { requirePubkey } from "@/web/state";
import type { SignedEvent } from "@/web/sign";
import { firstTagValue } from "@/web/convert/tags";

/** Kinds that can mention someone and therefore reach the feed. */
const MENTION_KINDS = [
  9, 40002, 1, 45001, 45003,
  // Git surfaces: pull request, PR update, issue, and the four status kinds.
  44001, 44002, 44003, 44010, 44011, 44012, 44013,
];
/** kind:46010–46012 — workflow approval requests, i.e. "needs action". */
const APPROVAL_KINDS = [46010, 46011, 46012];
/** Kinds a message search will match. */
const SEARCH_KINDS = [9, 40002, 45001, 45003];

const DEFAULT_FEED_LIMIT = 50;
const MAX_FEED_LIMIT = 100;
const APPROVAL_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 500;

type FeedCategory = "mention" | "needs_action";

function feedItem(event: SignedEvent, category: FeedCategory) {
  return {
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    content: event.content,
    created_at: event.created_at,
    channel_id: firstTagValue(event, "h"),
    // The relay does not carry channel names on these events; the caller
    // resolves them from its own channel list.
    channel_name: "",
    channel_type: null,
    tags: event.tags,
    category,
  };
}

export const discoveryCommands: CommandTable = {
  get_feed: async (args: CommandArgs) => {
    const limit = Math.min(
      typeof args.limit === "number" ? args.limit : DEFAULT_FEED_LIMIT,
      MAX_FEED_LIMIT,
    );
    const since = typeof args.since === "number" ? args.since : null;
    const types = typeof args.types === "string" ? args.types : null;
    const wants = (name: string) =>
      types === null
        ? true
        : types.split(",").some((entry) => entry.trim() === name);

    const me = requirePubkey();
    const sinceClause = since === null ? {} : { since };

    // Both sub-queries are tolerant: a partial feed beats an empty one, and
    // the caller renders whichever sections resolved.
    const [mentionEvents, approvalEvents] = await Promise.all([
      wants("mentions")
        ? queryRelay([
            { kinds: MENTION_KINDS, "#p": [me], limit, ...sinceClause },
          ]).catch(() => [] as SignedEvent[])
        : Promise.resolve([] as SignedEvent[]),
      wants("needs_action")
        ? queryRelay([
            {
              kinds: APPROVAL_KINDS,
              "#p": [me],
              limit: APPROVAL_LIMIT,
              ...sinceClause,
            },
          ]).catch(() => [] as SignedEvent[])
        : Promise.resolve([] as SignedEvent[]),
    ]);

    const mentions = mentionEvents.map((event) => feedItem(event, "mention"));
    const needsAction = approvalEvents.map((event) =>
      feedItem(event, "needs_action"),
    );

    return {
      feed: {
        mentions,
        needs_action: needsAction,
        activity: [],
        agent_activity: [],
      },
      meta: {
        since: since ?? 0,
        total: mentions.length + needsAction.length,
        generated_at: Math.floor(Date.now() / 1000),
      },
    };
  },

  search_messages: async (args: CommandArgs) => {
    const query = String(args.q ?? "").trim();
    const limit = Math.min(
      typeof args.limit === "number" ? args.limit : DEFAULT_SEARCH_LIMIT,
      MAX_SEARCH_LIMIT,
    );
    const authors = Array.isArray(args.authors)
      ? (args.authors as string[])
          .map((author) => author.trim())
          .filter(Boolean)
      : [];

    const filter: RelayFilter = {
      kinds: SEARCH_KINDS,
      search: query,
      // The topbar is a typeahead surface, so a partially typed word must
      // match. This bridge-only extension is consumed before filter parsing, so
      // general WebSocket NIP-50 search stays word-based.
      search_mode: "prefix",
      limit,
      ...(typeof args.channelId === "string" && args.channelId
        ? { "#h": [args.channelId] }
        : {}),
      ...(authors.length > 0 ? { authors } : {}),
      ...(typeof args.since === "number" ? { since: args.since } : {}),
      ...(typeof args.until === "number" ? { until: args.until } : {}),
    };

    const events = await queryRelay([filter]);
    const total = events.length;
    return {
      found: total,
      hits: events.map((event, index) => ({
        event_id: event.id,
        content: event.content,
        kind: event.kind,
        pubkey: event.pubkey,
        channel_id: firstTagValue(event, "h"),
        channel_name: null,
        created_at: event.created_at,
        // Search is never the access boundary — hits are refetched and
        // re-authorized — so this is presentation ordering only.
        score: total <= 1 ? 1 : 1 - index / total,
      })),
    };
  },
};
