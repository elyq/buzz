// Deployment configuration for the browser build, read by src/web/config.ts.
//
// Served next to the bundle and loaded before it, so a deployed app can be
// pointed at a different relay by editing this one file — no rebuild, no
// changed asset hashes. Values here win over the VITE_BUZZ_RELAY_URL baked in
// at build time, which in turn wins over the origin the app was served from.
//
// Left empty by default so the build-time value stands.
//
//   window.__BUZZ_WEB_CONFIG__ = {
//     relayUrl: "wss://relay.example:2126",
//     communityName: "Example",
//   };
