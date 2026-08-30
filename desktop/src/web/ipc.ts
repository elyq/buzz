/**
 * The browser IPC seam.
 *
 * Installs a `window.__TAURI_INTERNALS__` that satisfies `@tauri-apps/api`
 * without a Tauri backend: `invoke` dispatches into the command registry, and
 * `transformCallback` backs the `Channel` type the relay socket streams over.
 *
 * This is the production sibling of `src/testing/e2eBridge.ts`. That module
 * answers commands from fixtures; this one answers them from the live relay.
 */

import { windowMetadata } from "@/web/commands/window";

/** Everything a command handler receives — the invoke payload, unmodified. */
export type CommandArgs = Record<string, unknown>;

/**
 * Out-of-band invoke inputs.
 *
 * Tauri's raw IPC form passes a binary body plus headers instead of a JSON
 * payload; `upload_media_bytes_raw` uses it to hand a file to Rust without the
 * JSON number-array expansion. Handlers that do not accept a body ignore this.
 */
export type CommandContext = {
  /** Raw request body, when the caller used the binary invoke form. */
  raw?: Uint8Array;
  /** Headers supplied alongside a raw body. */
  headers?: Record<string, string>;
};

/** A single command implementation. */
export type CommandHandler = (
  args: CommandArgs,
  context: CommandContext,
) => unknown | Promise<unknown>;

/** Registry of command name to implementation. */
export type CommandTable = Record<string, CommandHandler>;

/** The subset of `Channel` a handler needs: a one-way stream of messages. */
export type ChannelHandle = {
  /** Deliver one message to the channel's `onmessage` callback. */
  send: (message: unknown) => void;
};

type RawChannelMessage = { index: number; message?: unknown; end?: true };
type CallbackFn = (payload: RawChannelMessage) => void;

const CHANNEL_PREFIX = "__CHANNEL__:";

/**
 * The method `@tauri-apps/api` puts on anything that serializes to an IPC
 * string. `Channel` implements it; `core.ts` exports the key as
 * `SERIALIZE_TO_IPC_FN`.
 */
const SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";

const table: CommandTable = {};
const callbacks = new Map<number, CallbackFn>();
let nextCallbackId = 1;

/**
 * Commands the app asked for that this bridge does not implement.
 *
 * Exposed on `window.__BUZZ_WEB_UNIMPLEMENTED__` so a browsing session reports
 * exactly which native capability a feature reached for, instead of leaving a
 * silent gap behind a caught error.
 */
const unimplemented = new Set<string>();

/** Add handlers to the registry. Later registrations win, so order matters. */
export function register(commands: CommandTable): void {
  Object.assign(table, commands);
}

/** Whether a command has an implementation in this build. */
export function isRegistered(command: string): boolean {
  return command in table;
}

/** Every command name this bridge answers, sorted. */
export function registeredCommands(): string[] {
  return Object.keys(table).sort();
}

/** Names of every command the app invoked without an implementation. */
export function unimplementedCommands(): string[] {
  return [...unimplemented].sort();
}

/**
 * Thrown for a command with no browser implementation.
 *
 * Named so callers that already tolerate a missing capability (feature probes,
 * best-effort native niceties) can recognise it, while genuine failures still
 * surface as ordinary errors.
 */
export class UnsupportedCommandError extends Error {
  constructor(command: string) {
    super(`This feature is not available in the browser build (${command}).`);
    this.name = "UnsupportedCommandError";
  }
}

/**
 * Invoke a registered callback by the id `transformCallback` handed out.
 *
 * Both consumers go through here: a `Channel` expects the `{index, message}`
 * envelope its own callback unwraps, while an event listener is handed its
 * `{event, id, payload}` record directly.
 */
export function deliverCallback(id: number, payload: unknown): void {
  callbacks.get(id)?.(payload as RawChannelMessage);
}

/**
 * The callback id behind a channel argument, or `null` if this is not one.
 *
 * Two forms arrive here, and only one of them is a string. `invoke()` in
 * `@tauri-apps/api` hands its `args` straight to this bridge without
 * serializing them — under Tauri it is the Rust-injected internals that walks
 * the payload and calls `SERIALIZE_TO_IPC_FN` on anything that has it. So a
 * `Channel` reaches us as a **live object**, not as its `__CHANNEL__:<id>`
 * string, and matching only the string form silently drops every channel
 * argument the app passes.
 */
function channelId(value: unknown): number | null {
  const serialized =
    typeof value === "string"
      ? value
      : typeof (value as Record<string, unknown> | null)?.[
            SERIALIZE_TO_IPC_FN
          ] === "function"
        ? (
            (value as Record<string, () => unknown>)[
              SERIALIZE_TO_IPC_FN
            ] as () => unknown
          ).call(value)
        : null;
  if (
    typeof serialized !== "string" ||
    !serialized.startsWith(CHANNEL_PREFIX)
  ) {
    return null;
  }
  const id = Number.parseInt(serialized.slice(CHANNEL_PREFIX.length), 10);
  return Number.isNaN(id) ? null : id;
}

/** Resolve a channel argument into a usable handle. */
function toChannelHandle(id: number): ChannelHandle {
  let index = 0;
  return {
    send(message: unknown) {
      const callback = callbacks.get(id);
      if (callback) {
        callback({ index: index++, message });
      }
    },
  };
}

/**
 * Replace channel placeholders in an invoke payload with live handles.
 *
 * A `Channel` stands for a sender on the native side. This resolves both forms
 * it can arrive in — see `channelId` — one level deep, which covers every
 * channel argument in the app (`onMessage`, progress callbacks).
 */
function resolveChannels(args: CommandArgs): CommandArgs {
  const resolved: CommandArgs = {};
  for (const [key, value] of Object.entries(args)) {
    const id = channelId(value);
    resolved[key] = id === null ? value : toChannelHandle(id);
  }
  return resolved;
}

async function dispatch(
  command: string,
  args: CommandArgs,
  context: CommandContext,
): Promise<unknown> {
  const handler = table[command];
  if (!handler) {
    unimplemented.add(command);
    throw new UnsupportedCommandError(command);
  }
  return await handler(resolveChannels(args), context);
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return null;
}

type TauriInternals = {
  invoke: (
    command: string,
    args?: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  transformCallback: (callback: CallbackFn, once?: boolean) => number;
  /**
   * Release a callback id. `Channel.cleanupCallback()` calls this — including
   * on its own, the moment a stream reaches its end index — so omitting it is
   * not a missing nicety but a `TypeError` on every channel that finishes.
   */
  unregisterCallback: (id: number) => void;
  /**
   * Window/webview identity `@tauri-apps/api` reads directly, without an
   * `invoke`. `getCurrentWindow()` dereferences `metadata.currentWindow.label`
   * eagerly, so leaving this unset throws before any command is dispatched.
   */
  metadata: {
    currentWindow: { label: string };
    currentWebview: { windowLabel: string; label: string };
  };
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
    __BUZZ_WEB_UNIMPLEMENTED__?: () => string[];
    __BUZZ_WEB_COMMANDS__?: () => string[];
  }
}

let installed = false;

/** Install the bridge. Safe to call more than once. */
export function installIpc(): void {
  if (installed) {
    return;
  }
  installed = true;

  const internals: TauriInternals = {
    invoke(command, args, options) {
      const raw = toBytes(args);
      const payload =
        !raw && args && typeof args === "object" && !Array.isArray(args)
          ? (args as CommandArgs)
          : {};
      const headers = (
        options as { headers?: Record<string, string> } | undefined
      )?.headers;
      return dispatch(command, payload, { raw: raw ?? undefined, headers });
    },
    metadata: windowMetadata,
    transformCallback(callback, once) {
      const id = nextCallbackId++;
      callbacks.set(id, (payload) => {
        if (once) {
          callbacks.delete(id);
        }
        callback(payload);
      });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
  };

  window.__TAURI_INTERNALS__ = internals;
  window.__BUZZ_WEB_UNIMPLEMENTED__ = unimplementedCommands;
  // Lets a deployed bundle be diffed against the Rust command surface without
  // invoking anything — the only safe way to find a gap ahead of a user.
  window.__BUZZ_WEB_COMMANDS__ = registeredCommands;
}
