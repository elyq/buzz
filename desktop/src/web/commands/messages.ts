/**
 * Message read and write commands.
 *
 * Ports `commands/messages.rs`, its `event_batch`/`thread_ref` helpers, and the
 * reaction paths. History paging keeps the relay's composite `(until,
 * before_id)` cursor: a timestamp-only cursor cannot advance past a second that
 * holds more than one page of messages, so it silently drops history.
 */

import type { CommandArgs, CommandTable } from "@/web/ipc";
import {
  buildDelete,
  buildMessage,
  buildMessageEdit,
  buildReaction,
  type ThreadRef,
} from "@/web/convert/eventBuilders";
import { publish } from "@/web/publish";
import { queryRelay, type RelayFilter } from "@/web/relayHttp";
import { requirePubkey } from "@/web/state";
import type { SignedEvent } from "@/web/sign";
import { firstTagValue } from "@/web/convert/tags";

/** kind:9 — stream message. */
const KIND_STREAM_MESSAGE = 9;
/** kind:45001 / 45003 — forum post and comment. */
const KIND_FORUM_POST = 45001;
const KIND_FORUM_COMMENT = 45003;
/** kind:48100 — huddle started, which the timeline renders inline. */
const KIND_HUDDLE_STARTED = 48100;

/**
 * Timeline content kinds. Mirrors `TIMELINE_KINDS` so a keyset page and the
 * WebSocket history page select the same rows.
 */
const TIMELINE_KINDS = [
  9,
  40002,
  40008,
  40099,
  43001,
  43002,
  43003,
  43004,
  43005,
  43006,
  KIND_HUDDLE_STARTED,
];

/** Kinds `get_event`/`get_events` will resolve. */
const GET_EVENT_KINDS = [
  0,
  1,
  3,
  5,
  7,
  9,
  30078,
  40002,
  40003,
  40008,
  40099,
  40100,
  45001,
  45003,
  KIND_HUDDLE_STARTED,
];

/** Event kinds a reconnect repair page must recover, from `CHANNEL_REPAIR_KINDS`. */
const CHANNEL_REPAIR_KINDS = [
  5, 7, 9, 9005, 40001, 40002, 40003, 40008, 40099, 45001, 45003, 48100, 48101,
  48102, 48103,
];

/** Largest repair page the relay will serve. */
const MAX_REPAIR_PAGE = 500;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The relay clamps one filter to this many events. */
const EVENT_QUERY_CHUNK_SIZE = 1000;
const DEFAULT_HISTORY_PAGE = 200;
const MAX_HISTORY_PAGE = 500;

function stringMatrix(value: unknown): string[][] {
  return Array.isArray(value) ? (value as string[][]) : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Resolve a message's thread root.
 *
 * A caller that already holds the parent supplies the root and no relay read
 * happens. Otherwise the parent is fetched and its NIP-10 markers are walked:
 * an explicit `root` wins, a lone `reply` stands in for it, and a parent that
 * references itself is its own root.
 */
async function resolveThreadRef(
  parentEventId: string,
  rootEventId: string | null,
): Promise<ThreadRef> {
  if (rootEventId) {
    return { rootEventId, parentEventId };
  }
  const events = await queryRelay([
    {
      ids: [parentEventId],
      kinds: [
        KIND_STREAM_MESSAGE,
        40002,
        KIND_FORUM_POST,
        KIND_FORUM_COMMENT,
        KIND_HUDDLE_STARTED,
      ],
      limit: 1,
    },
  ]);
  const parent = events[0];
  if (!parent) {
    throw new Error("parent event not found");
  }
  let root: string | null = null;
  let reply: string | null = null;
  for (const tag of parent.tags) {
    if (tag.length >= 4 && tag[0] === "e") {
      if (tag[3] === "root") {
        root = tag[1];
      } else if (tag[3] === "reply") {
        reply = tag[1];
      }
    }
  }
  const resolved = root ?? reply;
  return {
    rootEventId:
      resolved && resolved !== parentEventId ? resolved : parentEventId,
    parentEventId,
  };
}

function historyFilter(
  channelId: string,
  before: number,
  beforeId: string | null,
  limit: number,
): RelayFilter {
  return {
    "#h": [channelId],
    kinds: TIMELINE_KINDS,
    until: before,
    limit,
    // `before_id` is the bridge extension for the composite tiebreak; the relay
    // requires `until` alongside it.
    ...(beforeId ? { before_id: beforeId } : {}),
  };
}

async function eventsByIds(eventIds: string[]): Promise<SignedEvent[]> {
  const normalized = [
    ...new Set(
      eventIds
        .map((id) => id.trim().toLowerCase())
        .filter((id) => /^[0-9a-f]{64}$/.test(id)),
    ),
  ];
  if (normalized.length === 0) {
    return [];
  }
  const byId = new Map<string, SignedEvent>();
  for (
    let index = 0;
    index < normalized.length;
    index += EVENT_QUERY_CHUNK_SIZE
  ) {
    const chunk = normalized.slice(index, index + EVENT_QUERY_CHUNK_SIZE);
    const events = await queryRelay([
      { ids: chunk, kinds: GET_EVENT_KINDS, limit: chunk.length },
    ]);
    for (const event of events) {
      if (!byId.has(event.id)) {
        byId.set(event.id, event);
      }
    }
  }
  return [...byId.values()];
}

export const messageCommands: CommandTable = {
  send_channel_message: async (args: CommandArgs) => {
    const channelId = String(args.channelId ?? "");
    const kind =
      typeof args.kind === "number" ? args.kind : KIND_STREAM_MESSAGE;
    const parentEventId =
      typeof args.parentEventId === "string" ? args.parentEventId : null;
    const rootEventId =
      typeof args.rootEventId === "string" ? args.rootEventId : null;
    const sentFromThreadTag = Array.isArray(args.sentFromThreadTag)
      ? (args.sentFromThreadTag as string[])
      : null;

    if (rootEventId && !parentEventId) {
      throw new Error("root_event_id requires parent_event_id");
    }
    if (sentFromThreadTag && kind !== KIND_STREAM_MESSAGE) {
      throw new Error("sent-from-thread provenance requires a stream message");
    }
    if (kind === KIND_FORUM_COMMENT && !parentEventId) {
      throw new Error("forum comment requires parent_event_id");
    }

    const threadRef =
      parentEventId === null
        ? null
        : await resolveThreadRef(parentEventId, rootEventId);

    const { event } = await publish(
      buildMessage({
        channelId,
        content: String(args.content ?? ""),
        kind,
        // A forum post is always top-level; only its comments carry threading.
        threadRef: kind === KIND_FORUM_POST ? null : threadRef,
        mentionPubkeys: stringList(args.mentionPubkeys),
        mediaTags: stringMatrix(args.mediaTags),
        emojiTags: stringMatrix(args.emojiTags),
        mentionTags: stringMatrix(args.mentionTags),
        linkPreviewTags: stringMatrix(args.linkPreviewTags),
        sentFromThreadTag,
      }),
    );

    const resolvedRoot = threadRef?.rootEventId ?? null;
    const depth =
      parentEventId === null
        ? 0
        : resolvedRoot === null || parentEventId === resolvedRoot
          ? 1
          : 2;
    return {
      event_id: event.id,
      root_event_id: resolvedRoot,
      parent_event_id: parentEventId,
      depth,
      // The signed event's own second, not a post-publication clock read —
      // callers persist it as an event cursor.
      created_at: event.created_at,
    };
  },

  edit_message: async (args: CommandArgs) => {
    const input = (args.input ?? args) as Record<string, unknown>;
    await publish(
      buildMessageEdit({
        channelId: String(input.channelId ?? ""),
        targetEventId: String(input.eventId ?? ""),
        content: String(input.content ?? ""),
        mentionPubkeys: stringList(input.mentionPubkeys),
        mediaTags: stringMatrix(input.mediaTags),
        emojiTags: stringMatrix(input.emojiTags),
        mentionTags: Array.isArray(input.mentionTags)
          ? (input.mentionTags as string[][])
          : null,
        suppressLinkPreviews: input.suppressLinkPreviews === true,
      }),
    );
    return null;
  },

  delete_message: async (args: CommandArgs) => {
    await publish(
      buildDelete(
        String(args.eventId ?? ""),
        typeof args.channelId === "string" ? args.channelId : undefined,
      ),
    );
    return null;
  },

  add_reaction: async (args: CommandArgs) => {
    await publish(
      buildReaction(
        String(args.eventId ?? ""),
        String(args.emoji ?? ""),
        typeof args.emojiUrl === "string" ? args.emojiUrl : null,
      ),
    );
    return null;
  },

  remove_reaction: async (args: CommandArgs) => {
    // A NIP-25 reaction is withdrawn by deleting the reaction event, so the
    // caller's own kind:7 for this target and emoji has to be found first.
    const target = String(args.eventId ?? "").trim();
    const emoji = String(args.emoji ?? "").trim();
    const reactions = await queryRelay([
      { kinds: [7], "#e": [target], authors: [requirePubkey()] },
    ]);
    const reaction = reactions.find((event) => event.content.trim() === emoji);
    if (!reaction) {
      throw new Error("could not find your reaction event for this emoji");
    }
    await publish(buildDelete(reaction.id));
    return null;
  },

  get_channel_messages_before: async (args: CommandArgs) => {
    const limit = Math.min(
      typeof args.limit === "number" ? args.limit : DEFAULT_HISTORY_PAGE,
      MAX_HISTORY_PAGE,
    );
    const events = await queryRelay([
      historyFilter(
        String(args.channelId ?? ""),
        Number(args.before),
        typeof args.beforeId === "string" ? args.beforeId : null,
        limit,
      ),
    ]);
    // Relay order is created_at DESC, id ASC, so the last event is the oldest
    // and is the cursor for the next (older) page — but only when the page came
    // back full, since a short page proves history is exhausted.
    const oldest = events[events.length - 1];
    return {
      events,
      next_cursor:
        events.length >= limit && oldest
          ? { created_at: oldest.created_at, event_id: oldest.id }
          : null,
    };
  },

  /**
   * One server-assembled channel window.
   *
   * Ports `commands/channel_window.rs`. The `top_level`, `include_summaries`
   * and `include_aux` flags are relay filter extensions: the relay does the
   * thread rollup and returns roots plus their summaries and auxiliary events,
   * so the client renders a page without walking replies itself.
   */
  get_channel_window: (args: CommandArgs) => {
    const cursor = args.cursor as {
      created_at?: number;
      event_id?: string;
    } | null;
    return queryRelay([
      {
        "#h": [String(args.channelId ?? "")],
        kinds: TIMELINE_KINDS,
        limit: Math.min(
          typeof args.limitRows === "number" ? args.limitRows : 50,
          200,
        ),
        top_level: true,
        include_summaries: true,
        include_aux: true,
        ...(cursor?.created_at && cursor.event_id
          ? { until: cursor.created_at, before_id: cursor.event_id }
          : {}),
      },
    ]);
  },

  /**
   * One page of a thread subtree.
   *
   * Ports `get_thread_replies`. `depth_limit` is what activates the relay's
   * thread-subtree path — without it the filter degrades to a flat `#e` match
   * and nested replies are dropped. The cursor is composite
   * (`thread_cursor` + `thread_cursor_id`) for the same reason channel history
   * is: replies sharing a second would otherwise be skipped.
   */
  get_thread_replies: async (args: CommandArgs) => {
    const cap = Math.min(
      typeof args.limit === "number" ? args.limit : 200,
      500,
    );
    const channelId =
      typeof args.channelId === "string" ? args.channelId : null;
    const cursor = args.cursor as {
      created_at?: number;
      event_id?: string;
    } | null;

    const events = await queryRelay([
      {
        "#e": [String(args.rootEventId ?? "")],
        kinds: TIMELINE_KINDS,
        depth_limit: typeof args.depthLimit === "number" ? args.depthLimit : 64,
        limit: cap,
        include_aux: true,
        ...(channelId ? { "#h": [channelId] } : {}),
        ...(cursor?.created_at && cursor.event_id
          ? {
              thread_cursor: cursor.created_at,
              thread_cursor_id: cursor.event_id,
            }
          : {}),
      },
    ]);

    // Only timeline kinds count toward the page: the response also carries
    // auxiliary events (`include_aux`), which must not decide the cursor.
    const replies = events.filter((event) =>
      TIMELINE_KINDS.includes(event.kind),
    );
    const oldest = replies[replies.length - 1];
    return {
      events,
      next_cursor:
        replies.length >= cap && oldest
          ? { created_at: oldest.created_at, event_id: oldest.id }
          : null,
    };
  },

  /**
   * One lossless keyset page for reconnect repair.
   *
   * Ports `channel_reconnect_repair.rs`, including its validation: this runs
   * after a dropped socket to close the gap, so a malformed cursor must fail
   * loudly rather than silently return a partial window that the caller then
   * treats as complete.
   */
  get_channel_reconnect_repair: (args: CommandArgs) => {
    const channelId = String(args.channelId ?? "");
    if (!UUID_PATTERN.test(channelId)) {
      throw new Error("invalid channel id");
    }
    const limit = Number(args.limit);
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_REPAIR_PAGE) {
      throw new Error(`limit must be between 1 and ${MAX_REPAIR_PAGE}`);
    }
    const until = typeof args.until === "number" ? args.until : null;
    const beforeId = typeof args.beforeId === "string" ? args.beforeId : null;
    if (beforeId !== null && until === null) {
      throw new Error("before_id requires until");
    }
    if (beforeId !== null && !/^[0-9a-fA-F]{64}$/.test(beforeId)) {
      throw new Error("before_id must be a 64-character hex event id");
    }

    return queryRelay([
      {
        "#h": [channelId],
        kinds: CHANNEL_REPAIR_KINDS,
        since: Number(args.since),
        limit,
        ...(until !== null ? { until } : {}),
        ...(beforeId !== null ? { before_id: beforeId } : {}),
      },
    ]);
  },

  get_event: async (args: CommandArgs) => {
    const events = await queryRelay([
      {
        ids: [String(args.eventId ?? "")],
        kinds: GET_EVENT_KINDS,
        limit: 1,
      },
    ]);
    if (!events[0]) {
      throw new Error("event not found");
    }
    return JSON.stringify(events[0]);
  },

  get_events: (args: CommandArgs) => eventsByIds(stringList(args.eventIds)),

  get_forum_posts: async (args: CommandArgs) => {
    const limit = Math.min(
      typeof args.limit === "number" ? args.limit : 20,
      100,
    );
    const posts = await queryRelay([
      {
        kinds: [KIND_FORUM_POST],
        "#h": [String(args.channelId ?? "")],
        limit,
        ...(typeof args.before === "number" ? { until: args.before } : {}),
      },
    ]);
    // Edits are applied by the caller, which needs them alongside the posts.
    const edits =
      posts.length === 0
        ? []
        : await queryRelay([
            { kinds: [40003], "#e": posts.map((post) => post.id) },
          ]).catch(() => [] as SignedEvent[]);
    return {
      posts,
      edits,
      next_cursor:
        posts.length >= limit
          ? (posts[posts.length - 1]?.created_at ?? null)
          : null,
    };
  },

  /** The channel a timeline event belongs to, read from its NIP-29 `h` tag. */
  channel_id_from_event: (args: CommandArgs) =>
    firstTagValue(args.event as SignedEvent, "h"),
};
