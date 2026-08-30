/**
 * The relay's own advertised signing key, read from its NIP-11 document.
 *
 * Every relay-signed record the app trusts — channel membership above all — is
 * checked against this key, so it is resolved once and cached per relay scope.
 * A cache miss is cheap; a wrong answer would silently widen what counts as
 * relay-signed, so a failed fetch caches nothing.
 */

import { relayScope } from "@/web/state";

/** NIP-11 relay information document, restricted to the fields Buzz reads. */
type RelayInformationDocument = {
  self?: unknown;
  supported_nips?: unknown;
  name?: unknown;
};

const documents = new Map<string, Promise<RelayInformationDocument | null>>();

async function fetchDocument(
  httpUrl: string,
): Promise<RelayInformationDocument | null> {
  const response = await fetch(`${httpUrl}/info`, {
    headers: { Accept: "application/nostr+json" },
  });
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as RelayInformationDocument;
}

/** The NIP-11 document for a relay, cached per HTTP origin. */
export function relayInformation(
  httpUrl?: string,
): Promise<RelayInformationDocument | null> {
  const url = httpUrl ?? relayScope()?.httpUrl;
  if (!url) {
    return Promise.resolve(null);
  }
  const cached = documents.get(url);
  if (cached) {
    return cached;
  }
  const pending = fetchDocument(url).catch((error: unknown) => {
    // Do not cache a failure: the relay may simply have been unreachable, and
    // caching `null` would leave membership permanently untrusted.
    documents.delete(url);
    throw error;
  });
  documents.set(url, pending);
  return pending;
}

/** The relay's `self` pubkey (lowercase hex), or `null` if it advertises none. */
export async function relaySelfPubkey(): Promise<string | null> {
  const document = await relayInformation();
  const self = document?.self;
  return typeof self === "string" ? self.toLowerCase() : null;
}

/** Whether the relay declares NIP-43 support, i.e. requires membership. */
export async function relayRequiresMembership(
  httpUrl?: string,
): Promise<boolean> {
  const document = await relayInformation(httpUrl);
  const nips = document?.supported_nips;
  return Array.isArray(nips) && nips.includes(43);
}

/** Drop every cached NIP-11 document, e.g. on a community switch. */
export function resetRelayInformationCache(): void {
  documents.clear();
}
