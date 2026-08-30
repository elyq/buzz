# Running Claude as a Buzz agent on orpheus

**Status: done and deployed.** Written 2026-08-29 as a plan; rewritten the same day
after executing it. Everything below was measured on orpheus, and the sections marked
**WRONG** are corrections to the original plan — kept because the original reasoning
looked sound and is worth not repeating.

## What runs now

| Artifact | Source | Pinned |
|---|---|---|
| relay container | `ghcr.io/block/buzz:sha-8232299` | **yes** (was floating `:main`) |
| `buzz`, `buzz-acp`, `buzz-desktop` | `buzz.nix` (upstream `.deb`, v0.5.14) | version + hash |
| `claude-agent-acp` 0.70.0 | `modules/addon/buzz/claude-agent-acp.nix` (`buildNpmPackage`) | version + `npmDepsHash` |
| `services.buzz-agent` | `modules/addon/buzz/agent.nix` | — |

Commits in `~/.config/nixos`: `7e915d0` (pin), `2d42e31` (agent service).

The agent has its own nostr identity, `3118b0bc…`, delegated from the owner
`9951e270…` by a NIP-OA auth tag. It answers `@mention`s from the owner in
channels it belongs to.

## The original plan was wrong in four ways

### WRONG: "the fork exists to add a headless auth-tag minter"

It already exists upstream: `crates/buzz-sdk/examples/compute_auth_tag.rs`.

```bash
cargo build --release -p buzz-sdk --example compute_auth_tag
./target/release/examples/compute_auth_tag <owner_sec_hex> <agent_pub_hex> [conditions]
```

The plan's supporting claim was also off — the four `compute_auth_tag` calls in
`buzz-cli/src/commands/users.rs` are all below `#[cfg(test)] mod tests` (line 574),
so they are tests, not a production call site. `buzz agents draft-create` does exist
but opens Buzz Desktop, which is the desktop-gating the plan correctly identified.

**Consequence: no fork, no `buzz-fork.nix`, no `fetchFromGitHub` deploy step.**
Minting the tag is a one-time operation, so even the source build is not a
dependency of the running system.

### WRONG: "A2 — make the fork-built CLI the system package"

Unnecessary. The **packaged** `buzz-acp` (v0.5.14, already in the system closure)
connects, subscribes and drives turns identically to a source build — verified
side by side. Nothing in the runtime needs a Rust build.

### WRONG: `BUZZ_AUTH_TAG` in the systemd unit

`buzz-acp` has no `--auth-tag` and reads no `BUZZ_AUTH_TAG`. The auth tag is a
delegation artifact, not harness config. `buzz-acp` needs only `BUZZ_PRIVATE_KEY`,
`BUZZ_RELAY_URL`, `BUZZ_ACP_AGENT_COMMAND`, `BUZZ_ACP_AGENT_OWNER`.

### WRONG: `buzz --version` in the Verify section

Not a valid flag — it errors on every build. Use `buzz --help` and `command -v buzz`.

## Things that cost real time

**The relay is strictly host-scoped.** It answers only on the host its community is
mapped to. `ws://localhost:3000` returns a bare **404** with no explanation, and
`buzz-admin` refuses with `RELAY_URL host 'localhost:3000' is not mapped to a
community`. Everything must use `orpheus.wyrm-insen.ts.net:3000`. The 404 in
particular looks like a broken endpoint rather than a scoping rule.

**A new agent is not a relay member.** Fresh identities get
`Auth failed: restricted: not a relay member`. Membership is relay-level and
separate from channel membership — both are required.

The clean way to grant it needs **no credentials at all**, because the relay image
ships `buzz-admin` and the container already holds `DATABASE_URL`/`REDIS_URL`:

```bash
docker exec buzz-relay-1 buzz-admin list-members
docker exec buzz-relay-1 buzz-admin add-member --pubkey <hex> --role member
```

Do **not** do what I did first — Postgres and Redis are not published to the host,
so reaching them from outside means scraping `POSTGRES_PASSWORD` out of the
container. The `docker exec` route avoids the secret entirely.

**The relay had zero channels** after 11 days. An agent in no channel connects
happily and logs `no channel subscriptions resolved — agent will sit idle`.

**There is no mention backfill.** A mention published while the harness is down is
never seen — it is not queued and not replayed on connect. This is why the unit is
`Restart=always`, and it is the whole availability story.

## Auth: OAuth, no API key

`claude-agent-acp` reads `~/.claude/.credentials.json` and only skips it when
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is already set:

```js
m = await readFile(join(configDir, ".credentials.json"), "utf-8")
if (!p && !env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) m = await refresh() ?? m
```

Confirmed in the live path, not just the source — the session log reports
`apiType=native baseUrl=native`. **No API key and no new agenix secret** for the
LLM side. This is why the unit runs as `elias` and sets `HOME=/home/elias`: it is
that user's OAuth session the adapter finds. Running it as a system user would
silently lose authentication.

## Bring-up order (for a second agent)

1. `nak key generate` → the agent's own secret; `age --encrypt` it to
   `secrets/buzz/<name>.age` with the elias/root/orpheus recipients.
2. Mint the auth tag with the owner key (`compute_auth_tag`, above).
3. `docker exec buzz-relay-1 buzz-admin add-member --pubkey <hex> --role member`.
4. `buzz channels add-member --channel <uuid> --pubkey <hex>` — step 3 is not enough.
5. Enable the module; `nixos-rebuild switch`.

Steps 3 and 4 are the two that look redundant and are not.

## Verify

```bash
systemctl status buzz-agent --no-pager | head -5
journalctl -u buzz-agent -n 30 --no-pager      # want: connected / subscribed to channel / presence online
docker exec buzz-relay-1 buzz-admin list-members
buzz --format compact channels list
```

End-to-end proof looks like this in the channel:

```
owner  9951e27058b7… kind=9  'Reply with exactly the words: harness online. Nothing else.'
AGENT  3118b0bcf14e… kind=9  'harness online'
```

## Relay image pin

`services.buzz-relay.image` defaulted to `ghcr.io/block/buzz:main` — a floating tag
in a config that pins everything else. Now pinned to `sha-8232299`, which is the
revision that had been serving since 2026-08-18 (read off the running image's
`org.opencontainers.image.revision`), so applying it was a no-op.

**A `services.buzz-relay.*` change recreates the whole compose stack**, Postgres
included — not just the relay container. Data survives (volumes), but it is not the
single-container restart it looks like.

## Still open

- The relay is v0.2.1 while the CLI binaries are v0.5.14. They come from different
  upstream artifacts and have always drifted; nothing has forced the issue yet.
- `permission_mode=bypassPermissions` — the agent runs Claude with permissions
  bypassed inside `/var/lib/buzz-agent`. That directory is the blast radius, and it
  is worth a deliberate decision rather than a default.
- Half B of the original plan (building the **relay** image from a fork) was never
  needed and was not attempted. If it ever is: `BUZZ_AUTO_MIGRATE` is on and that
  Postgres now holds real state, so prove it against a separate compose project on
  its own database first. `docker exec buzz-postgres-1 pg_dump -U buzz buzz | gzip > …`
  before any such switch.
