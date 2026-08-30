/**
 * Relay-level membership and administration commands.
 *
 * Ports `commands/relay_members.rs`. Relay membership (kind:13534) is separate
 * from channel membership: an identity needs both before it can take part, and
 * the moderation surfaces read this list to decide what to show.
 */

import type { CommandArgs, CommandTable } from "@/web/ipc";
import { queryRelay } from "@/web/relayHttp";
import { publish } from "@/web/publish";
import { requirePubkey } from "@/web/state";
import { toRelayScope } from "@/web/state";
import type { SignedEvent } from "@/web/sign";
import { tagsNamed } from "@/web/convert/tags";
import {
  relayRequiresMembership,
  relaySelfPubkey,
} from "@/web/commands/relaySelf";

/** kind:13534 — the relay's replaceable member list. */
const KIND_RELAY_MEMBERS = 13534;

type RelayMemberRecord = { pubkey: string; role: string };

/**
 * Members of the relay's kind:13534 event.
 *
 * `member` tags are the current relay format; `p` tags are the older NIP-29
 * convention and are read as a fallback. First tag wins per pubkey.
 */
function relayMembersFromEvent(event: SignedEvent): RelayMemberRecord[] {
  const seen = new Set<string>();
  const members: RelayMemberRecord[] = [];
  const collect = (tags: string[][], roleIndex: number) => {
    for (const tag of tags) {
      const pubkey = tag[1];
      if (!pubkey || seen.has(pubkey)) {
        continue;
      }
      seen.add(pubkey);
      members.push({ pubkey, role: tag[roleIndex] || "member" });
    }
  };
  collect(tagsNamed(event, "member"), 2);
  collect(tagsNamed(event, "p"), 3);
  return members;
}

async function loadRelayMembers(): Promise<RelayMemberRecord[]> {
  const events = await queryRelay([{ kinds: [KIND_RELAY_MEMBERS], limit: 1 }]);
  return events[0] ? relayMembersFromEvent(events[0]) : [];
}

/** kind:9030 / 9031 / 9032 — relay member administration. */
function adminTemplate(kind: number, tags: string[][]) {
  return { kind, content: "", tags };
}

export const relayCommands: CommandTable = {
  get_relay_self: () => relaySelfPubkey(),

  relay_requires_membership: (args: CommandArgs) => {
    const relayUrl = args.relayUrl;
    return relayRequiresMembership(
      typeof relayUrl === "string" && relayUrl
        ? toRelayScope(relayUrl).httpUrl
        : undefined,
    );
  },

  list_relay_members: async () => ({ members: await loadRelayMembers() }),

  get_my_relay_membership: async () => {
    const me = requirePubkey();
    const member = (await loadRelayMembers()).find(
      (candidate) => candidate.pubkey.toLowerCase() === me,
    );
    // The desktop command answers 404 for a non-member and the caller maps that
    // to `null`; returning the same `null` keeps that branch working.
    return { member: member ?? null };
  },

  add_relay_member: async (args: CommandArgs) => {
    const { response } = await publish(
      adminTemplate(9030, [
        ["p", String(args.targetPubkey ?? "").toLowerCase()],
        ["role", String(args.role ?? "member")],
      ]),
    );
    return response;
  },

  remove_relay_member: async (args: CommandArgs) => {
    const { response } = await publish(
      adminTemplate(9031, [
        ["p", String(args.targetPubkey ?? "").toLowerCase()],
      ]),
    );
    return response;
  },

  change_relay_member_role: async (args: CommandArgs) => {
    const { response } = await publish(
      adminTemplate(9032, [
        ["p", String(args.targetPubkey ?? "").toLowerCase()],
        ["role", String(args.newRole ?? "member")],
      ]),
    );
    return response;
  },
};
