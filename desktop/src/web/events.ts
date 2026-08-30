/**
 * The Tauri event bus, in-page.
 *
 * `listen()` from `@tauri-apps/api/event` is not optional plumbing: the app
 * subscribes to backend-emitted events for upload progress, deep links, relay
 * reconnects and agent activity. Without it, `listen` rejects during module
 * initialisation and takes the render down with it.
 *
 * Registration mirrors the plugin's protocol exactly — `listen` hands over a
 * callback id and receives an event id, and `_unlisten` calls
 * `window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener` before invoking
 * `plugin:event|unlisten`, so that object has to exist too.
 */

import {
  deliverCallback,
  type CommandArgs,
  type CommandTable,
} from "@/web/ipc";

type Listener = { eventId: number; event: string; callbackId: number };

const listeners: Listener[] = [];
let nextEventId = 1;

function unregister(event: string, eventId: number): void {
  const index = listeners.findIndex(
    (listener) => listener.eventId === eventId && listener.event === event,
  );
  if (index >= 0) {
    listeners.splice(index, 1);
  }
}

/**
 * Deliver an event to every listener registered for it.
 *
 * Bridge code calls this wherever the Rust backend would have emitted — media
 * upload progress is the main one — so the renderer's existing listeners work
 * unchanged.
 */
export function emitAppEvent(event: string, payload: unknown): void {
  // Copied first: a handler that unlistens while being called must not shift
  // the array out from under the iteration.
  for (const listener of [...listeners]) {
    if (listener.event === event) {
      deliverCallback(listener.callbackId, {
        event,
        id: listener.eventId,
        payload,
      });
    }
  }
}

/** Install the object `@tauri-apps/api/event` reaches for during unlisten. */
export function installEventInternals(): void {
  // `@tauri-apps/api` declares this global as always present because the Tauri
  // runtime injects it before any script runs; in the browser the bridge is
  // what injects it, so the assignment goes through the window type.
  (
    window as typeof window & {
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (event: string, eventId: number) => void;
      };
    }
  ).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: unregister };
}

export const eventCommands: CommandTable = {
  "plugin:event|listen": (args: CommandArgs) => {
    const eventId = nextEventId++;
    listeners.push({
      eventId,
      event: String(args.event ?? ""),
      callbackId: Number(args.handler),
    });
    return eventId;
  },

  "plugin:event|unlisten": (args: CommandArgs) => {
    unregister(String(args.event ?? ""), Number(args.eventId));
    return null;
  },

  "plugin:event|emit": (args: CommandArgs) => {
    emitAppEvent(String(args.event ?? ""), args.payload);
    return null;
  },

  // A browser build is one window, so an event addressed to a specific target
  // and one broadcast to any target reach the same listeners.
  "plugin:event|emit_to": (args: CommandArgs) => {
    emitAppEvent(String(args.event ?? ""), args.payload);
    return null;
  },

  // `null` is the updater's "no update available" answer. A browser tab is
  // updated by reloading it, so that is always the truthful response.
  "plugin:updater|check": () => null,
};
