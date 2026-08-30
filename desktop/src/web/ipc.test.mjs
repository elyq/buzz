/**
 * Channel resolution across the browser IPC seam.
 *
 * `invoke()` in `@tauri-apps/api` hands its `args` to the bridge untouched —
 * under Tauri it is the Rust-injected internals that serializes them. So a
 * `Channel` arrives as a **live object** carrying `SERIALIZE_TO_IPC_FN`, not as
 * the `__CHANNEL__:<id>` string it serializes to. A bridge that matches only
 * the string form typechecks, boots, and then drops every channel argument:
 * `plugin:websocket|connect` reported "A message channel is required to
 * connect" and the relay never came up.
 *
 * Nothing about that is visible to `tsc` — the argument is `unknown` either
 * way — so it is pinned here instead.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
// `installIpc` assigns to `window` at call time, so the global has to exist
// before the module is imported and run.
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
});

const { installIpc, register } = await import("./ipc.ts");

/** The key `@tauri-apps/api` exports as `SERIALIZE_TO_IPC_FN`. */
const SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";

installIpc();

/** Invoke `command` through the real seam, exactly as the app would. */
function invoke(command, args) {
  return globalThis.window.__TAURI_INTERNALS__.invoke(command, args);
}

/** Register a command that captures the resolved argument it receives. */
function captureCommand(name) {
  const seen = {};
  register({
    [name]: (args) => {
      seen.args = args;
      return null;
    },
  });
  return seen;
}

test("a live Channel object resolves to a usable handle", async () => {
  const delivered = [];
  const id = globalThis.window.__TAURI_INTERNALS__.transformCallback(
    (envelope) => delivered.push(envelope),
    false,
  );
  // Exactly the shape @tauri-apps/api's Channel presents to the bridge.
  const channel = { [SERIALIZE_TO_IPC_FN]: () => `__CHANNEL__:${id}` };

  const seen = captureCommand("test_channel_object");
  await invoke("test_channel_object", { onMessage: channel });

  assert.equal(
    typeof seen.args.onMessage?.send,
    "function",
    "a Channel argument must arrive as a handle, not as the raw object",
  );

  seen.args.onMessage.send({ hello: "world" });
  assert.deepEqual(delivered, [{ index: 0, message: { hello: "world" } }]);
});

test("the pre-serialized string form still resolves", async () => {
  const delivered = [];
  const id = globalThis.window.__TAURI_INTERNALS__.transformCallback(
    (envelope) => delivered.push(envelope),
    false,
  );

  const seen = captureCommand("test_channel_string");
  await invoke("test_channel_string", { onMessage: `__CHANNEL__:${id}` });

  seen.args.onMessage.send("first");
  seen.args.onMessage.send("second");
  // Indices must advance: the Channel consumer drops out-of-order messages.
  assert.deepEqual(delivered, [
    { index: 0, message: "first" },
    { index: 1, message: "second" },
  ]);
});

test("ordinary arguments are passed through untouched", async () => {
  const seen = captureCommand("test_plain_args");
  const payload = { channelId: "not-a-channel", count: 3, nested: { a: 1 } };
  await invoke("test_plain_args", payload);

  assert.deepEqual(seen.args, payload);
});

test("an object without the IPC marker is not mistaken for a channel", async () => {
  const seen = captureCommand("test_lookalike");
  // `id` alone must not be enough — plenty of real payloads carry one.
  await invoke("test_lookalike", { onMessage: { id: 1 } });

  assert.deepEqual(seen.args.onMessage, { id: 1 });
});

test("unregisterCallback stops delivery to a released id", async () => {
  const delivered = [];
  const internals = globalThis.window.__TAURI_INTERNALS__;
  const id = internals.transformCallback((e) => delivered.push(e), false);

  // `Channel.cleanupCallback()` calls this itself the moment a stream reaches
  // its end index, so it must exist — its absence was a TypeError on every
  // channel that completed normally.
  assert.equal(typeof internals.unregisterCallback, "function");

  const seen = captureCommand("test_channel_release");
  await invoke("test_channel_release", { onMessage: `__CHANNEL__:${id}` });

  seen.args.onMessage.send("before release");
  internals.unregisterCallback(id);
  seen.args.onMessage.send("after release");

  // Only the pre-release message lands: proof the id was actually dropped,
  // rather than the callback merely never having been invoked.
  assert.deepEqual(delivered, [{ index: 0, message: "before release" }]);
});

test("metadata carries the window and webview labels", () => {
  const { metadata } = globalThis.window.__TAURI_INTERNALS__;
  // getCurrentWindow() / getCurrentWebview() dereference these before any
  // command is dispatched, so a missing field is a TypeError at first render.
  assert.equal(typeof metadata.currentWindow.label, "string");
  assert.equal(typeof metadata.currentWebview.label, "string");
  assert.equal(
    metadata.currentWebview.windowLabel,
    metadata.currentWindow.label,
  );
});
