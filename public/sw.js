const SHELL = "htn-shell-v1";
const ASSETS = "htn-assets-v1";
const PRECACHE = [
  "/",
  "/login",
  "/logo-htn.png",
  "/logo-mark.png",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon.png",
  "/favicon.svg",
  "/favicon-32.png",
];

function isViteDev(url) {
  return (
    url.pathname.startsWith("/@") ||
    url.pathname.includes("node_modules") ||
    url.pathname.endsWith(".ts") ||
    url.pathname.endsWith(".tsx") ||
    url.search.includes("t=") ||
    url.pathname.startsWith("/src/")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(PRECACHE).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/_server")) return;
  if (isViteDev(url)) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/") || caches.match(req)),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && (url.pathname.startsWith("/assets") || PRECACHE.includes(url.pathname))) {
          const copy = res.clone();
          caches.open(ASSETS).then((c) => c.put(req, copy));
        }
        return res;
      });
    }),
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "HiTechNour", body: "", url: "/" };
  try {
    data = { ...data, ...(event.data ? event.data.json() : {}) };
  } catch {
    /* ignore */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/favicon-32.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
