/**
 * Relay socket commands.
 *
 * Maps the `plugin:websocket|*` family onto the browser `WebSocket` so
 * `relayClientSession` and `readOnlyRelayClient` run unchanged.
 */

import type { ChannelHandle, CommandArgs, CommandTable } from "@/web/ipc";
import { connect, disconnect, disconnectAll, send } from "@/web/websocket";

export const transportCommands: CommandTable = {
  "plugin:websocket|connect": (args: CommandArgs) => {
    const url = args.url;
    if (typeof url !== "string" || !url) {
      throw new Error("A relay URL is required to connect.");
    }
    const channel = args.onMessage as ChannelHandle | undefined;
    if (!channel || typeof channel.send !== "function") {
      throw new Error("A message channel is required to connect.");
    }
    return connect(url, channel);
  },

  "plugin:websocket|send": (args: CommandArgs) =>
    send(
      Number(args.id),
      args.message as { type?: string; data?: string } | string,
    ),

  "plugin:websocket|disconnect": (args: CommandArgs) =>
    disconnect(Number(args.id)),

  "plugin:websocket|disconnect_all": () => disconnectAll(),
};
