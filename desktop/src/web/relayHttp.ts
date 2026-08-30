/**
 * NIP-98 authenticated HTTP against the community relay.
 *
 * Replaces `crate::relay::{get, submit}` from the Tauri backend. The relay
 * verifies the signed `u` tag against `{scheme}://{tenant host}{path}`, where
 * the scheme follows the relay's own TLS posture — so the URL is always built
 * from the active relay scope rather than from `window.location`.
 */

import { buildNip98AuthHeader, type SignedEvent } from "@/web/sign";
import { requireRelayScope } from "@/web/state";

/** Response body of `POST /events`. */
export type SubmitEventResponse = {
  event_id: string;
  accepted: boolean;
  message: string;
};

/** A Nostr filter as the relay's HTTP bridge accepts it. */
export type RelayFilter = Record<string, unknown>;

function relayUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("relay path must begin with '/'");
  }
  return `${requireRelayScope().httpUrl}${path}`;
}

async function relayErrorMessage(response: Response): Promise<string> {
  const status = `relay returned ${response.status} ${response.statusText}`;
  try {
    const text = await response.text();
    if (!text) {
      return status;
    }
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const detail = parsed.error ?? parsed.message;
      return typeof detail === "string" && detail ? detail : status;
    } catch {
      return `${status}: ${text.slice(0, 200)}`;
    }
  } catch {
    return status;
  }
}

async function send<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = relayUrl(path);
  const payload = body === undefined ? "" : JSON.stringify(body);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: buildNip98AuthHeader(method, url, payload),
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json" as const }),
      },
      body: body === undefined ? undefined : payload,
    });
  } catch (error) {
    // Prefixed so the frontend connectivity classifier treats this the same way
    // it treats the Rust backend's `classify_request_error` output.
    const detail = error instanceof Error ? error.message : "request failed";
    throw new Error(`relay unreachable: ${detail}`);
  }
  if (!response.ok) {
    throw new Error(await relayErrorMessage(response));
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** `POST /query` — run Nostr REQ filters over HTTP and return the events. */
export async function queryRelay(
  filters: RelayFilter[],
): Promise<SignedEvent[]> {
  const events = await send<SignedEvent[] | null>("POST", "/query", filters);
  return events ?? [];
}

/** `POST /query` with a single filter. */
export function queryRelayOne(filter: RelayFilter): Promise<SignedEvent[]> {
  return queryRelay([filter]);
}

/** `POST /count` — run Nostr COUNT filters over HTTP. */
export async function countRelay(filters: RelayFilter[]): Promise<number> {
  const result = await send<{ count?: number } | null>(
    "POST",
    "/count",
    filters,
  );
  return result?.count ?? 0;
}

/** `POST /events` — submit an already-signed event. */
export async function submitEvent(
  event: SignedEvent,
): Promise<SubmitEventResponse> {
  const result = await send<SubmitEventResponse>("POST", "/events", event);
  if (!result.accepted) {
    throw new Error(`relay rejected event: ${result.message}`);
  }
  return result;
}

/** Authenticated `GET` returning a decoded JSON body. */
export function getRelayJson<T>(pathWithQuery: string): Promise<T> {
  return send<T>("GET", pathWithQuery);
}

/**
 * Page through a filter until the relay returns a short page.
 *
 * Mirrors `query_all_relay_pages`: the cursor walks `until` backwards from the
 * oldest event of the previous page so a directory larger than one page is
 * still read in full.
 */
export async function queryAllRelayPages(
  filter: RelayFilter,
  pageSize: number,
): Promise<SignedEvent[]> {
  const events: SignedEvent[] = [];
  let cursor: RelayFilter = { ...filter, limit: pageSize };
  for (;;) {
    const page = await queryRelay([cursor]);
    events.push(...page);
    if (page.length < pageSize) {
      return events;
    }
    const oldest = page.reduce(
      (min, event) => Math.min(min, event.created_at),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(oldest)) {
      return events;
    }
    cursor = { ...cursor, until: oldest };
  }
}
