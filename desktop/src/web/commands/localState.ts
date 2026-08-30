/**
 * Locally persisted state and unread catch-up.
 *
 * The Tauri build keeps these in a SQLite store next to the app. The browser
 * has `localStorage`, which is enough for the channel head cache (a cold-start
 * optimisation that a miss simply refills from the relay).
 *
 * `unread_catch_up` is ported from `unread_catch_up.rs` with one documented
 * narrowing: the desktop build seeds notification membership from its
 * observed-unread store, and the browser has no such store, so membership is
 * discovered from the fetched window alone. DMs, broadcasts, direct mentions
 * and top-level messages classify identically; a reply in a thread the user
 * joined before the window can go uncounted until that thread is opened.
 */

import type { CommandArgs, CommandTable } from "@/web/ipc";
import { queryRelay } from "@/web/relayHttp";
import { requirePubkey } from "@/web/state";
import type { SignedEvent } from "@/web/sign";

const HEAD_CACHE_PREFIX = "buzz-web-channel-head.v1:";
const CATCH_UP_LIMIT = 1000;
const ACTIVITY_LIMIT = 100;
const CATCH_UP_CONCURRENCY = 8;

/** kind:9 / 40002 — stream message and its v2 form. */
const KIND_STREAM_MESSAGE = 9;
const KIND_STREAM_MESSAGE_V2 = 40002;
const KIND_FORUM_POST = 45001;
const KIND_FORUM_COMMENT = 45003;
const KIND_HUDDLE_STARTED = 48100;

function scopeKey(scope: unknown): string {
  const { pubkey, relayUrl } = (scope ?? {}) as {
    pubkey?: string;
    relayUrl?: string;
  };
  return `${HEAD_CACHE_PREFIX}${pubkey ?? ""}|${relayUrl ?? ""}`;
}

function readCache(key: string): Record<string, SignedEvent[]> {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, SignedEvent[]>) : {};
  } catch {
    return {};
  }
}

function writeCache(key: string, value: Record<string, SignedEvent[]>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The head cache is an optimisation; a full quota must not fail the write
    // path that triggered it.
  }
}

type ThreadReference = { parentId: string | null; rootId: string | null };

/**
 * The NIP-10 thread position of an event.
 *
 * An explicit `root` marker wins; with only a `reply`, the reply target is
 * also the root. The last `reply` marker is taken so a malformed event with
 * several cannot shadow the real parent.
 */
function threadReference(tags: string[][]): ThreadReference {
  const eventTags = tags.filter((tag) => tag[0] === "e" && tag[1]);
  const root = eventTags.find((tag) => tag[3] === "root");
  const reply = [...eventTags].reverse().find((tag) => tag[3] === "reply");
  if (!reply) {
    return { parentId: null, rootId: null };
  }
  return { parentId: reply[1], rootId: root?.[1] ?? reply[1] };
}

function hasExactTag(tags: string[][], name: string, value: string): boolean {
  return tags.some((tag) => tag[0] === name && tag[1] === value);
}

function hasTagValue(tags: string[][], name: string, value: string): boolean {
  return tags.some(
    (tag) => tag[0] === name && tag[1]?.toLowerCase() === value.toLowerCase(),
  );
}

type CatchUpChannel = {
  id: string;
  type: string;
  name: string;
  readAt: number | null;
};

type ObservedUnreadEvent = {
  id: string;
  createdAt: number;
  rootId: string | null;
  highPriority: boolean;
  countsTowardBadge: boolean;
  countsTowardAppBadge: boolean;
};

type ActivityRow = {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  createdAt: number;
  channelId: string;
  channelName: string;
  tags: string[][];
};

function shouldNotify(
  event: SignedEvent,
  selfPubkey: string,
  mutedChannelIds: Set<string>,
  participated: Set<string>,
  authored: Set<string>,
): boolean {
  if (
    hasExactTag(event.tags, "broadcast", "1") ||
    hasTagValue(event.tags, "p", selfPubkey)
  ) {
    return true;
  }
  const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (channelId && mutedChannelIds.has(channelId)) {
    return false;
  }
  const reference = threadReference(event.tags);
  if (reference.parentId === null) {
    return true;
  }
  if (reference.rootId === null) {
    return false;
  }
  return participated.has(reference.rootId) || authored.has(reference.rootId);
}

async function fetchChannelWindow(
  channel: CatchUpChannel,
): Promise<SignedEvent[]> {
  const kinds =
    channel.type === "dm"
      ? [
          KIND_STREAM_MESSAGE,
          KIND_STREAM_MESSAGE_V2,
          KIND_FORUM_POST,
          KIND_FORUM_COMMENT,
          KIND_HUDDLE_STARTED,
        ]
      : [
          KIND_STREAM_MESSAGE,
          KIND_STREAM_MESSAGE_V2,
          KIND_FORUM_POST,
          KIND_FORUM_COMMENT,
        ];
  const events = await queryRelay([
    {
      kinds,
      "#h": [channel.id],
      since: channel.readAt === null ? 0 : channel.readAt + 1,
      limit: CATCH_UP_LIMIT,
    },
  ]);
  return events.slice(0, CATCH_UP_LIMIT);
}

export const localStateCommands: CommandTable = {
  channel_head_cache_load: (args: CommandArgs) => {
    const limit = typeof args.limit === "number" ? args.limit : 12;
    const cache = readCache(scopeKey(args.scope));
    return Object.entries(cache)
      .slice(0, limit)
      .map(([channelId, events]) => ({ channelId, events }));
  },

  channel_head_cache_store: (args: CommandArgs) => {
    const key = scopeKey(args.scope);
    const cache = readCache(key);
    cache[String(args.channelId ?? "")] =
      (args.events as SignedEvent[] | undefined) ?? [];
    writeCache(key, cache);
    return null;
  },

  channel_head_cache_clear: (args: CommandArgs) => {
    try {
      window.localStorage.removeItem(scopeKey(args.scope));
    } catch {
      // Nothing to clear if storage is unavailable.
    }
    return null;
  },

  unread_catch_up: async (args: CommandArgs) => {
    const request = (args.request ?? {}) as {
      channels?: CatchUpChannel[];
      selfPubkey?: string;
      mutedChannelIds?: string[];
    };
    const selfPubkey = (request.selfPubkey ?? "").toLowerCase();
    if (selfPubkey !== requirePubkey().toLowerCase()) {
      throw new Error("unread catch-up identity does not match active scope");
    }
    const channels = request.channels ?? [];
    const mutedChannelIds = new Set(request.mutedChannelIds ?? []);

    const fetched: Array<{ channel: CatchUpChannel; events: SignedEvent[] }> =
      [];
    const failures: Array<{
      status: "error";
      channelId: string;
      error: string;
    }> = [];
    for (
      let index = 0;
      index < channels.length;
      index += CATCH_UP_CONCURRENCY
    ) {
      const window = channels.slice(index, index + CATCH_UP_CONCURRENCY);
      const results = await Promise.all(
        window.map(async (channel) => {
          try {
            return {
              ok: true as const,
              channel,
              events: await fetchChannelWindow(channel),
            };
          } catch (error) {
            return {
              ok: false as const,
              channel,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
      for (const result of results) {
        if (result.ok) {
          fetched.push({ channel: result.channel, events: result.events });
        } else {
          failures.push({
            status: "error",
            channelId: result.channel.id,
            error: result.error,
          });
        }
      }
    }

    // Pass one is deliberately global rather than per-channel: a root learned
    // from any channel in the batch must be visible when classifying every
    // other one. Each discovery stays attributed to the channel that found it.
    const participated = new Set<string>();
    const authored = new Set<string>();
    const mentioned = new Set<string>();
    const discoveries = fetched.map(({ events }) => {
      const discovered = {
        participated: [] as string[],
        authored: [] as string[],
        mentioned: [] as string[],
      };
      for (const event of events) {
        if (event.pubkey.toLowerCase() === selfPubkey) {
          const rootId = threadReference(event.tags).rootId;
          if (rootId) {
            if (!participated.has(rootId)) {
              participated.add(rootId);
              discovered.participated.push(rootId);
            }
          } else if (!authored.has(event.id)) {
            authored.add(event.id);
            discovered.authored.push(event.id);
          }
        } else if (hasTagValue(event.tags, "p", selfPubkey)) {
          const rootId = threadReference(event.tags).rootId;
          if (rootId && !mentioned.has(rootId)) {
            mentioned.add(rootId);
            discovered.mentioned.push(rootId);
          }
        }
      }
      return discovered;
    });

    const outputs: Array<{
      channelId: string;
      observedEvents: ObservedUnreadEvent[];
      maxTrigger: number;
      activityRows: ActivityRow[];
      discovered: (typeof discoveries)[number];
    }> = [];
    const allActivity: ActivityRow[] = [];

    fetched.forEach(({ channel, events }, index) => {
      const observedEvents: ObservedUnreadEvent[] = [];
      const activityRows: ActivityRow[] = [];
      let maxTrigger = 0;
      for (const event of events) {
        if (
          event.pubkey.toLowerCase() === selfPubkey ||
          (channel.readAt !== null && event.created_at <= channel.readAt) ||
          !shouldNotify(
            event,
            selfPubkey,
            mutedChannelIds,
            participated,
            authored,
          )
        ) {
          continue;
        }
        const reference = threadReference(event.tags);
        const broadcast = hasExactTag(event.tags, "broadcast", "1");
        const threaded = reference.parentId !== null && !broadcast;
        const highPriority =
          channel.type === "dm" ||
          broadcast ||
          hasTagValue(event.tags, "p", selfPubkey);
        maxTrigger = Math.max(maxTrigger, event.created_at);
        observedEvents.push({
          id: event.id,
          createdAt: event.created_at,
          rootId: broadcast ? null : reference.rootId,
          highPriority,
          countsTowardBadge: channel.type === "dm" || threaded || highPriority,
          countsTowardAppBadge:
            channel.type === "dm" || (!threaded && highPriority),
        });
        if (threaded) {
          activityRows.push({
            id: event.id,
            kind: event.kind,
            pubkey: event.pubkey,
            content: event.content,
            createdAt: event.created_at,
            channelId: channel.id,
            channelName: channel.name,
            tags: event.tags,
          });
        }
      }
      allActivity.push(...activityRows);
      outputs.push({
        channelId: channel.id,
        observedEvents,
        maxTrigger,
        activityRows,
        discovered: discoveries[index],
      });
    });

    // The activity feed is capped across the whole batch, keeping the newest
    // rows, so one busy channel cannot crowd out every other one.
    allActivity.sort((left, right) => left.createdAt - right.createdAt);
    const seen = new Set<string>();
    const deduped = allActivity.filter((row) => {
      if (seen.has(row.id)) {
        return false;
      }
      seen.add(row.id);
      return true;
    });
    const allowed = new Set(
      deduped
        .slice(Math.max(0, deduped.length - ACTIVITY_LIMIT))
        .map((row) => row.id),
    );

    return {
      channels: [
        ...outputs.map((output) => ({
          status: "success" as const,
          channelId: output.channelId,
          observedEvents: output.observedEvents,
          maxTrigger: output.maxTrigger,
          activityRows: output.activityRows.filter((row) =>
            allowed.has(row.id),
          ),
          discovered: output.discovered,
        })),
        ...failures,
      ],
    };
  },
};
