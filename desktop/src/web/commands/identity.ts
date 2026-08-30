/**
 * Identity and workspace commands.
 *
 * Ports `commands/identity.rs` and `apply_workspace` onto in-page key storage.
 * The Tauri build resolves the key from an OS keyring; here it is loaded from
 * `identityStore` at install time and swapped by `import_identity`.
 */

import type { CommandArgs, CommandTable } from "@/web/ipc";
import {
  createSecretKey,
  encodeSecretKey,
  loadStoredDisplayName,
  loadStoredSecretKey,
  parseSecretKey,
  storeDisplayName,
  storeSecretKey,
} from "@/web/identityStore";
import {
  pubkey,
  relayScope,
  requirePubkey,
  requireSecretKey,
  secretKey,
  setRelayScope,
  setSecretKey,
  setToken,
} from "@/web/state";
import { signAuthEvent, signEvent } from "@/web/sign";
import { queryRelayOne } from "@/web/relayHttp";
import { defaultRelayUrl, autoConnectDefaultRelay } from "@/web/config";

/** Wire shape of `get_identity`, matching `RawIdentity` in `tauriIdentity`. */
type RawIdentity = {
  pubkey: string;
  display_name: string;
  storage: "browser";
  lost: boolean;
  locked: boolean;
  reset_failed: boolean;
};

/** NIP-01 profile metadata. */
const KIND_PROFILE = 0;

function identityPayload(): RawIdentity {
  return {
    pubkey: requirePubkey(),
    display_name: loadStoredDisplayName(),
    // Reported honestly: the key lives in this origin's storage, not in a
    // keyring, and the settings UI should say so rather than imply otherwise.
    storage: "browser",
    lost: false,
    locked: false,
    reset_failed: false,
  };
}

/**
 * Load or create the session identity.
 *
 * A browser has no first-run installer to mint a key, so a session with no
 * stored key generates one. That matches the desktop first-run behaviour: the
 * user lands on a working identity and can replace it from Settings.
 */
export function initializeIdentity(): void {
  setSecretKey(loadStoredSecretKey() ?? createSecretKey());
  storeSecretKey(requireSecretKey());
}

/** Refresh the cached display name from the identity's kind:0 profile. */
async function refreshDisplayName(): Promise<void> {
  if (!relayScope() || !pubkey()) {
    return;
  }
  try {
    const events = await queryRelayOne({
      kinds: [KIND_PROFILE],
      authors: [requirePubkey()],
      limit: 1,
    });
    const content = events[0]?.content;
    if (!content) {
      return;
    }
    const profile = JSON.parse(content) as {
      display_name?: unknown;
      name?: unknown;
    };
    const name =
      (typeof profile.display_name === "string" && profile.display_name) ||
      (typeof profile.name === "string" && profile.name) ||
      null;
    storeDisplayName(name);
  } catch {
    // Display name is cosmetic; a relay that is unreachable or has no profile
    // must not block identity resolution.
  }
}

export const identityCommands: CommandTable = {
  get_identity: () => {
    void refreshDisplayName();
    return identityPayload();
  },

  get_nsec: () => encodeSecretKey(requireSecretKey()),

  import_identity: (args: CommandArgs) => {
    const nsec = args.nsec;
    if (typeof nsec !== "string" || !nsec.trim()) {
      throw new Error("Enter an nsec private key.");
    }
    setSecretKey(parseSecretKey(nsec));
    storeSecretKey(requireSecretKey());
    storeDisplayName(null);
    void refreshDisplayName();
    return identityPayload();
  },

  // The key is already durable the moment it is imported, so there is no
  // separate persistence step — the command exists to satisfy the caller.
  persist_current_identity: () => identityPayload(),

  is_shared_identity: () => false,

  sign_out: () => {
    setSecretKey(null);
    storeSecretKey(null);
    storeDisplayName(null);
    window.location.reload();
  },

  sign_event: (args: CommandArgs) =>
    JSON.stringify(
      signEvent({
        kind: Number(args.kind),
        content: String(args.content ?? ""),
        tags: (args.tags as string[][] | undefined) ?? [],
        created_at:
          typeof args.createdAt === "number" ? args.createdAt : undefined,
      }),
    ),

  create_auth_event: (args: CommandArgs) =>
    JSON.stringify(
      signAuthEvent({
        challenge: String(args.challenge ?? ""),
        relayUrl: String(args.relayUrl ?? ""),
      }),
    ),

  get_default_relay_url: () => defaultRelayUrl(),

  auto_connect_default_relay_enabled: () => autoConnectDefaultRelay(),

  apply_workspace: (args: CommandArgs) => {
    const relayUrl = args.relayUrl;
    if (typeof relayUrl !== "string" || !relayUrl.trim()) {
      throw new Error("A community relay URL is required.");
    }
    setRelayScope(relayUrl);
    setToken(typeof args.token === "string" ? args.token : null);
    // A community may carry its own key in the desktop build's migration path;
    // honouring it here keeps an imported community working after a switch.
    if (typeof args.nsec === "string" && args.nsec.trim()) {
      setSecretKey(parseSecretKey(args.nsec));
      storeSecretKey(requireSecretKey());
    }
    if (!secretKey()) {
      initializeIdentity();
    }
    void refreshDisplayName();
    return null;
  },

  get_relay_ws_url: () => {
    const scope = relayScope();
    if (!scope) {
      throw new Error("No relay is configured for this browser session.");
    }
    return scope.wsUrl;
  },

  get_relay_http_url: () => {
    const scope = relayScope();
    if (!scope) {
      throw new Error("No relay is configured for this browser session.");
    }
    return scope.httpUrl;
  },
};
