/**
 * Browser implementation of the `plugin:websocket|*` command family.
 *
 * The Tauri build runs the relay socket in Rust and streams frames back over an
 * IPC `Channel`. In the browser the socket is a plain `WebSocket` and the same
 * `Channel` callback is invoked directly, so `relayClientSession` — which owns
 * all subscription, auth and reconnect logic in TypeScript — runs unchanged.
 *
 * Frames are delivered in the `{ type: "Text", data }` envelope that
 * `getTextPayload` already understands, and batched per animation-frame tick
 * the way the native transport batches, so a burst of relay events becomes one
 * channel delivery rather than one per frame.
 */

import type { ChannelHandle } from "@/web/ipc";

/**
 * Frame envelopes matching the native transport's serialization.
 *
 * `Close` and `Error` are ordinary channel messages, not out-of-band signals —
 * `relayReconnectPolicy` classifies them with `isWebSocketClose` /
 * `isWebSocketError` to decide whether to reconnect, so they must arrive in the
 * same stream and the same order as the text frames that preceded them.
 */
type RelayFrame =
  | { type: "Text"; data: string }
  | { type: "Close"; data: { code: number; reason: string } }
  | { type: "Error"; data: string };

type Connection = {
  socket: WebSocket;
  channel: ChannelHandle;
  pending: RelayFrame[];
  flushHandle: number | null;
  closed: boolean;
};

const connections = new Map<number, Connection>();
let nextConnectionId = 1;

/** How long frames accumulate before one batched channel delivery. */
const BATCH_WINDOW_MS = 4;

function flush(connection: Connection): void {
  connection.flushHandle = null;
  if (connection.pending.length === 0) {
    return;
  }
  const batch = connection.pending;
  connection.pending = [];
  // `toRelayFrames` unwraps arrays, so a batch and a lone frame are both valid.
  connection.channel.send(batch.length === 1 ? batch[0] : batch);
}

function enqueue(connection: Connection, frame: RelayFrame): void {
  connection.pending.push(frame);
  if (connection.flushHandle === null) {
    connection.flushHandle = window.setTimeout(
      () => flush(connection),
      BATCH_WINDOW_MS,
    );
  }
}

function teardown(connection: Connection): void {
  if (connection.flushHandle !== null) {
    window.clearTimeout(connection.flushHandle);
    connection.flushHandle = null;
  }
  connection.closed = true;
}

/**
 * Open a relay socket and stream its text frames into `channel`.
 *
 * Resolves once the socket is open so the caller can send immediately, and
 * rejects when the socket fails before opening — matching the native command,
 * which only returns an id after a successful handshake.
 */
export function connect(url: string, channel: ChannelHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      reject(
        new Error(
          `relay unreachable: ${
            error instanceof Error ? error.message : "could not open socket"
          }`,
        ),
      );
      return;
    }

    const id = nextConnectionId++;
    const connection: Connection = {
      socket,
      channel,
      pending: [],
      flushHandle: null,
      closed: false,
    };
    let opened = false;

    socket.addEventListener("open", () => {
      opened = true;
      connections.set(id, connection);
      resolve(id);
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        enqueue(connection, { type: "Text", data: event.data });
      }
    });

    socket.addEventListener("close", (event) => {
      connections.delete(id);
      if (!opened) {
        reject(new Error("relay unreachable: connection closed before open"));
        teardown(connection);
        return;
      }
      // Queued behind whatever arrived first, so a relay NOTICE explaining the
      // disconnect is still delivered before the close that follows it.
      enqueue(connection, {
        type: "Close",
        data: { code: event.code, reason: event.reason },
      });
      flush(connection);
      teardown(connection);
    });

    socket.addEventListener("error", () => {
      // The browser deliberately withholds detail here, and a failed handshake
      // is already reported by the paired `close` event.
      if (opened) {
        enqueue(connection, {
          type: "Error",
          data: "Relay connection errored.",
        });
      }
    });
  });
}

/** Send one text frame on an open connection. */
export async function send(
  id: number,
  message: { type?: string; data?: string } | string,
): Promise<void> {
  const connection = connections.get(id);
  if (!connection) {
    throw new Error(`WebSocket connection ${id} not found`);
  }
  if (connection.socket.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket connection closed");
  }
  const payload = typeof message === "string" ? message : (message.data ?? "");
  connection.socket.send(payload);
}

/** Close one connection. Idempotent, like the native command. */
export async function disconnect(id: number): Promise<void> {
  const connection = connections.get(id);
  if (!connection) {
    return;
  }
  connections.delete(id);
  teardown(connection);
  try {
    connection.socket.close();
  } catch {
    // Already closing or closed.
  }
}

/** Close every open connection. */
export async function disconnectAll(): Promise<void> {
  await Promise.all([...connections.keys()].map((id) => disconnect(id)));
}
