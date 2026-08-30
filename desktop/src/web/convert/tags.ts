/**
 * Tag helpers shared by the browser build's event conversions.
 *
 * Ports the private helpers at the top of `src-tauri/src/nostr_convert.rs` so
 * the browser parses relay events by exactly the same rules as the desktop
 * backend does.
 */

import type { SignedEvent } from "@/web/sign";

/** Every tag with the given name, as full slices. */
export function tagsNamed(event: SignedEvent, name: string): string[][] {
  return event.tags.filter((tag) => tag.length > 0 && tag[0] === name);
}

/** The value of the first tag with the given name, or `null`. */
export function firstTagValue(event: SignedEvent, name: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === name && tag.length >= 2) {
      return tag[1];
    }
  }
  return null;
}

/** Whether a tag with the given name is present at all. */
export function hasTag(event: SignedEvent, name: string): boolean {
  return event.tags.some((tag) => tag[0] === name);
}

/** Every second value of the tags with the given name. */
export function tagValues(event: SignedEvent, name: string): string[] {
  return tagsNamed(event, name)
    .map((tag) => tag[1])
    .filter((value): value is string => typeof value === "string");
}

/** The `d` tag that identifies an addressable event's subject. */
export function dTag(event: SignedEvent): string | null {
  return firstTagValue(event, "d");
}

/** Render a Unix second as the ISO-8601 string the frontend types expect. */
export function timestampToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Keep the newest event per `d` tag, as a replaceable-event set collapses. */
export function newestByDTag(events: SignedEvent[]): Map<string, SignedEvent> {
  const newest = new Map<string, SignedEvent>();
  for (const event of events) {
    const key = dTag(event);
    if (key === null) {
      continue;
    }
    const existing = newest.get(key);
    if (!existing || event.created_at > existing.created_at) {
      newest.set(key, event);
    }
  }
  return newest;
}

/** Keep the newest event per author, as a replaceable-event set collapses. */
export function newestByAuthor(
  events: SignedEvent[],
): Map<string, SignedEvent> {
  const newest = new Map<string, SignedEvent>();
  for (const event of events) {
    const key = event.pubkey.toLowerCase();
    const existing = newest.get(key);
    if (!existing || event.created_at > existing.created_at) {
      newest.set(key, event);
    }
  }
  return newest;
}
