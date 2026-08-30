/**
 * Profile, presence, user-search and contact-list commands.
 *
 * Ports `commands/profile.rs`, `nostr_convert/user_search.rs` and the contact
 * list half of `commands/social.rs`.
 */

import type { CommandArgs, CommandTable } from "@/web/ipc";
import { queryRelay } from "@/web/relayHttp";
import { publish } from "@/web/publish";
import { buildContactList, buildProfile } from "@/web/convert/eventBuilders";
import { firstTagValue, newestByAuthor, tagsNamed } from "@/web/convert/tags";
import { verifiedOaOwnerPubkey } from "@/web/convert/nipOa";
import {
  emptyProfile,
  profileFor,
  profileFromEvent,
  profilesByPubkey,
  type RawProfile,
} from "@/web/commands/profileLookup";
import { requirePubkey } from "@/web/state";
import type { SignedEvent } from "@/web/sign";

/** kind:20001 — ephemeral presence. */
const KIND_PRESENCE = 20001;
const DEFAULT_USER_SEARCH_LIMIT = 8;
const MAX_USER_SEARCH_LIMIT = 500;

type UserSearchResult = {
  pubkey: string;
  display_name: string | null;
  avatar_url: string | null;
  nip05_handle: string | null;
  is_agent: boolean;
  owner_pubkey: string | null;
};

function userSearchResultFromEvent(event: SignedEvent): UserSearchResult {
  const profile = profileFromEvent(event);
  const ownerPubkey = verifiedOaOwnerPubkey(event.tags, event.pubkey);
  return {
    pubkey: profile.pubkey,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    nip05_handle: profile.nip05_handle,
    is_agent: ownerPubkey !== null,
    owner_pubkey: ownerPubkey,
  };
}

/**
 * Score one candidate against the query.
 *
 * The relay ranks FTS hits against the whole kind:0 JSON blob, where a match in
 * `about` scores the same as a match in `display_name`. These weights restore
 * the ordering a typeahead needs: exact beats prefix beats substring, and the
 * display name outranks the handle, which outranks the raw pubkey.
 */
function matchScore(
  query: string,
  displayName: string,
  nip05: string,
  pubkeyHex: string,
): number {
  const scoreField = (
    field: string,
    exact: number,
    prefix: number,
    contains: number,
  ): number => {
    if (!field) {
      return 0;
    }
    if (field === query) {
      return exact;
    }
    if (field.startsWith(query)) {
      return prefix;
    }
    return field.includes(query) ? contains : 0;
  };
  return Math.max(
    scoreField(displayName, 1000, 900, 800),
    scoreField(nip05, 700, 600, 500),
    pubkeyHex.startsWith(query) ? 400 : 0,
  );
}

function rankUserSearchResults(
  events: SignedEvent[],
  query: string,
  limit: number,
): UserSearchResult[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized || limit === 0) {
    return [];
  }
  const scored: Array<{
    score: number;
    index: number;
    result: UserSearchResult;
  }> = [];
  events.forEach((event, index) => {
    // Defensive: a relay may not honour `kinds` under a search filter.
    if (event.kind !== 0) {
      return;
    }
    const result = userSearchResultFromEvent(event);
    const score = matchScore(
      normalized,
      result.display_name?.toLowerCase() ?? "",
      result.nip05_handle?.toLowerCase() ?? "",
      result.pubkey.toLowerCase(),
    );
    if (score > 0) {
      scored.push({ score, index, result });
    }
  });
  // Input order is the tiebreaker so the relay's own relevance ordering
  // survives within a score band.
  scored.sort((left, right) =>
    right.score !== left.score
      ? right.score - left.score
      : left.index - right.index,
  );

  const seen = new Set<string>();
  const users: UserSearchResult[] = [];
  for (const { result } of scored) {
    if (seen.has(result.pubkey)) {
      continue;
    }
    seen.add(result.pubkey);
    users.push(result);
    if (users.length >= limit) {
      break;
    }
  }
  return users;
}

/** The empty-query people directory: newest profile per author, name-sorted. */
function listUserSearchResults(
  events: SignedEvent[],
  limit: number,
): UserSearchResult[] {
  if (limit === 0) {
    return [];
  }
  const users = [...newestByAuthor(events.filter((e) => e.kind === 0)).values()]
    .map(userSearchResultFromEvent)
    .sort((left, right) => {
      const label = (result: UserSearchResult) =>
        (
          result.display_name ??
          result.nip05_handle ??
          result.pubkey
        ).toLowerCase();
      return (
        label(left).localeCompare(label(right)) ||
        left.pubkey.localeCompare(right.pubkey)
      );
    });
  return users.slice(0, limit);
}

export const profileCommands: CommandTable = {
  get_profile: () => profileFor(requirePubkey()),

  get_user_profile: (args: CommandArgs) =>
    profileFor(
      typeof args.pubkey === "string" && args.pubkey
        ? args.pubkey
        : requirePubkey(),
    ),

  get_users_batch: async (args: CommandArgs) => {
    const pubkeys = (args.pubkeys as string[] | undefined) ?? [];
    if (pubkeys.length === 0) {
      return { profiles: {}, missing: [] };
    }
    const found = await profilesByPubkey(pubkeys);
    const profiles: Record<string, RawProfile> = {};
    const missing: string[] = [];
    for (const pubkey of pubkeys) {
      const profile = found.get(pubkey.toLowerCase());
      if (profile) {
        profiles[pubkey] = profile;
      } else {
        missing.push(pubkey);
      }
    }
    return { profiles, missing };
  },

  update_profile: async (args: CommandArgs) => {
    // kind:0 is a full snapshot, so this is a read-merge-write: fields the
    // caller left out must survive rather than being erased.
    const me = requirePubkey();
    const existing = await queryRelay([
      { kinds: [0], authors: [me], limit: 1 },
    ]).catch(() => [] as SignedEvent[]);
    let metadata: Record<string, unknown> = {};
    if (existing[0]) {
      try {
        const parsed: unknown = JSON.parse(existing[0].content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        // A malformed prior profile is replaced rather than merged into.
      }
    }
    const assign = (key: string, value: unknown) => {
      if (typeof value === "string") {
        metadata[key] = value;
      }
    };
    assign("display_name", args.displayName);
    assign("picture", args.avatarUrl);
    assign("about", args.about);
    assign("nip05", args.nip05Handle);

    const { event } = await publish(buildProfile(metadata));
    return profileFromEvent(event);
  },

  search_users: async (args: CommandArgs) => {
    const query = String(args.query ?? "").trim();
    const limit = Math.min(
      typeof args.limit === "number" ? args.limit : DEFAULT_USER_SEARCH_LIMIT,
      MAX_USER_SEARCH_LIMIT,
    );
    const page =
      typeof args.cursor === "string" && Number.parseInt(args.cursor, 10) > 0
        ? Number.parseInt(args.cursor, 10)
        : 1;
    if (limit === 0) {
      return { users: [], next_cursor: null };
    }

    if (!query) {
      const events = await queryRelay([{ kinds: [0], limit, page }]);
      return {
        users: listUserSearchResults(events, limit),
        // The raw page length is the fullness signal — the result list is
        // deduped and truncated, so it can undercount a full page.
        next_cursor: events.length >= limit ? String(page + 1) : null,
      };
    }

    // `search_mode: "prefix"` matters: every caller is a typeahead surface, and
    // the relay's default whole-word matching returns nothing for "tyl".
    const events = await queryRelay([
      { kinds: [0], search: query, search_mode: "prefix", limit, page },
    ]);
    return {
      users: rankUserSearchResults(events, query, limit),
      next_cursor: events.length >= limit ? String(page + 1) : null,
    };
  },

  get_presence: async (args: CommandArgs) => {
    const pubkeys = (args.pubkeys as string[] | undefined) ?? [];
    if (pubkeys.length === 0) {
      return {};
    }
    // Presence is ephemeral and some relays retain none of it, so this is
    // best-effort: an error yields "no presence known", not a failed command.
    const events = await queryRelay([
      { kinds: [KIND_PRESENCE], authors: pubkeys },
    ]).catch(() => [] as SignedEvent[]);

    const latest = new Map<string, { at: number; status: string }>();
    for (const event of events) {
      // Relay-synthesized presence names its subject with a p-tag; self-signed
      // presence from the live socket is authored by the subject itself.
      const pubkey = firstTagValue(event, "p") ?? event.pubkey;
      const status = event.content.trim();
      if (status !== "online" && status !== "away" && status !== "offline") {
        continue;
      }
      const existing = latest.get(pubkey);
      if (!existing || existing.at < event.created_at) {
        latest.set(pubkey, { at: event.created_at, status });
      }
    }
    return Object.fromEntries(
      [...latest].map(([pubkey, { status }]) => [pubkey, status]),
    );
  },

  get_contact_list: async (args: CommandArgs) => {
    const pubkey = String(args.pubkey ?? requirePubkey());
    const events = await queryRelay([
      { kinds: [3], authors: [pubkey], limit: 1 },
    ]);
    const event = events[0];
    if (!event) {
      return { id: "", pubkey, contacts: [], created_at: 0 };
    }
    return {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      contacts: tagsNamed(event, "p")
        .filter((tag) => tag.length >= 2)
        .map((tag) => ({
          pubkey: tag[1],
          relay_url: tag[2] || null,
          petname: tag[3] || null,
        })),
    };
  },

  set_contact_list: async (args: CommandArgs) => {
    const contacts =
      (args.contacts as Array<{ pubkey: string }> | undefined) ?? [];
    const { response } = await publish(
      buildContactList(contacts.map((contact) => contact.pubkey)),
    );
    return response;
  },

  /** Placeholder profile for a pubkey with no kind:0 event yet. */
  empty_profile: (args: CommandArgs) =>
    emptyProfile(String(args.pubkey ?? requirePubkey())),
};
