// Service worker Vitalis — réseau d'abord (l'app reste à jour), cache en secours (hors-ligne).
const CACHE = "vitalis-v3";
const ASSETS = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Notifications push (envoyées par le Worker Cloudflare chaque matin)
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data.json(); } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Vitalis", {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: (d && d.url) || "./" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return clients.openWindow(e.notification.data && e.notification.data.url || "./");
  }));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // ne jamais intercepter la sync Cloudflare ni les appels API (origines externes)
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true })
          .then(m => m || (e.request.mode === "navigate" ? caches.match("./index.html") : Response.error()))
      )
  );
});
