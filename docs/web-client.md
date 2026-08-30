# The browser build of the desktop app

`pnpm --filter buzz build:web` compiles `desktop/` into a static bundle that
runs the real desktop UI in a browser, with a TypeScript backend in place of the
Tauri one. This document explains why that is possible, what the bridge does,
what it deliberately does not do, and how the bundle is deployed.

---

## Why a web build works

The desktop app looks Tauri-shaped and mostly is not. Of 1,637 TypeScript files
under `desktop/src`, **68 reference Tauri at all** — about 4%. Everything that
makes Buzz a Nostr client already lives in TypeScript:

- `shared/api/relayClientSession.ts` owns the relay protocol end to end —
  subscriptions, filters, the NIP-42 handshake, reconnect and backoff, batching,
  chunked history paging.
- `shared/api/relayChannelFilters.ts`, `relayClosedRecovery.ts`,
  `relayReconnectPolicy.ts` and friends own the recovery behaviour.

Tauri supplies three things underneath that, and each has a browser equivalent:

| Tauri provides | Browser equivalent |
|---|---|
| A native WebSocket behind `plugin:websocket\|*` | `WebSocket` |
| Signing from an OS keyring | `nostr-tools` over a key in `localStorage` |
| An HTTP client proxying `POST /query` and `/events` | `fetch` with a NIP-98 header |

Most of the remaining Rust commands are not native work at all — they are relay
queries plus pure conversion. `list_relay_agents`, the command behind agent
mentions, is four `POST /query` calls and a signature check.

`desktop/src/testing/e2eBridge.ts` already proved the UI renders in a plain
browser: it installs a mock `window.__TAURI_INTERNALS__` and the whole app comes
up against fixtures. `desktop/src/web/` is the same seam backed by the live
relay instead.

---

## What the bridge is

`desktop/src/web/` — installed from `main.tsx` before the first render, and only
when `import.meta.env.MODE === "web"`, so a Tauri build never bundles it.

```
src/web/
  install.ts       registration order and entry point
  ipc.ts           window.__TAURI_INTERNALS__: invoke, transformCallback, Channel
  events.ts        the Tauri event bus (listen/emit) in-page
  state.ts         active relay scope + signing key
  identityStore.ts key persistence for this origin
  sign.ts          event signing, NIP-42 auth, NIP-98 headers
  relayHttp.ts     POST /query, /count, /events with paging
  websocket.ts     plugin:websocket|* over a browser WebSocket
  publish.ts       sign-and-submit
  config.ts        runtime configuration (relay URL)
  convert/         pure ports of src-tauri/src/nostr_convert.rs and events.rs
  commands/        the command implementations, grouped by surface
  commands/window.ts  plugin:window|* and plugin:webview|*
```

### The `__TAURI_INTERNALS__` contract is wider than `invoke`

`@tauri-apps/api` reads four things off that object, and two of them are never
dispatched as commands — so a bridge that implements only `invoke` compiles,
boots, and then throws on a code path no probe reaches until the app is signed
in:

| Field | Read by | Consequence if absent |
|---|---|---|
| `invoke` | everything | — |
| `transformCallback` | `Channel`, event listeners | — |
| `metadata.currentWindow.label` | `getCurrentWindow()` | `TypeError` before any command runs |
| `unregisterCallback` | `Channel.cleanupCallback()` | `TypeError` when a stream ends |

`metadata` is dereferenced eagerly, and several call sites reach
`getCurrentWindow()` without an `isTauri()` guard (fullscreen state, the drag
region, badge counts, the zoom pin). `unregisterCallback` is worse-hidden:
`Channel` calls it *itself* once a stream reaches its end index, so nothing
fails until a channel completes normally.

A related trap sits one step further in: `invoke()` hands its `args` to the
bridge **unserialized**. Under Tauri it is the Rust-injected internals that
walks the payload and calls `SERIALIZE_TO_IPC_FN` on anything that has it, so a
`Channel` reaches a browser bridge as a *live object*, never as the
`__CHANNEL__:<id>` string it serializes to. Matching only the string form
typechecks — the argument is `unknown` either way — and then drops every channel
argument, which is what `plugin:websocket|connect` was reporting as "A message
channel is required to connect". `ipc.test.mjs` pins both forms.

`commands/window.ts` answers the window and webview plugins. A tab is not an OS
window, but it is not nothing: fullscreen, focus, visibility, size, theme and
the app badge are wired to their real browser equivalents. What has no
counterpart — dragging a frame, bouncing a dock icon — is a no-op rather than a
rejection, because these are incidental to paths whose actual work must run.

Every handler is a port of the Rust command it replaces, and the file header in
each module names its source. Where a port narrows behaviour, the header says so
rather than leaving the difference to be discovered.

### Agent mentions

This is the surface the browser build exists for, so it is ported faithfully
rather than approximated. `commands/agents.ts` reproduces
`agent_discovery/relay_directory.rs` including its authorization rules:

1. Relay-signed kind:39002 membership is the **only** candidate source, so the
   directory is bounded to channels this identity can see, and only `bot`-role
   p-tags become candidates.
2. Each candidate's kind:0 profile is checked for a NIP-OA `auth` tag, verified
   against the **profile's own author** (`convert/nipOa.ts`). A marker copied
   onto someone else's profile cannot turn a person into an agent.
3. A kind:30177 managed-agent policy counts only when its author is the owner
   that attestation names. A verified coordinate reserves the identity even when
   its policy fails to parse, so a stale self-authored kind:10100 record cannot
   win back permissions the owner has since narrowed.

This is the same chain the Flutter client walks in
`mobile/lib/shared/mentions/agent_identity_provider.dart`.

#### One deliberate divergence: where the name comes from

The authorization chain above is ported as-is. The **naming** is not, because
the upstream behaviour makes mentions unusable on a real relay.

`agents_from_events` in Rust names an agent from its kind:10100 directory entry
and falls back to an npub. On a live relay that entry's content is as thin as
`{"channel_add_policy":"anyone"}`, so the fallback is what ships — while the
name people actually type (`cid`, `intake`) sits in the agent's kind:0 profile.

That is not a cosmetic placeholder. `buildMentionCandidates` resolves a
candidate's label as:

```ts
member.displayName?.trim() || agentName || profile?.displayName?.trim() || …
```

`agentName` outranks the profile name, so the synthesized npub wins and there is
nothing left to match: the composer lists agents as npubs and `@cid` finds
nobody. The desktop build has the same defect for the same reason.

So `convert/agentDirectory.ts` resolves the name as: the directory entry's own
name → the agent's kind:0 `display_name`/`name` → the pubkey, last resort. The
kind:0 profile is self-authored and already fetched in the same call, so this
adds no trust and no round trip. `convert/agentDirectory.test.mjs` pins it,
using the thin directory content verbatim.

Flutter avoids the problem differently — it identifies agents by pubkey and
labels them from the profile cache — which is why mentions worked there while
both TypeScript clients showed npubs.

---

## Identity

The browser holds a Nostr secret key in `localStorage` for its origin and signs
in-page; the relay only ever receives signatures. This mirrors the Flutter
client, which keeps an `nsec` in per-community storage.

It is a real trade: anything with script access to that origin can read the key.
A browser has no keyring, and the alternatives were worse for this deployment —
a NIP-07 extension rules out phones, and NIP-AB pairing needs a running desktop
app. The origin is tailnet-only and serves nothing but this bundle.

First run offers **Create a new identity key** or **Use an existing key**. Use
the second with an nsec that is already a relay member — the relay requires
membership (`BUZZ_REQUIRE_RELAY_MEMBERSHIP`), and a fresh key gets
`403 relay_membership_required` on every query until it is added:

```bash
docker exec buzz-relay-1 buzz-admin add-member --pubkey <hex> --role member
```

---

## Same origin is a requirement

The bundle must be served from the relay's own origin. Two independent
mechanisms enforce it:

- **CORS.** The relay pins `BUZZ_CORS_ORIGINS` to one origin. Another origin's
  `POST /query` is blocked by the browser before the relay sees it.
- **NIP-98.** `query_events` verifies the signed `u` tag against
  `nip98_expected_url()` — `{scheme}://{tenant host}{path}`, where the host is
  the one the community is mapped to and the scheme follows the relay's own TLS
  posture. A header signed for a different host is rejected even with CORS open.

`state.ts` derives both URLs from the configured relay by translating only the
scheme (`ws`→`http`, `wss`→`https`) and preserving host and port exactly, which
is what makes the signed `u` tag match.

Mounting the bundle under a path on the relay's TLS port satisfies both and
needs no relay change.

---

## Configuration

Layered, so a deployed bundle can be retargeted without a rebuild:

1. `window.__BUZZ_WEB_CONFIG__ = { relayUrl, communityName }` from
   `public/config.js`, loaded by a `<script>` in `index.html` ahead of the
   bundle. It ships empty; editing the deployed copy retargets the app with no
   rebuild and no changed asset hashes.
2. `VITE_BUZZ_RELAY_URL`, baked in at build time. Setting either this or
   `relayUrl` also makes the app auto-connect instead of showing the community
   picker — a deployment that names its relay is single-community by
   construction.
3. The origin the app was served from — correct whenever the relay serves the
   bundle.

`BUZZ_WEB_BASE` (default `/desktop/`) sets the Vite base path. It must match the
path the bundle is mounted at, or every hashed asset 404s. Routing itself is
unaffected: the app uses `createHashHistory`.

### Asset paths must go through `assetUrl()`

Vite rewrites the asset paths it can see — `src`/`href` in `index.html`, `url()`
in CSS — against the base path. A path written as a string in TypeScript is
opaque to it and ships verbatim, so the browser resolves it against the origin
root. Under Tauri the base is `/` and that is correct; mounted under `/desktop/`
it resolves to the relay's root and 404s.

So any bundled asset referenced from TypeScript goes through
`shared/lib/assetUrl.ts`:

```ts
<img src={assetUrl("/landing/buzz-wordmark.png")} />
new Audio(assetUrl(`/sounds/${name}.mp3`));
```

`BASE_URL` is `/` under Tauri, so the helper is the identity function there and
the desktop build is byte-identical.

---

## What the browser build does not do

Three categories, all of them honest about themselves rather than silently
degraded (`commands/unsupported.ts`):

**Absent by nature.** Managed agent processes, the terminal, huddle audio, mesh
compute, ACP harness discovery, the updater, the tray. These need a machine.
They reject with `UnsupportedCommandError` and the feature reports itself
unavailable. Agents reachable by mention are unaffected — those run on the
relay's side, not in the client.

**No-ops.** Tray badges, haptics, window vibrancy, sleep prevention.

**Narrowed, and documented in place:**

- `unread_catch_up` classifies from the fetched window alone. The desktop build
  seeds notification membership from a SQLite store the browser has no
  equivalent of. DMs, broadcasts, direct mentions and top-level messages
  classify identically; a reply in a thread joined before the window can go
  uncounted until that thread is opened.
- `observed_unread_*` is unimplemented, so unread projections stay in renderer
  memory — the fallback the renderer already implements
  (`useObservedUnreadPersistence`'s `nativeFailedRef`).
- Upload progress reports dispatch and completion rather than a byte stream:
  `fetch` exposes no upload progress.
- Deep-link queues are always empty. A tab is opened at a URL; nothing is queued
  ahead of it.

---

## Building and probing

```bash
cd desktop
pnpm build:web                       # → dist-web/, base /desktop/
BUZZ_WEB_BASE=/x/ pnpm build:web     # different mount

node scripts/web-probe.mjs           # boot it headless and report gaps
```

`scripts/web-probe.mjs` serves `dist-web` under its base path, boots it in
Chromium, and prints every command that reached the bridge without an
implementation plus any console errors. `PROBE_CLICKS` walks the first-run gate
(`"Create a new identity key|Next|Next"`), `PROBE_CHROME` points at a browser,
and `BUZZ_PROBE_RELAY` picks the relay. It launches with `--disable-web-security`
so a throwaway localhost origin can reach the relay; the deployed bundle is
same-origin and needs no such flag.

Adding a command is a one-line registration in the relevant `commands/` module.

### Auditing the command surface

The probe only reports commands the app actually *reached*, so a gap on a path
that needs a signed-in, relay-member session stays invisible until a user hits
it — that is how `get_channel_window` shipped missing and left every channel
blank while the inbox loaded fine.

`window.__BUZZ_WEB_COMMANDS__()` lists every command the deployed bundle
answers, without invoking any of them. Diff it against the Rust surface:

```bash
grep -rhA3 '#\[tauri::command\]' desktop/src-tauri/src \
  | grep -oE 'fn [a-z0-9_]+' | sed 's/fn //' | sort -u > /tmp/rust-cmds
# then, in the page: copy(__BUZZ_WEB_COMMANDS__().join("\n"))
comm -23 /tmp/rust-cmds /tmp/web-cmds
```

Most of the difference is intentional — machine-only surfaces reject by design.
The ones that matter are the commands Rust implements as *pure relay queries*,
since those have no reason not to work in a browser. Filter for a body that
calls `query_relay` and touches no native API; that is the real gap list.

---

## Deployment (orpheus)

Served by `services.buzz-web` at `/desktop` on the relay's own TLS port, from a
static bundle in `/var/lib/buzz-web`:

```bash
scripts/buzz/build-web.sh            # in ~/.config/nixos
sudo systemctl restart buzz-web
```

The xpra stream that previously held `/desktop`
(`services.buzz-desktop-web`) moves to `/stream`. It is worth keeping: it runs
the real binary with its real Rust backend, so it still covers the local
harnesses, terminal and huddle audio the browser build cannot. It remains one
shared session authenticated as the owner, which is exactly the property this
bundle does not have — each browser here holds its own key.
