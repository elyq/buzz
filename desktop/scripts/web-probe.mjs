/**
 * Boot the browser build headlessly and report what it asked the bridge for.
 *
 * Serves `dist-web` under its deployed base path, loads the app, and prints the
 * commands that reached the bridge without an implementation plus any console
 * errors. This is the fastest way to find the gap between the command surface
 * the app uses and the surface the bridge answers.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.BUZZ_WEB_BASE ?? "/desktop/";
const DIST = path.resolve("dist-web");
const PORT = Number(process.env.PROBE_PORT ?? 4187);
const RELAY =
  process.env.BUZZ_PROBE_RELAY ?? "wss://orpheus.wyrm-insen.ts.net:2126";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let rel = url.pathname.startsWith(BASE)
    ? url.pathname.slice(BASE.length)
    : url.pathname.replace(/^\//, "");
  if (rel === "" || !path.extname(rel)) rel = "index.html";
  try {
    const body = await readFile(path.join(DIST, rel));
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(rel)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((resolve) => server.listen(PORT, resolve));

// `--disable-web-security` is what lets the probe talk to the relay from a
// throwaway localhost origin. The deployed app is served from the relay's own
// origin and needs no such flag; using it here avoids mutating the relay's
// CORS allowlist just to run a test.
const browser = await chromium.launch({
  executablePath: process.env.PROBE_CHROME || undefined,
  args: ["--disable-web-security", "--ignore-certificate-errors"],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${error.message}`),
);

await page.addInitScript((relayUrl) => {
  window.__BUZZ_WEB_CONFIG__ = { relayUrl, communityName: "Probe" };
}, RELAY);

await page.goto(`http://localhost:${PORT}${BASE}`, { waitUntil: "load" });
await page.waitForTimeout(3000);

// Walk the first-run gate so the probe reaches the actual app shell: the
// screens behind it are where the relay-backed commands live.
for (const label of (process.env.PROBE_CLICKS ?? "")
  .split("|")
  .filter(Boolean)) {
  const target = page.getByText(label, { exact: false }).first();
  if (await target.count()) {
    await target.click().catch(() => {});
    await page.waitForTimeout(2500);
  }
}
await page.waitForTimeout(Number(process.env.PROBE_WAIT ?? 15000));

const missing = await page.evaluate(() =>
  window.__BUZZ_WEB_UNIMPLEMENTED__
    ? window.__BUZZ_WEB_UNIMPLEMENTED__()
    : null,
);
const rendered = await page.evaluate(() => ({
  rootChildren: document.getElementById("root")?.childElementCount ?? 0,
  text: (document.body.innerText ?? "").slice(0, 600),
}));

console.log("=== unimplemented commands ===");
console.log(
  missing === null ? "(bridge not installed)" : missing.join("\n") || "(none)",
);
console.log("\n=== root children ===", rendered.rootChildren);
console.log(`\n=== visible text ===\n${rendered.text}`);
console.log(`\n=== console errors (${consoleErrors.length}) ===`);
for (const error of [...new Set(consoleErrors)].slice(0, 30))
  console.log("-", error);

await page.screenshot({
  path: process.env.PROBE_SHOT ?? "/tmp/web-probe.png",
  fullPage: false,
});
await browser.close();
server.close();
