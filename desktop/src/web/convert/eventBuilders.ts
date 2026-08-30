/**
 * Event templates for the browser build's write path.
 *
 * Ports the builders in `src-tauri/src/events.rs`, including their validation.
 * The validation is not decoration: it is the guard that keeps caller-supplied
 * tag arrays (media, emoji, mention references) from forging an `h`, `e` or `p`
 * tag and retargeting a message at another channel or identity.
 */

const MAX_CONTENT_BYTES = 100_000;
const MAX_MENTIONS = 64;
const AGENT_ADDRESS_MENTION_MARKER = "agent-address";
const SENT_FROM_THREAD_TAG = "buzz:sent-from-thread";
const MAX_THREAD_ROOT_EXCERPT_CHARS = 64;
const MAX_EMOJI_CHARS = 64;

/** An unsigned event template ready for `signEvent`. */
export type EventTemplate = {
  kind: number;
  content: string;
  tags: string[][];
};

/** NIP-10 thread reference: the thread root and the direct parent. */
export type ThreadRef = {
  rootEventId: string;
  parentEventId: string;
};

function checkContent(content: string): void {
  const size = new TextEncoder().encode(content).length;
  if (size > MAX_CONTENT_BYTES) {
    throw new Error(
      `content exceeds maximum size of ${MAX_CONTENT_BYTES} bytes (got ${size})`,
    );
  }
}

function checkPubkey(pubkey: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    throw new Error(
      `pubkey must be a 64-character hex string (got ${pubkey.length} chars)`,
    );
  }
}

function checkEventId(eventId: string, label: string): string {
  const trimmed = eventId.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(`invalid ${label} event ID`);
  }
  return trimmed.toLowerCase();
}

function threadTags(ref: ThreadRef): string[][] {
  const root = checkEventId(ref.rootEventId, "root");
  const parent = checkEventId(ref.parentEventId, "parent");
  return root === parent
    ? [["e", root, "", "reply"]]
    : [
        ["e", root, "", "root"],
        ["e", parent, "", "reply"],
      ];
}

function mentionTags(mentions: string[]): string[][] {
  if (mentions.length > MAX_MENTIONS) {
    throw new Error(`too many mentions (max ${MAX_MENTIONS})`);
  }
  const seen = new Set<string>();
  const tags: string[][] = [];
  for (const mention of mentions) {
    checkPubkey(mention);
    const lower = mention.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      tags.push(["p", lower]);
    }
  }
  return tags;
}

/** Validate and copy caller-supplied tags that must carry a fixed prefix. */
function prefixedTags(
  supplied: string[][],
  prefix: string,
  label: string,
): string[][] {
  for (const tag of supplied) {
    if (tag[0] !== prefix) {
      throw new Error(`${label} must use '${prefix}' prefix (got ${tag[0]})`);
    }
  }
  return supplied.map((tag) => [...tag]);
}

/**
 * Validate mention reference tags.
 *
 * These carry the rendered mention's identity, and optionally the
 * `agent-address` marker that distinguishes an addressed agent from a plain
 * mention. Anything else in the display slot is rejected.
 */
function mentionReferenceTags(supplied: string[][]): string[][] {
  const tags: string[][] = [];
  for (const mention of supplied) {
    if (mention[0] !== "mention") {
      throw new Error(
        `mention reference tags must use 'mention' prefix (got ${mention[0]})`,
      );
    }
    const pubkey = mention[1];
    if (!pubkey) {
      throw new Error("mention reference tag missing pubkey");
    }
    if (
      mention.length > 3 ||
      (mention.length === 3 && mention[2] !== AGENT_ADDRESS_MENTION_MARKER)
    ) {
      throw new Error("mention reference tag has invalid display metadata");
    }
    checkPubkey(pubkey);
    const parts = ["mention", pubkey.toLowerCase()];
    if (mention.length === 3) {
      parts.push(AGENT_ADDRESS_MENTION_MARKER);
    }
    tags.push(parts);
  }
  return tags;
}

/** Whether `value` contains a C0 control character or DEL. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function sentFromThreadTags(supplied: string[] | null): string[][] {
  if (!supplied) {
    return [];
  }
  if (
    (supplied.length !== 2 && supplied.length !== 3) ||
    supplied[0] !== SENT_FROM_THREAD_TAG
  ) {
    throw new Error("invalid sent-from-thread tag shape");
  }
  checkEventId(supplied[1], "sent-from-thread root");
  const excerpt = supplied[2];
  if (excerpt !== undefined) {
    if (
      excerpt.trim().length === 0 ||
      [...excerpt].length > MAX_THREAD_ROOT_EXCERPT_CHARS ||
      hasControlCharacter(excerpt)
    ) {
      throw new Error("sent-from-thread tag has invalid root excerpt");
    }
  }
  return [[...supplied]];
}

/** Inputs to a channel message, mirroring `build_message`'s parameters. */
export type MessageInput = {
  channelId: string;
  content: string;
  kind: number;
  threadRef: ThreadRef | null;
  mentionPubkeys: string[];
  mediaTags: string[][];
  emojiTags: string[][];
  mentionTags: string[][];
  linkPreviewTags: string[][];
  sentFromThreadTag: string[] | null;
};

/** kind:9 stream message, kind:45001/45003 forum post and comment. */
export function buildMessage(input: MessageInput): EventTemplate {
  if (input.sentFromThreadTag && input.threadRef) {
    throw new Error("sent-from-thread provenance requires a top-level message");
  }
  const content = input.content.trim();
  checkContent(content);
  return {
    kind: input.kind,
    content,
    tags: [
      ["h", input.channelId],
      ...(input.threadRef ? threadTags(input.threadRef) : []),
      ...mentionTags(input.mentionPubkeys),
      ...prefixedTags(input.mediaTags, "imeta", "media tags"),
      ...prefixedTags(input.emojiTags, "emoji", "emoji tags"),
      ...mentionReferenceTags(input.mentionTags),
      ...prefixedTags(input.linkPreviewTags, "preview", "link preview tags"),
      ...sentFromThreadTags(input.sentFromThreadTag),
    ],
  };
}

/** kind:40003 — edit a message in place. */
export function buildMessageEdit(input: {
  targetEventId: string;
  channelId: string;
  content: string;
  mentionPubkeys: string[];
  mediaTags: string[][];
  emojiTags: string[][];
  /**
   * The full mention identity set selected in the edited composer.
   *
   * `null` is a partial edit that must preserve the existing snapshot; a value,
   * including an empty array, authoritatively replaces it and is marked with
   * `buzz:mention-snapshot` so readers know the set is complete.
   */
  mentionTags: string[][] | null;
  suppressLinkPreviews: boolean;
}): EventTemplate {
  const content = input.content.trim();
  // A media-only edit is valid, so emptiness is rejected only when the edit
  // carries neither text nor attachments.
  if (!content && input.mediaTags.length === 0) {
    throw new Error("edit must have content or attachments");
  }
  checkContent(content);
  return {
    kind: 40003,
    content,
    tags: [
      ["h", input.channelId],
      ["e", checkEventId(input.targetEventId, "target")],
      // Only mentions newly added by this edit get a `p` tag, so a typo fix
      // never re-wakes the people already mentioned.
      ...mentionTags(input.mentionPubkeys),
      ...prefixedTags(input.mediaTags, "imeta", "media tags"),
      ...prefixedTags(input.emojiTags, "emoji", "emoji tags"),
      ...(input.mentionTags
        ? [
            ...mentionReferenceTags(input.mentionTags),
            ["buzz:mention-snapshot"],
          ]
        : []),
      ...(input.suppressLinkPreviews ? [["link-preview", "none"]] : []),
    ],
  };
}

/**
 * kind:5 — NIP-09 deletion.
 *
 * The `h` tag is non-standard for NIP-09 but required: without it the delete is
 * invisible to channel-scoped subscriptions.
 */
export function buildDelete(
  targetEventId: string,
  channelId?: string,
): EventTemplate {
  return {
    kind: 5,
    content: "",
    tags: [
      ...(channelId ? [["h", channelId]] : []),
      ["e", checkEventId(targetEventId, "target")],
    ],
  };
}

/** kind:7 — NIP-25 reaction, optionally a NIP-30 custom emoji. */
export function buildReaction(
  targetEventId: string,
  emoji: string,
  emojiUrl?: string | null,
): EventTemplate {
  const trimmed = emoji.trim();
  if ([...trimmed].length > MAX_EMOJI_CHARS) {
    throw new Error(
      `emoji exceeds maximum length of ${MAX_EMOJI_CHARS} characters`,
    );
  }
  if (!emojiUrl) {
    return {
      kind: 7,
      content: trimmed,
      tags: [["e", checkEventId(targetEventId, "target")]],
    };
  }
  // NIP-30: the content is the `:shortcode:` form and the tag carries the URL.
  const shortcode = trimmed.replace(/^:|:$/g, "");
  if (!/^[a-zA-Z0-9_-]+$/.test(shortcode)) {
    throw new Error("invalid custom emoji reaction: malformed shortcode");
  }
  return {
    kind: 7,
    content: `:${shortcode}:`,
    tags: [
      ["e", checkEventId(targetEventId, "target")],
      ["emoji", shortcode, emojiUrl],
    ],
  };
}

/** kind:9007 — create a channel. */
export function buildCreateChannel(input: {
  channelId: string;
  name: string;
  visibility: string;
  channelType: string;
  description?: string | null;
  ttlSeconds?: number | null;
}): EventTemplate {
  const name = input.name.trim();
  if (!name) {
    throw new Error("channel name is required");
  }
  return {
    kind: 9007,
    content: "",
    tags: [
      ["h", input.channelId],
      ["name", name],
      ["visibility", input.visibility],
      ["channel_type", input.channelType],
      ...(input.description ? [["about", input.description]] : []),
      ...(input.ttlSeconds ? [["ttl", String(input.ttlSeconds)]] : []),
    ],
  };
}

/** kind:9021 / 9022 — join and leave. */
export function buildMembershipChange(
  channelId: string,
  action: "join" | "leave",
): EventTemplate {
  return {
    kind: action === "join" ? 9021 : 9022,
    content: "",
    tags: [["h", channelId]],
  };
}

/** kind:9002 — update channel metadata with the supplied tags. */
export function buildChannelUpdate(
  channelId: string,
  tags: string[][],
): EventTemplate {
  return { kind: 9002, content: "", tags: [["h", channelId], ...tags] };
}

/** kind:9008 — delete a channel. */
export function buildDeleteChannel(channelId: string): EventTemplate {
  return { kind: 9008, content: "", tags: [["h", channelId]] };
}

/** kind:9000 — add a member, optionally with a role. */
export function buildAddMember(
  channelId: string,
  targetPubkey: string,
  role?: string | null,
): EventTemplate {
  checkPubkey(targetPubkey);
  return {
    kind: 9000,
    content: "",
    tags: [
      ["h", channelId],
      role
        ? ["p", targetPubkey.toLowerCase(), "", role]
        : ["p", targetPubkey.toLowerCase()],
    ],
  };
}

/** kind:9001 — remove a member. */
export function buildRemoveMember(
  channelId: string,
  targetPubkey: string,
): EventTemplate {
  checkPubkey(targetPubkey);
  return {
    kind: 9001,
    content: "",
    tags: [
      ["h", channelId],
      ["p", targetPubkey.toLowerCase()],
    ],
  };
}

/** kind:41010 — open (or resurface) a DM channel with the given participants. */
export function buildDmOpen(pubkeys: string[]): EventTemplate {
  for (const pubkey of pubkeys) {
    checkPubkey(pubkey);
  }
  return {
    kind: 41010,
    content: "",
    tags: pubkeys.map((pubkey) => ["p", pubkey.toLowerCase()]),
  };
}

/** kind:41012 — hide a DM channel from this identity's listing. */
export function buildDmHide(channelId: string): EventTemplate {
  return { kind: 41012, content: "", tags: [["h", channelId]] };
}

/** kind:0 — NIP-01 profile metadata, published as a full snapshot. */
export function buildProfile(metadata: Record<string, unknown>): EventTemplate {
  return { kind: 0, content: JSON.stringify(metadata), tags: [] };
}

/** kind:3 — NIP-02 contact list, published as a full snapshot. */
export function buildContactList(pubkeys: string[]): EventTemplate {
  for (const pubkey of pubkeys) {
    checkPubkey(pubkey);
  }
  return {
    kind: 3,
    content: "",
    tags: pubkeys.map((pubkey) => ["p", pubkey.toLowerCase()]),
  };
}
