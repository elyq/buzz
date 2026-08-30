/**
 * Entry point for the browser build's backend.
 *
 * `main.tsx` calls `installWebBridge()` before the first render, exactly where
 * the Tauri build would already have a Rust backend attached. Everything the
 * app reaches through `invoke` is answered from this module's registry.
 */

import { installIpc, register } from "@/web/ipc";
import { eventCommands, installEventInternals } from "@/web/events";
import { identityCommands, initializeIdentity } from "@/web/commands/identity";
import { transportCommands } from "@/web/commands/transport";
import { relayCommands } from "@/web/commands/relay";
import { channelCommands } from "@/web/commands/channels";
import { messageCommands } from "@/web/commands/messages";
import { agentCommands } from "@/web/commands/agents";
import { profileCommands } from "@/web/commands/profiles";
import { discoveryCommands } from "@/web/commands/discovery";
import { mediaCommands } from "@/web/commands/media";
import { localStateCommands } from "@/web/commands/localState";
import { unsupportedCommands } from "@/web/commands/unsupported";
import { windowCommands } from "@/web/commands/window";

let installed = false;

/** Whether this bundle was built for the browser rather than for Tauri. */
export function isWebBuild(): boolean {
  return import.meta.env.MODE === "web";
}

/** Install the browser backend. Safe to call more than once. */
export function installWebBridge(): void {
  if (installed) {
    return;
  }
  installed = true;

  // `unsupportedCommands` is registered first so any command it stubs can be
  // superseded by a real implementation simply by registering that one later.
  register(unsupportedCommands);
  register(windowCommands);
  register(eventCommands);
  register(transportCommands);
  register(identityCommands);
  register(relayCommands);
  register(channelCommands);
  register(messageCommands);
  register(agentCommands);
  register(profileCommands);
  register(discoveryCommands);
  register(mediaCommands);
  register(localStateCommands);

  installIpc();
  installEventInternals();
  initializeIdentity();
}
