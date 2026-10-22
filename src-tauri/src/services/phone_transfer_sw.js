// Service worker for the phone transfer page (served by phone_transfer.rs as /sw.js). Browsers
// only run it over HTTPS.
//
// Two jobs:
// - When the installed app is opened while Briefcast isn't running (or the PC is asleep), show the
//   page from cache - which says "can't reach your computer" and has a reconnect button - instead
//   of the browser's own "site can't be reached" error. The page is always fetched fresh when the
//   computer answers. Files, uploads and the socket never go through the cache.
// - Android's share sheet ("Share > Briefcast" in Gallery, WhatsApp, Files...) posts the shared
//   files to /share. They're kept on the phone (IndexedDB) and the page is opened to send them, so
//   a share made while the computer is asleep isn't lost - it waits until it's sent.
const CACHE = "briefcast-transfer-v5";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/logo-96.png"];

// The same tiny store the page reads (phone_transfer_page.html, openShares).
const DB = "briefcast-transfer", SHARES = "shares";
const openShares = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(SHARES, { keyPath: "id", autoIncrement: true });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// Every file in the share, whatever field it came under. Apps often hand files over without a
// display name - those still count, and get one the computer can save them under.
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
  // What actually arrived, so a share that brings nothing usable can say so rather than guess.
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
  // Network first, so a newer Briefcast's page is picked up the moment it's reachable.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(shell, copy));
        }
        return res;
      })
      .catch(() => caches.match(shell).then((hit) => hit || Response.error())),
  );
});
