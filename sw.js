/* OpenAIR workbench snapshot Service Worker.
 * Replays recorded /api/ responses from snapshot.js; everything else passes
 * through to static hosting. Read-only by design: misses return 404 JSON,
 * non-GET returns 405. */
self.__SNAPSHOT_VERSION = "v6";
importScripts("./snapshot.js");

const SNAP = self.__SNAPSHOT;

function safeEncode(p) {
  // Segment-wise encoding: snapshot keys have encoded artifact ids (%3A) but
  // literal slashes — encodeURIComponent on the whole path would escape "/".
  try {
    return p
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
  } catch {
    return null;
  }
}
function safeDecode(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function replay(hit) {
  const bin = atob(hit.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    status: hit.status,
    headers: { "Content-Type": hit.ct, "Cache-Control": "no-store" },
  });
}

function jsonBody(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (path.startsWith("/health")) {
    event.respondWith(jsonBody(200, { status: "ok", snapshot: true }));
    return;
  }
  const i = path.indexOf("/api/");
  if (i === -1) return; // static assets: pass through to hosting

  const key = path.slice(i); // strip hosting sub-path prefix; query already dropped
  // Request paths arrive in mixed encodings: fetch() uses encodeURIComponent
  // (colons as %3A) while <img src> from withArtifactAuth keeps raw colons.
  // Normalize by trying raw / encoded / decoded forms against the snapshot.
  let hit = null;
  for (const cand of [key, safeEncode(key), safeDecode(key)]) {
    if (cand && SNAP[cand]) {
      hit = SNAP[cand];
      break;
    }
  }
  if (!hit && /^\/api\/tasks\/[^/]+$/.test(key)) {
    // Short-id task fetch: replay the full-id task body of the same task
    // (the recording followed the redirect, so keys carry the full id).
    const m = Object.keys(SNAP).filter(
      (k) => /^\/api\/tasks\/[^/]+$/.test(k) && k.startsWith(key),
    );
    if (m.length >= 1) hit = SNAP[m[0]];
  }
  if (hit) {
    event.respondWith(replay(hit));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    event.respondWith(jsonBody(405, { detail: "snapshot is read-only" }));
    return;
  }
  event.respondWith(jsonBody(404, { detail: "snapshot miss", path: key }));
});
