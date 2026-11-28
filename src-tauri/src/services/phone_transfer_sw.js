// Service worker for Briefcast Transfer Pro (served by both transfer.briefcast.app and
// phone_transfer.rs as /sw.js). Browsers only run it over HTTPS.
//
// Two jobs:
// - Instant offline-first launch: serves the app shell with a tight 600ms network timeout so
//   tapping the home-screen icon opens immediately (<100ms when offline or Briefcast Desktop is
//   closed) instead of waiting on a TCP timeout, while still refreshing the cache in the background
//   whenever the server is reachable.
// - Android's share sheet ("Share > Briefcast" in Gallery, WhatsApp, Files...) posts shared files
//   to /share. They're persisted in IndexedDB so shares made while the PC is off wait safely until
//   sent (either to your PC or directly Phone-to-Phone).
const CACHE = "briefcast-transfer-v7";
const SHELL = [
  "/",
  "/studio.js",
  "/p2p.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/logo-96.png",
];

const DB = "briefcast-transfer", SHARES = "shares";
const openShares = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(SHARES, { keyPath: "id", autoIncrement: true });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function sharedFiles(form) {
  const files = [];
  for (const [, value] of form.entries()) {
    if (typeof value === "string") continue;
    const type = value.type || "application/octet-stream";
    const ext = (type.split("/")[1] || "bin").split(/[;+]/)[0].replace("jpeg", "jpg").replace("quicktime", "mov");
    files.push(value.name ? value : new File([value], `shared-${Date.now()}-${files.length + 1}.${ext}`, { type }));
  }
  return files;
}

async function keepShare(request) {
  const form = await request.formData();
  const files = sharedFiles(form);
  const text = ["title", "text", "url"].map((k) => form.get(k)).filter((v) => typeof v === "string" && v.trim()).join("\n");
  const fields = [...form.entries()].map(([k, v]) => (typeof v === "string" ? `${k} (text)` : `${k} (${v.type || "file"}, ${v.size} B)`));
  const db = await openShares();
  const id = await new Promise((resolve, reject) => {
    const tx = db.transaction(SHARES, "readwrite");
    const req = tx.objectStore(SHARES).add({ at: Date.now(), files, text, fields });
    req.onsuccess = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return id;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function fastNetworkThenCache(req, shell) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(shell);

  const networkPromise = fetch(req)
    .then((res) => {
      if (res && res.ok) {
        cache.put(shell, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  // If we already have a cached copy, don't hang more than 600ms waiting for an unreachable PC or
  // slow cell connection — serve the cached shell immediately while network updates in background.
  if (cached) {
    const fast = await Promise.race([
      networkPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 600)),
    ]);
    return fast || cached;
  }

  return (await networkPromise) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.method === "POST" && url.pathname === "/share") {
    event.respondWith(
      keepShare(req)
        .then((id) => Response.redirect(`/?share=${id}`, 303))
        .catch(() => Response.redirect("/?share=failed", 303)),
    );
    return;
  }
  if (req.method !== "GET") return;
  const shell = req.mode === "navigate" ? "/" : SHELL.includes(url.pathname) ? url.pathname : null;
  if (!shell) return;
  event.respondWith(fastNetworkThenCache(req, shell));
});
