/* ScentPhone serviceworker 0.5.1 (Geurherkenning 1.0 + Echte sensor / Sensorkit 1.0)
 * - App-bestanden: uit de cache (offline), pagina zelf: eerst netwerk zodat updates binnenkomen.
 * - Externe gratis bibliotheken (Google Fonts, jsDelivr: ZXing, Tesseract): na het eerste gebruik bewaard voor offline gebruik.
 * - Parfumgegevens, sensormetingen en ruwe sensorreeksen staan in IndexedDB en worden door deze serviceworker nooit aangeraakt.
 * - Bij een update worden alleen oude app-caches (scentphone-…) opgeruimd, nooit gebruikersgegevens.
 */
const VERSION = "scentphone-0.5.1";
const SHELL_CACHE = VERSION + "-shell";
const RUNTIME_CACHE = VERSION + "-runtime";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./js/scentphone-sensor.js",
  "./icons/apple-touch-icon-120.png",
  "./icons/apple-touch-icon-152.png",
  "./icons/apple-touch-icon-167.png",
  "./icons/apple-touch-icon-180.png",
  "./icons/favicon-16.png",
  "./icons/favicon-32.png",
  "./icons/icon-1024.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png"
];
const RUNTIME_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("scentphone-") && !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);

  // Pagina: netwerk eerst, offline terugvallen op de bewaarde versie
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((res) => { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put("./index.html", copy)); return res; })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Eigen bestanden: cache eerst
  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Externe bibliotheken en lettertypen: bewaarde versie direct, op de achtergrond verversen
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(caches.open(RUNTIME_CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => { if (res.ok || res.type === "opaque") cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
