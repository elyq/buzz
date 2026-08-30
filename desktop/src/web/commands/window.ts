/**
 * The window and webview surface — `plugin:window|*` and `plugin:webview|*`.
 *
 * These are not Buzz commands; they are `@tauri-apps/api`'s own, reached
 * through `getCurrentWindow()` and `getCurrentWebview()`. Several call sites
 * use them unguarded by `isTauri()` (fullscreen state, the drag region, badge
 * counts, the zoom pin), so a browser build has to answer them or the first
 * render after sign-in throws.
 *
 * A browser tab is not an OS window, but it is not nothing either: fullscreen,
 * focus, visibility, size and the app badge all have real equivalents and are
 * wired to them here. What genuinely has no counterpart — dragging a frame,
 * bouncing a dock icon — is a no-op rather than a rejection, because these are
 * incidental niceties on paths whose actual work must still run.
 */

import type { CommandArgs, CommandTable } from "@/web/ipc";

/** The label Tauri gives the sole window when the config declares none. */
export const MAIN_WINDOW_LABEL = "main";

/** `@tauri-apps/api` reads these directly off `__TAURI_INTERNALS__`. */
export const windowMetadata = {
  currentWindow: { label: MAIN_WINDOW_LABEL },
  currentWebview: {
    windowLabel: MAIN_WINDOW_LABEL,
    label: MAIN_WINDOW_LABEL,
  },
};

function noop(): null {
  return null;
}

/**
 * The document element, as the fullscreen target.
 *
 * The browser only grants fullscreen from a user gesture, so a programmatic
 * request can reject; callers treat fullscreen as a display preference, so a
 * refusal is swallowed and the subsequent `is_fullscreen` read reports the
 * truth rather than the intent.
 */
async function setFullscreen(enable: boolean): Promise<null> {
  try {
    if (enable) {
      await document.documentElement.requestFullscreen();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch {
    // Denied without a gesture, or unsupported. Not an error worth surfacing.
  }
  return null;
}

/**
 * Mirror the unread count onto the tab's app badge where the browser has one.
 *
 * `setAppBadge` is Chromium-only and installed-PWA-only in practice, so every
 * call is guarded and failure is silent — this is the browser's equivalent of
 * the dock badge, not a load-bearing path.
 */
function setBadgeCount(args: CommandArgs): null {
  const badge = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  const count = typeof args.count === "number" ? args.count : null;
  try {
    if (count && count > 0) {
      void badge.setAppBadge?.(count)?.catch(() => {});
    } else {
      void badge.clearAppBadge?.()?.catch(() => {});
    }
  } catch {
    // No badge API on this browser.
  }
  return null;
}

export const windowCommands: CommandTable = {
  // ── Lifecycle and focus ────────────────────────────────────────────────
  // A tab may only close itself when script opened it; otherwise this is
  // inert, which is the desired outcome anyway — closing the window is not
  // something a hosted page should do on the user's behalf.
  "plugin:window|close": () => {
    window.close();
    return null;
  },
  "plugin:window|destroy": () => {
    window.close();
    return null;
  },
  "plugin:window|set_focus": () => {
    window.focus();
    return null;
  },
  "plugin:window|show": () => {
    window.focus();
    return null;
  },
  "plugin:window|unminimize": () => {
    window.focus();
    return null;
  },
  "plugin:window|hide": noop,
  "plugin:window|minimize": noop,
  "plugin:window|maximize": noop,
  "plugin:window|unmaximize": noop,
  "plugin:window|center": noop,
  "plugin:window|set_size": noop,
  "plugin:window|set_position": noop,
  "plugin:window|set_resizable": noop,
  "plugin:window|set_always_on_top": noop,

  // ── Chrome the browser does not give a page ────────────────────────────
  // `start_dragging` backs the custom title bar's drag region. There is no
  // frame to move, and the region is also the app's own header, so silently
  // doing nothing leaves the header working as an ordinary element.
  "plugin:window|start_dragging": noop,
  "plugin:window|request_user_attention": noop,
  "plugin:window|set_title": (args: CommandArgs) => {
    if (typeof args.title === "string") {
      document.title = args.title;
    }
    return null;
  },
  "plugin:window|title": () => document.title,

  // ── Badges ─────────────────────────────────────────────────────────────
  "plugin:window|set_badge_count": setBadgeCount,
  "plugin:window|set_badge_label": noop,
  "plugin:window|set_overlay_icon": noop,
  "plugin:window|set_progress_bar": noop,

  // ── State the browser can answer truthfully ────────────────────────────
  "plugin:window|is_fullscreen": () => document.fullscreenElement !== null,
  "plugin:window|set_fullscreen": (args: CommandArgs) =>
    setFullscreen(args.value === true),
  "plugin:window|is_focused": () => document.hasFocus(),
  "plugin:window|is_visible": () => document.visibilityState === "visible",
  "plugin:window|is_minimized": () => document.visibilityState === "hidden",
  "plugin:window|is_maximized": () => false,
  "plugin:window|is_decorated": () => false,
  "plugin:window|is_resizable": () => true,
  "plugin:window|is_closable": () => true,
  "plugin:window|is_minimizable": () => false,
  "plugin:window|is_maximizable": () => false,
  "plugin:window|is_enabled": () => true,
  "plugin:window|is_always_on_top": () => false,
  "plugin:window|theme": () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",

  // Physical pixels, which is what PhysicalSize/PhysicalPosition wrap. The
  // viewport has no screen origin available to a page, so position is 0,0.
  "plugin:window|scale_factor": () => window.devicePixelRatio,
  "plugin:window|inner_size": () => ({
    width: Math.round(window.innerWidth * window.devicePixelRatio),
    height: Math.round(window.innerHeight * window.devicePixelRatio),
  }),
  "plugin:window|outer_size": () => ({
    width: Math.round(window.innerWidth * window.devicePixelRatio),
    height: Math.round(window.innerHeight * window.devicePixelRatio),
  }),
  "plugin:window|inner_position": () => ({ x: 0, y: 0 }),
  "plugin:window|outer_position": () => ({ x: 0, y: 0 }),
  "plugin:window|get_all_windows": () => [MAIN_WINDOW_LABEL],

  // ── Webview ────────────────────────────────────────────────────────────
  // The desktop app pins the native webview zoom to 1 and implements Cmd +/-
  // by scaling the root font-size instead. A page cannot set browser zoom, but
  // it does not need to: the rem-based scaling is what actually resizes text,
  // and it is pure CSS that works here unchanged.
  "plugin:webview|set_webview_zoom": noop,
  "plugin:webview|set_webview_focus": () => {
    window.focus();
    return null;
  },
  "plugin:webview|webview_size": () => ({
    width: Math.round(window.innerWidth * window.devicePixelRatio),
    height: Math.round(window.innerHeight * window.devicePixelRatio),
  }),
  "plugin:webview|webview_position": () => ({ x: 0, y: 0 }),
  "plugin:webview|get_all_webviews": () => [MAIN_WINDOW_LABEL],
  "plugin:webview|internal_toggle_devtools": noop,
  "plugin:webview|clear_all_browsing_data": noop,
};
