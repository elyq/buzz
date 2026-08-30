/**
 * Native-only commands and their browser behaviour.
 *
 * Three kinds of thing live here.
 *
 * 1. **Cosmetic native affordances** — tray badges, haptics, window vibrancy,
 *    sleep prevention. A browser has no equivalent and the caller does not need
 *    one, so these resolve as no-ops rather than surfacing an error the user
 *    can do nothing about.
 * 2. **Capability probes** — "is auto-update supported?", "are baked build
 *    credentials present?". A truthful negative answer is the whole point.
 * 3. **Locally-hosted subsystems** — managed agent processes, the terminal, the
 *    huddle audio pipeline, mesh compute. These need a machine, not a page.
 *    They are deliberately absent from this table so `invoke` rejects with
 *    `UnsupportedCommandError` and the feature reports itself unavailable.
 *
 * Everything here is registered first, so adding a real implementation in
 * another module simply supersedes it.
 */

import type { CommandArgs, CommandTable } from "@/web/ipc";

function noop(): null {
  return null;
}

function emptyList(): unknown[] {
  return [];
}

export const unsupportedCommands: CommandTable = {
  // ── Cosmetic native affordances ───────────────────────────────────────────
  set_prevent_sleep_active: noop,
  set_window_vibrancy: noop,
  perform_sidebar_default_haptic: noop,
  title_bar_double_click: noop,
  update_tray_agent_activity: noop,
  clear_tray_agent_activity: noop,
  take_tray_actions: emptyList,
  requeue_tray_actions: noop,
  get_os_idle_seconds: () => 0,

  // ── Capability probes ─────────────────────────────────────────────────────
  is_auto_update_supported: () => false,
  agent_access_owner_only: () => false,
  agent_metric_archive_default_enabled: () => false,
  observer_archive_default_enabled: () => false,
  relay_reconnect_hook_configured: () => false,
  // Internal builds bake provider credentials into the binary. A browser bundle
  // never does, and answering "none" is what lets the dialogs prompt normally.
  get_baked_build_env: emptyList,
  get_baked_build_env_keys: emptyList,

  // ── Locally-hosted subsystems, reported as empty rather than broken ───────
  // Managed agents run as processes on a machine. A browser can see agents that
  // already run elsewhere (that is `list_relay_agents`), but hosts none itself.
  list_managed_agents: emptyList,
  list_personas: emptyList,
  fetch_persona_catalog: emptyList,
  list_teams: emptyList,
  list_voice_registry: emptyList,
  list_builderlab_communities: emptyList,
  mesh_installed_models: emptyList,
  mesh_model_catalog: emptyList,
  // ACP harnesses are command-line programs discovered on the local machine.
  // A browser finds none, and reports that rather than failing the probe.
  discover_acp_providers: emptyList,
  discover_acp_runtimes: emptyList,

  /**
   * Legacy Sprout workspace storage, which a browser origin never has.
   *
   * The caller migrates whatever this returns into the current keys, so an
   * empty snapshot is the correct answer rather than a failure it has to catch.
   */
  get_legacy_workspace_storage: () => ({
    workspaces: null,
    activeWorkspaceId: null,
    onboardingCompletions: [],
  }),

  /**
   * Deep-link queues, which are empty in a browser.
   *
   * The Tauri build queues `buzz://` links the OS hands it before the window is
   * ready. A tab is opened at a URL instead, so nothing is ever pending — but
   * the drain loop calls these unconditionally and must get an answer.
   */
  take_pending_community_deep_link: () => null,
  acknowledge_pending_community_deep_link: () => true,
  clear_pending_navigation_deep_links: noop,

  // ── Notifications ─────────────────────────────────────────────────────────
  /**
   * Post a browser notification.
   *
   * Permission is requested lazily on the first notification rather than at
   * startup, so a user who never enables them is never prompted.
   */
  show_native_notification: async (args: CommandArgs) => {
    if (!("Notification" in window)) {
      return null;
    }
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
    if (Notification.permission !== "granted") {
      return null;
    }
    new Notification(String(args.title ?? "Buzz"), {
      body: typeof args.body === "string" ? args.body : undefined,
      icon: typeof args.iconUrl === "string" ? args.iconUrl : undefined,
    });
    return null;
  },
};
