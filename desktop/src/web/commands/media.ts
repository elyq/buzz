/**
 * Blossom media upload and download commands.
 *
 * Ports `commands/media.rs`. Uploads are BUD-01 `PUT /upload` with a kind:24242
 * authorization event; downloads carry a server-scoped `t=get` token.
 *
 * Two things differ from the desktop build, both because a browser has no
 * filesystem and no native HTTP client:
 *
 * - `upload_media` (a path on disk) has no browser meaning; the raw byte form
 *   the composer actually uses is implemented instead.
 * - There is no local media proxy. The relay is reached directly, which is why
 *   the `t=get` token must never be attached to a non-relay origin.
 */

import type { CommandArgs, CommandContext, CommandTable } from "@/web/ipc";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { signEvent } from "@/web/sign";
import { requireRelayScope } from "@/web/state";
import { emitAppEvent } from "@/web/events";

/** kind:24242 — Blossom authorization. */
const KIND_BLOSSOM_AUTH = 24242;
/** How long a read token stays valid, matching `MEDIA_GET_AUTH_EXPIRY_SECS`. */
const GET_AUTH_EXPIRY_SECS = 600;
const UPLOAD_AUTH_EXPIRY_SECS = 600;

/** Wire shape of an uploaded blob, matching `BlobDescriptor`. */
type BlobDescriptor = {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
  dim?: string;
  blurhash?: string;
  thumb?: string;
  duration?: number;
  image?: string;
  filename?: string;
};

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function serverAuthority(baseUrl: string): string {
  return new URL(baseUrl).host;
}

function blossomAuthHeader(tags: string[][], content: string): string {
  return `Nostr ${base64Utf8(
    JSON.stringify(signEvent({ kind: KIND_BLOSSOM_AUTH, content, tags })),
  )}`;
}

/**
 * A server-scoped `t=get` token for relay media reads.
 *
 * Scoping to the server rather than to one blob keeps avatar grids and video
 * range requests cheap. It is safe only because the relay still enforces
 * membership on the verified pubkey — and only as long as callers attach it
 * exclusively to the relay's own origin, where it cannot leak as a bearer token.
 */
export function mediaGetAuthHeader(): string {
  const now = Math.floor(Date.now() / 1000);
  return blossomAuthHeader(
    [
      ["t", "get"],
      ["expiration", String(now + GET_AUTH_EXPIRY_SECS)],
      ["server", serverAuthority(requireRelayScope().httpUrl)],
    ],
    "Get buzz-media",
  );
}

/** Whether `url` points at the active relay, i.e. may carry the read token. */
export function isRelayMediaUrl(url: string): boolean {
  try {
    return new URL(url).origin === new URL(requireRelayScope().httpUrl).origin;
  } catch {
    return false;
  }
}

/** Fetch relay media, authenticating only when the URL is the relay's own. */
export async function fetchMediaBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    headers: isRelayMediaUrl(url)
      ? { Authorization: mediaGetAuthHeader() }
      : {},
  });
  if (!response.ok) {
    throw new Error(
      `relay returned ${response.status} ${response.statusText} for media`,
    );
  }
  return response.arrayBuffer();
}

function decodeRawIpcHeader(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

/**
 * Report upload progress the way the Rust backend does.
 *
 * `fetch` exposes no upload progress, so the composer's progress bar would
 * otherwise sit at zero until the request settles. Reporting the two real
 * transitions it can observe — dispatched, then complete — keeps the bar
 * honest instead of animating a number nothing measured.
 */
function reportProgress(
  progressId: string | null,
  sent: number,
  total: number,
): void {
  if (progressId) {
    emitAppEvent("media-upload-progress", { id: progressId, sent, total });
  }
}

async function uploadBytes(
  bytes: Uint8Array,
  mimeType: string,
  filename: string | null,
  progressId: string | null = null,
): Promise<BlobDescriptor> {
  const { httpUrl } = requireRelayScope();
  const digest = bytesToHex(sha256(bytes));
  const now = Math.floor(Date.now() / 1000);
  const auth = blossomAuthHeader(
    [
      ["t", "upload"],
      ["x", digest],
      ["expiration", String(now + UPLOAD_AUTH_EXPIRY_SECS)],
      ["server", serverAuthority(httpUrl)],
    ],
    "Upload buzz-media",
  );

  const attempt = (path: string) =>
    fetch(`${httpUrl}${path}`, {
      method: "PUT",
      headers: {
        Authorization: auth,
        "Content-Type": mimeType,
        "X-SHA-256": digest,
      },
      body: bytes as BodyInit,
    });

  reportProgress(progressId, 0, bytes.byteLength);
  let response = await attempt("/upload");
  // Older relays only expose the legacy path; retry there on the two statuses
  // that mean "this route does not exist here".
  if (response.status === 404 || response.status === 405) {
    response = await attempt("/media/upload");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail || `relay returned ${response.status} ${response.statusText}`,
    );
  }
  reportProgress(progressId, bytes.byteLength, bytes.byteLength);
  const descriptor = (await response.json()) as BlobDescriptor;
  // The relay is content-addressed and never learns the filename, so the
  // client-side one is carried through for file-card labels.
  return filename ? { ...descriptor, filename } : descriptor;
}

export const mediaCommands: CommandTable = {
  upload_media_bytes_raw: (_args: CommandArgs, context: CommandContext) => {
    if (!context.raw) {
      throw new Error("upload requires a request body");
    }
    const filenameHeader = context.headers?.["x-buzz-filename"];
    const progressHeader = context.headers?.["x-buzz-progress-id"];
    return uploadBytes(
      context.raw,
      "application/octet-stream",
      filenameHeader ? decodeRawIpcHeader(filenameHeader) : null,
      progressHeader ? decodeRawIpcHeader(progressHeader) : null,
    );
  },

  upload_media_bytes: (args: CommandArgs) => {
    const bytes = args.bytes;
    const buffer =
      bytes instanceof Uint8Array
        ? bytes
        : Array.isArray(bytes)
          ? Uint8Array.from(bytes as number[])
          : null;
    if (!buffer) {
      throw new Error("upload requires bytes");
    }
    return uploadBytes(
      buffer,
      typeof args.mimeType === "string"
        ? args.mimeType
        : "application/octet-stream",
      typeof args.filename === "string" ? args.filename : null,
      typeof args.progressId === "string" ? args.progressId : null,
    );
  },

  fetch_media_bytes: (args: CommandArgs) =>
    fetchMediaBytes(String(args.url ?? "")),

  fetch_snapshot_bytes: async (args: CommandArgs) => {
    const bytes = new Uint8Array(await fetchMediaBytes(String(args.url ?? "")));
    const expectedSha = String(args.expectedSha256 ?? "");
    const expectedSize = Number(args.expectedSize ?? 0);
    // Integrity is checked here because, unlike the desktop build, nothing
    // between the relay and the renderer has already validated these bytes.
    if (expectedSize && bytes.byteLength !== expectedSize) {
      throw new Error("snapshot size does not match the message metadata");
    }
    if (expectedSha && bytesToHex(sha256(bytes)) !== expectedSha) {
      throw new Error("snapshot hash does not match the message metadata");
    }
    return [...bytes];
  },

  // Downloads are handled by the browser itself; there is no native save
  // dialog to drive and no local path to hand back.
  download_image: async (args: CommandArgs) => {
    const url = String(args.url ?? "");
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = String(args.filename ?? "");
    anchor.rel = "noopener";
    anchor.click();
    return null;
  },

  // No local media proxy exists in the browser: media is fetched from the
  // relay directly, and `mediaUrl` treats port 0 as "use the URL as given".
  get_media_proxy_port: () => 0,

  copy_text_to_clipboard: async (args: CommandArgs) => {
    await navigator.clipboard.writeText(String(args.text ?? ""));
    return null;
  },

  read_clipboard_text: () => navigator.clipboard.readText(),

  // Cancellation would need an AbortController threaded through the upload;
  // the renderer already treats these as best-effort.
  cancel_media_upload: () => null,
  release_media_upload: () => null,

  copy_image_to_clipboard: async (args: CommandArgs) => {
    const bytes = new Uint8Array(await fetchMediaBytes(String(args.url ?? "")));
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([bytes], { type: "image/png" }),
      }),
    ]);
    return null;
  },
};
