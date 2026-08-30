/**
 * Relay agent discovery commands.
 *
 * Ports `commands/agent_discovery/relay_directory.rs`. This is what makes agent
 * mentions work: the composer's autocomplete, the send-time revalidation, and
 * the `respond_to` policy the UI enforces all read from here.
 *
 * The query shape is deliberately the Rust one, not a simpler equivalent:
 * membership bounds the candidate set, and every follow-up filter is an exact
 * `(author, kind)` or `(owner, d=agent)` lookup, so a forged coordinate can
 * neither amplify the result set nor crowd out the authentic record.
 */

import type { CommandArgs, CommandTable } from "@/web/ipc";
import {
  KIND_AGENT_PROFILE,
  KIND_MANAGED_AGENT,
  memberAgentChannelIds,
  type RawRelayAgent,
  relayAgentsFromDirectoryEvents,
  verifiedAgentOwners,
} from "@/web/convert/agentDirectory";
import { KIND_CHANNEL_MEMBERS } from "@/web/convert/channels";
import {
  queryAllRelayPages,
  queryRelay,
  type RelayFilter,
} from "@/web/relayHttp";
import { requirePubkey } from "@/web/state";
import { relaySelfPubkey } from "@/web/commands/relaySelf";
import type { SignedEvent } from "@/web/sign";

const DIRECTORY_PAGE_SIZE = 500;
/** Filters per `/query` request, mirroring `RELAY_FILTER_BATCH_SIZE`. */
const FILTER_BATCH_SIZE = 10;
/** Concurrent `/query` requests per rebuild, mirroring the Rust semaphore. */
const MAX_CONCURRENCY = 8;

function exactAuthorFilters(pubkeys: string[], kind: number): RelayFilter[] {
  return pubkeys.map((pubkey) => ({
    authors: [pubkey],
    kinds: [kind],
    limit: 1,
  }));
}

function managedPolicyFilters(
  candidatePubkeys: string[],
  verifiedOwners: Map<string, string>,
): RelayFilter[] {
  const filters: RelayFilter[] = [];
  for (const agentPubkey of candidatePubkeys) {
    const owner = verifiedOwners.get(agentPubkey);
    if (owner) {
      filters.push({
        authors: [owner],
        kinds: [KIND_MANAGED_AGENT],
        "#d": [agentPubkey],
        limit: 1,
      });
    }
  }
  return filters;
}

/**
 * Run `filters` in batches, at most `MAX_CONCURRENCY` requests in flight.
 *
 * Issuing these serially dominated agent-mention send latency in the desktop
 * build; the bounded window collapses it to a few round trips while staying
 * under the relay's admission gate.
 */
async function queryFilterBatches(
  filters: RelayFilter[],
  errorLabel: string,
): Promise<SignedEvent[]> {
  const batches: RelayFilter[][] = [];
  for (let index = 0; index < filters.length; index += FILTER_BATCH_SIZE) {
    batches.push(filters.slice(index, index + FILTER_BATCH_SIZE));
  }

  const events: SignedEvent[] = [];
  for (let index = 0; index < batches.length; index += MAX_CONCURRENCY) {
    const window = batches.slice(index, index + MAX_CONCURRENCY);
    try {
      const pages = await Promise.all(window.map((batch) => queryRelay(batch)));
      for (const page of pages) {
        events.push(...page);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${errorLabel}: ${detail}`);
    }
  }
  return events;
}

async function listRelayAgentsForSelection(
  requestedPubkeys: Set<string> | null,
  channelId: string | null,
): Promise<RawRelayAgent[]> {
  const viewerPubkey = requirePubkey();
  const relayPubkey = await relaySelfPubkey();
  if (!relayPubkey) {
    throw new Error("relay agent membership authority is unavailable");
  }

  // Membership is the authoritative and bounded candidate source: only
  // channels visible to this identity are read, and only `bot`-role p-tags
  // reach the managed-policy and owner-profile lookups below.
  const membershipFilter: RelayFilter = {
    kinds: [KIND_CHANNEL_MEMBERS],
    authors: [relayPubkey],
    "#p": [viewerPubkey],
    ...(channelId ? { "#d": [channelId] } : {}),
  };

  let membershipEvents: SignedEvent[];
  try {
    membershipEvents = await queryAllRelayPages(
      membershipFilter,
      DIRECTORY_PAGE_SIZE,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`relay agent channel-membership query failed: ${detail}`);
  }

  const channelIdsByAgent = memberAgentChannelIds(
    membershipEvents,
    relayPubkey,
  );
  if (requestedPubkeys) {
    for (const pubkey of [...channelIdsByAgent.keys()]) {
      if (!requestedPubkeys.has(pubkey)) {
        channelIdsByAgent.delete(pubkey);
      }
    }
  }

  const candidatePubkeys = [...channelIdsByAgent.keys()];
  if (candidatePubkeys.length === 0) {
    return [];
  }

  const [directoryEvents, profileEvents] = await Promise.all([
    queryFilterBatches(
      exactAuthorFilters(candidatePubkeys, KIND_AGENT_PROFILE),
      "relay agent runtime-directory query failed",
    ),
    queryFilterBatches(
      exactAuthorFilters(candidatePubkeys, 0),
      "relay agent owner-profile query failed",
    ),
  ]);

  // Only the agent's own signed NIP-OA profile can name the owner coordinate
  // to query, so each filter is an exact `(owner, d=agent)` lookup returning at
  // most one current replaceable event.
  const verifiedOwners = verifiedAgentOwners(profileEvents);
  const managedAgentEvents = await queryFilterBatches(
    managedPolicyFilters(candidatePubkeys, verifiedOwners),
    "relay agent managed-policy query failed",
  );

  const agents = relayAgentsFromDirectoryEvents(
    directoryEvents,
    managedAgentEvents,
    profileEvents,
  ).filter((agent) => channelIdsByAgent.has(agent.pubkey));

  for (const agent of agents) {
    agent.channel_ids = channelIdsByAgent.get(agent.pubkey) ?? [];
  }
  return agents;
}

export const agentCommands: CommandTable = {
  list_relay_agents: () => listRelayAgentsForSelection(null, null),

  /**
   * Revalidate only the mentioned agents against the destination channel.
   *
   * Keeping this separate from the full directory is what bounds send-time
   * authorization to the actual mention set rather than the whole relay.
   */
  revalidate_relay_agents: (args: CommandArgs) => {
    const pubkeys = (args.pubkeys as string[] | undefined) ?? [];
    const channelId =
      typeof args.channelId === "string" ? args.channelId : null;
    return listRelayAgentsForSelection(
      new Set(pubkeys.map((pubkey) => pubkey.toLowerCase())),
      channelId,
    );
  },

  /** The verified NIP-OA owner of one pubkey, or `null` when unattested. */
  resolve_oa_owner: async (args: CommandArgs) => {
    const pubkey = String(args.pubkey ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
      return null;
    }
    const events = await queryRelay([
      { kinds: [0], authors: [pubkey], limit: 1 },
    ]);
    return verifiedAgentOwners(events).get(pubkey) ?? null;
  },
};
