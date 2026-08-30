/**
 * Sign-and-submit for the browser build's write path.
 *
 * The Tauri backend signs with its keyring and POSTs to `/events` in one step
 * (`submit_event`). This is the same two-step operation against the in-page key.
 */

import type { EventTemplate } from "@/web/convert/eventBuilders";
import { submitEvent, type SubmitEventResponse } from "@/web/relayHttp";
import { signEvent, type SignedEvent } from "@/web/sign";

/** The submitted event alongside the relay's acceptance record. */
export type PublishResult = {
  event: SignedEvent;
  response: SubmitEventResponse;
};

/** Sign `template` with the active identity and submit it to the relay. */
export async function publish(template: EventTemplate): Promise<PublishResult> {
  const event = signEvent(template);
  const response = await submitEvent(event);
  return { event, response };
}

/** Publish and return only the event id, for callers that need nothing else. */
export async function publishForId(template: EventTemplate): Promise<string> {
  return (await publish(template)).event.id;
}
