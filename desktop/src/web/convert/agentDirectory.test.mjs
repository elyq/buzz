/**
 * Agent naming in the relay directory.
 *
 * A kind:10100 directory entry usually carries no name — on a live relay its
 * content is as thin as `{"channel_add_policy":"anyone"}` — while the agent's
 * kind:0 profile holds the name people actually type. Falling back to the
 * pubkey (or, upstream, to an npub) is not a harmless placeholder: the composer
 * ranks this `name` ABOVE the profile's display name, so the synthesized one
 * wins and `@cid` matches nothing. Mentions are the reason the browser build
 * exists, so it is pinned here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { relayAgentsFromDirectoryEvents } from "./agentDirectory.ts";

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const OWNER_SECRET = hexToBytes("11".repeat(32));
const OWNER = bytesToHex(schnorr.getPublicKey(OWNER_SECRET));

/** A genuine NIP-OA attestation by OWNER for `agentPubkey`. */
function authTag(agentPubkey, conditions = "") {
  const preimage = `nostr:agent-auth:${agentPubkey}:${conditions}`;
  const sig = schnorr.sign(
    sha256(new TextEncoder().encode(preimage)),
    OWNER_SECRET,
  );
  return ["auth", OWNER, conditions, bytesToHex(sig)];
}

const AGENT = "a".repeat(64);

/** A signed-event shape with only the fields the conversion reads. */
function event({ pubkey = AGENT, kind, content, tags = [], createdAt = 100 }) {
  return {
    id: `${kind}-${pubkey}`.padEnd(64, "0").slice(0, 64),
    pubkey,
    kind,
    content: JSON.stringify(content),
    created_at: createdAt,
    tags,
    sig: "0".repeat(128),
  };
}

test("a nameless directory entry takes its name from the kind:0 profile", () => {
  const [agent] = relayAgentsFromDirectoryEvents(
    // Exactly what the live relay stores for these agents.
    [event({ kind: 10100, content: { channel_add_policy: "anyone" } })],
    [],
    [event({ kind: 0, content: { display_name: "cid", about: "CI agent" } })],
  );

  assert.equal(agent.name, "cid");
  assert.notEqual(
    agent.name,
    AGENT,
    "a pubkey-shaped name outranks the profile name in the composer",
  );
});

test("kind:0 `name` is used when `display_name` is absent", () => {
  const [agent] = relayAgentsFromDirectoryEvents(
    [event({ kind: 10100, content: {} })],
    [],
    [event({ kind: 0, content: { name: "intake" } })],
  );

  assert.equal(agent.name, "intake");
});

test("a name on the directory entry itself still wins", () => {
  const [agent] = relayAgentsFromDirectoryEvents(
    [event({ kind: 10100, content: { name: "from-directory" } })],
    [],
    [event({ kind: 0, content: { display_name: "from-profile" } })],
  );

  assert.equal(agent.name, "from-directory");
});

test("the pubkey remains the last resort when nothing names the agent", () => {
  const [agent] = relayAgentsFromDirectoryEvents(
    [event({ kind: 10100, content: {} })],
    [],
    [event({ kind: 0, content: {} })],
  );

  // Still unusable as a mention, but it is a real fallback rather than a
  // silently dropped agent — the pubkey is the one identifier always present.
  assert.equal(agent.name, AGENT);
});

test("the newest kind:0 profile supplies the name", () => {
  const [agent] = relayAgentsFromDirectoryEvents(
    [event({ kind: 10100, content: {} })],
    [],
    [
      event({ kind: 0, content: { display_name: "old" }, createdAt: 100 }),
      event({ kind: 0, content: { display_name: "renamed" }, createdAt: 200 }),
    ],
  );

  assert.equal(agent.name, "renamed");
});

/**
 * Mention eligibility, which is what actually decides whether an agent can be
 * @-mentioned. `relayAgentIsSharedWithUser` matches "owner-only", "allowlist"
 * and "anyone" explicitly and denies everything else, so both an unset
 * `respond_to` and a null `owner_pubkey` silently remove an agent from the
 * composer — including from its own owner. A live relay produces exactly that
 * combination, which is why mentions resolved nobody.
 */

test("an unset respond_to falls back to the harness default, not to denial", () => {
  const [agent] = relayAgentsFromDirectoryEvents(
    [event({ kind: 10100, content: { channel_add_policy: "anyone" } })],
    [],
    [event({ kind: 0, content: { display_name: "scout" } })],
  );

  // RespondTo::default() is OwnerOnly in buzz-acp's config.rs — the policy the
  // agent's own runtime applies.
  assert.equal(agent.respond_to, "owner-only");
});

test("an explicit respond_to is never overridden by the default", () => {
  const [agent] = relayAgentsFromDirectoryEvents(
    [event({ kind: 10100, content: { respond_to: "anyone" } })],
    [],
    [event({ kind: 0, content: { display_name: "open" } })],
  );

  assert.equal(agent.respond_to, "anyone");
});

test("a legacy entry carries its verified NIP-OA owner", () => {
  // Without an owner an "owner-only" agent is mentionable by nobody at all,
  // since the eligibility check needs someone to compare the viewer against.
  // This is the exact shape a live relay serves: a directory entry with no
  // policy, and the ownership proof sitting on the kind:0 profile.
  const [agent] = relayAgentsFromDirectoryEvents(
    [event({ kind: 10100, content: {} })],
    [],
    [
      event({
        kind: 0,
        content: { display_name: "warden" },
        tags: [authTag(AGENT)],
      }),
    ],
  );

  assert.equal(agent.respond_to, "owner-only");
  assert.equal(agent.owner_pubkey, OWNER);
});

test("an unverifiable auth tag yields no owner", () => {
  const [agent] = relayAgentsFromDirectoryEvents(
    [event({ kind: 10100, content: {} })],
    [],
    [
      event({
        kind: 0,
        content: { display_name: "warden" },
        // Right shape, wrong signature — it must not confer ownership.
        tags: [["auth", OWNER, "", "0".repeat(128)]],
      }),
    ],
  );

  assert.equal(agent.owner_pubkey, null);
});

test("an owner cannot attest itself into being its own agent", () => {
  const ownerProfile = event({
    pubkey: OWNER,
    kind: 0,
    content: { display_name: "not-an-agent" },
    tags: [authTag(OWNER)],
  });
  const [agent] = relayAgentsFromDirectoryEvents(
    [event({ pubkey: OWNER, kind: 10100, content: {} })],
    [],
    [ownerProfile],
  );

  assert.equal(agent.owner_pubkey, null);
});
