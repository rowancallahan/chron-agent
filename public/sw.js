// The service worker: runs in the background (even with the page closed) and shows push
// notifications sent by py/src/notify/webpush.py. Part of push notifications (see notify/push.js).

// A new version of this file takes over straight away (a Home Screen app is rarely fully closed).
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(HELP_CACHE).then((cache) => Promise.all(HELP.map((p) => save(cache, p)))).catch(() => {}));
});
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

// The help pages (Settings → "are you on an iPhone?", "need to set this up?"): kept on the phone, so
// they open instantly. Each time one opens, a fresh copy is fetched in the background for next time.
// (Only these small pages -- the app itself always comes fresh from the server.)
const HELP = ["/iphone", "/phone", "/texting", "/calendar"], HELP_CACHE = "help-pages-v1";

async function save(cache, path) {  // keep a copy, only of a real page (not a sign-in redirect)
  const res = await fetch(path);
  if (res.ok && !res.redirected && res.type === "basic") await cache.put(path, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || !HELP.includes(url.pathname)) return;
  event.respondWith(caches.open(HELP_CACHE).then(async (cache) => {
    const kept = await cache.match(url.pathname);
    const fresh = save(cache, url.pathname);
    if (kept) { event.waitUntil(fresh.catch(() => {})); return kept; }
    return fresh;
  }));
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  event.waitUntil(self.registration.showNotification("⏰ " + (data.title || "Reminder"), {
    body: data.body || "",
    tag: data.title || "reminder",  // a newer alert with the same title replaces the older one...
    renotify: true,                 // ...and still buzzes, e.g. a daily reminder still on screen from yesterday
  }));
});

// Tapping the notification opens the app (or brings it to the front) -- the app itself, not a help page.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const app = windows.find((w) => new URL(w.url).pathname === "/");
    return app ? app.focus() : clients.openWindow("/");
  }));
});
