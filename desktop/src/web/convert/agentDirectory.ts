/**
 * Relay agent directory conversion.
 *
 * Ports `src-tauri/src/nostr_convert/agent_directory.rs`. This is the code path
 * that decides which pubkeys the composer will offer as agent mentions, so the
 * authorization rules matter:
 *
 * - Membership (relay-signed kind:39002, `bot` role) is the only candidate
 *   source, which bounds the directory to channels this identity can see.
 * - A kind:30177 managed-agent policy counts only when its author is the owner
 *   the agent's own kind:0 NIP-OA `auth` tag cryptographically names. A forged
 *   coordinate therefore cannot reserve or impersonate an agent identity.
 * - A verified managed coordinate reserves the identity even when its policy
 *   fails to parse, so a stale self-authored kind:10100 record cannot win back
 *   permissions the owner has since narrowed.
 */

import type { SignedEvent } from "@/web/sign";
import { firstTagValue, tagsNamed } from "@/web/convert/tags";
import { verifiedOaOwnerPubkey } from "@/web/convert/nipOa";

/** kind:10100 — an agent's self-authored runtime profile. */
export const KIND_AGENT_PROFILE = 10100;
/** kind:30177 — an owner's managed-agent policy, addressable by agent pubkey. */
export const KIND_MANAGED_AGENT = 30177;

/** Wire shape of a relay agent, matching `RawRelayAgent` in `tauri.ts`. */
export type RawRelayAgent = {
  pubkey: string;
  owner_pubkey: string | null;
  name: string;
  agent_type: string;
  channels: string[];
  channel_ids: string[];
  capabilities: string[];
  status: string;
  respond_to?: string;
  respond_to_allowlist?: string[];
};

function isNewer(candidate: SignedEvent, previous: SignedEvent): boolean {
  return (
    candidate.created_at > previous.created_at ||
    (candidate.created_at === previous.created_at && candidate.id < previous.id)
  );
}

function latestByAuthor(events: SignedEvent[]): Map<string, SignedEvent> {
  const latest = new Map<string, SignedEvent>();
  for (const event of events) {
    const key = event.pubkey.toLowerCase();
    const previous = latest.get(key);
    if (!previous || isNewer(event, previous)) {
      latest.set(key, event);
    }
  }
  return latest;
}

function parseObject(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Convert one self-authored kind:10100 event into a directory record.
 *
 * The event author is authoritative for the pubkey even when the content claims
 * otherwise, and neither the owner nor the channel list is trusted from content
 * — those come only from verified sources upstream.
 */
/**
 * Display names an agent published about itself, from its kind:0 profile.
 *
 * A kind:10100 directory entry usually carries no name at all — on a live relay
 * its content is as thin as `{"channel_add_policy":"anyone"}` — while the
 * agent's kind:0 profile holds the name people actually use (`cid`, `intake`).
 * Both are self-authored and already fetched together, so the profile is the
 * better source, not a guess.
 */
export function profileDisplayNames(
  profileEvents: SignedEvent[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const [pubkey, profile] of latestByAuthor(profileEvents)) {
    const content = parseObject(profile.content);
    const name =
      (typeof content.display_name === "string" && content.display_name) ||
      (typeof content.name === "string" && content.name) ||
      "";
    if (name.trim()) {
      names.set(pubkey, name.trim());
    }
  }
  return names;
}

function agentFromProfileEvent(
  event: SignedEvent,
  profileNames: Map<string, string>,
): RawRelayAgent {
  const content = parseObject(event.content);
  const pubkey = event.pubkey.toLowerCase();
  // Falling back to the pubkey is what breaks mentions: the composer ranks this
  // `name` ABOVE the profile's display name (`buildMentionCandidates`), so a
  // synthesized pubkey-shaped name wins and there is nothing left to type. The
  // upstream Rust falls back to an npub here, which fails the same way. Reach
  // for the kind:0 profile first and keep the pubkey as a last resort only.
  const displayName =
    (typeof content.display_name === "string" && content.display_name.trim()
      ? content.display_name
      : "") ||
    profileNames.get(pubkey) ||
    pubkey;
  return {
    pubkey,
    // A legacy directory entry is not an authenticated managed coordinate, so
    // it must never drive the live kind:30177 watcher.
    owner_pubkey: null,
    name: typeof content.name === "string" ? content.name : displayName,
    agent_type:
      typeof content.agent_type === "string" ? content.agent_type : "agent",
    channels: stringArray(content.channels),
    // Channel membership is authoritative only in relay-signed kind:39002.
    channel_ids: [],
    capabilities: stringArray(content.capabilities),
    status: typeof content.status === "string" ? content.status : "offline",
    respond_to:
      typeof content.respond_to === "string" ? content.respond_to : undefined,
    respond_to_allowlist: stringArray(content.respond_to_allowlist),
  };
}

/**
 * Each agent's owner, resolved from its latest signed NIP-OA kind:0 profile.
 *
 * Keys and values are lowercase hex.
 */
export function verifiedAgentOwners(
  profileEvents: SignedEvent[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [agentPubkey, profile] of latestByAuthor(profileEvents)) {
    const owner = verifiedOaOwnerPubkey(profile.tags, profile.pubkey);
    if (owner) {
      owners.set(agentPubkey, owner);
    }
  }
  return owners;
}

/** The latest kind:30177 policy per agent whose author is the verified owner. */
function latestVerifiedPolicies(
  managedAgentEvents: SignedEvent[],
  verifiedOwners: Map<string, string>,
): Map<string, SignedEvent> {
  const latest = new Map<string, SignedEvent>();
  for (const event of managedAgentEvents) {
    const agentPubkey = firstTagValue(event, "d")?.toLowerCase();
    if (!agentPubkey) {
      continue;
    }
    if (verifiedOwners.get(agentPubkey) !== event.pubkey.toLowerCase()) {
      continue;
    }
    const previous = latest.get(agentPubkey);
    if (!previous || isNewer(event, previous)) {
      latest.set(agentPubkey, event);
    }
  }
  return latest;
}

function agentFromManagedPolicy(
  agentPubkey: string,
  event: SignedEvent,
): RawRelayAgent | null {
  const content = parseObject(event.content);
  if (typeof content.name !== "string") {
    // An unparseable policy still reserves the identity upstream; it just
    // cannot produce a directory record of its own.
    return null;
  }
  return {
    pubkey: agentPubkey,
    owner_pubkey: event.pubkey.toLowerCase(),
    name: content.name,
    agent_type: "agent",
    channels: [],
    channel_ids: [],
    capabilities: [],
    status: "offline",
    respond_to:
      typeof content.respond_to === "string" ? content.respond_to : undefined,
    respond_to_allowlist: stringArray(content.respond_to_allowlist),
  };
}

/**
 * Merge self-authored kind:10100 runtime profiles with verified owner policies.
 *
 * Every agent with a verified managed coordinate is served by that coordinate,
 * displacing any legacy record for the same pubkey.
 */
export function relayAgentsFromDirectoryEvents(
  directoryEvents: SignedEvent[],
  managedAgentEvents: SignedEvent[],
  profileEvents: SignedEvent[],
): RawRelayAgent[] {
  const verifiedOwners = verifiedAgentOwners(profileEvents);
  const verifiedPolicies = latestVerifiedPolicies(
    managedAgentEvents,
    verifiedOwners,
  );

  const profileNames = profileDisplayNames(profileEvents);

  const agents = new Map<string, RawRelayAgent>();
  for (const event of latestByAuthor(directoryEvents).values()) {
    const agent = agentFromProfileEvent(event, profileNames);
    agents.set(agent.pubkey, agent);
  }
  for (const agentPubkey of verifiedPolicies.keys()) {
    agents.delete(agentPubkey);
  }
  for (const [agentPubkey, event] of verifiedPolicies) {
    const agent = agentFromManagedPolicy(agentPubkey, event);
    if (agent) {
      agents.set(agentPubkey, agent);
    }
  }

  return [...agents.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/**
 * Candidate agent pubkeys and the channels they sit in.
 *
 * Only relay-signed events count, and within them only p-tags explicitly marked
 * with the `bot` role — a member cannot promote themself into the directory.
 */
export function memberAgentChannelIds(
  membershipEvents: SignedEvent[],
  relayPubkey: string,
): Map<string, string[]> {
  const channels = new Map<string, Set<string>>();
  for (const event of membershipEvents) {
    if (event.pubkey.toLowerCase() !== relayPubkey.toLowerCase()) {
      continue;
    }
    const channelId = firstTagValue(event, "d");
    if (!channelId) {
      continue;
    }
    for (const tag of tagsNamed(event, "p")) {
      const pubkey = tag[1];
      const role = tag[3];
      if (role !== "bot" || !pubkey || !/^[0-9a-fA-F]{64}$/.test(pubkey)) {
        continue;
      }
      const key = pubkey.toLowerCase();
      const existing = channels.get(key) ?? new Set<string>();
      existing.add(channelId);
      channels.set(key, existing);
    }
  }
  return new Map(
    [...channels].map(([pubkey, ids]) => [pubkey, [...ids].sort()]),
  );
}
