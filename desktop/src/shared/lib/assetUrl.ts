/**
 * Resolve a bundled asset against the build's base path.
 *
 * Vite rewrites the asset paths it can see — `src`/`href` in `index.html`, and
 * `url()` in CSS — but a path written as a string in TypeScript is opaque to
 * it, so it ships verbatim and the browser resolves it against the origin
 * root. That is correct only when the app is served from `/`, which the Tauri
 * build always is. The browser build is mounted under a path (`/desktop/`),
 * where every such literal resolves to the relay's root instead and 404s.
 *
 * `BASE_URL` is `/` under Tauri, so this is the identity function there.
 */
export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
}
