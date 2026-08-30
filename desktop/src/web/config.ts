/**
 * Runtime configuration for the browser build.
 *
 * The Tauri build reads `BUZZ_RELAY_URL` from the process environment at
 * startup. A static bundle has no environment, so configuration is layered:
 *
 * 1. `window.__BUZZ_WEB_CONFIG__`, set by a `config.js` served next to the
 *    bundle. Editing that one file retargets a deployed app with no rebuild.
 * 2. `VITE_BUZZ_RELAY_URL`, baked in at build time.
 * 3. The origin the app itself was served from, which is correct whenever the
 *    relay also serves the bundle.
 */

/** Values a deployment may set in `config.js`. */
export type WebRuntimeConfig = {
  /** Relay to offer as the default community, e.g. `ws://relay.example:3000`. */
  relayUrl?: string;
  /** Community name shown before the relay's own NIP-11 name resolves. */
  communityName?: string;
};

declare global {
  interface Window {
    __BUZZ_WEB_CONFIG__?: WebRuntimeConfig;
  }
}

function fromOrigin(): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}`;
}

/** The relay URL a fresh browser session should default to. */
export function defaultRelayUrl(): string {
  const configured =
    window.__BUZZ_WEB_CONFIG__?.relayUrl?.trim() ||
    (import.meta.env.VITE_BUZZ_RELAY_URL as string | undefined)?.trim();
  return configured || fromOrigin();
}

/** Display name for the default community, when the deployment sets one. */
export function defaultCommunityName(): string | null {
  return window.__BUZZ_WEB_CONFIG__?.communityName?.trim() || null;
}

/**
 * Whether the app should connect to `defaultRelayUrl()` without asking.
 *
 * A deployment that names its relay is single-community by construction, so
 * the community picker would only ever offer the one answer.
 */
export function autoConnectDefaultRelay(): boolean {
  return Boolean(
    window.__BUZZ_WEB_CONFIG__?.relayUrl?.trim() ||
      (import.meta.env.VITE_BUZZ_RELAY_URL as string | undefined)?.trim(),
  );
}
