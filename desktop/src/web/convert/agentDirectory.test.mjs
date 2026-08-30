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
