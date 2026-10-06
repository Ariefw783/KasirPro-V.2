const CACHE_VERSION = "kasirpro-pwa-v64-purge-progress-modal";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const STATIC_ASSETS = [
    "./",
    "./index.html",
    "./version.json",
    "./style.css",
    "./ui-modal.css",
    "./login-theme.css",
    "./manifest.webmanifest",
    "./offline.html",
    "./assets/login-background.svg",
    "./assets/favicon.ico",
    "./assets/favicon-16.png",
    "./assets/favicon-32.png",
    "./assets/favicon-48.png",
    "./assets/apple-touch-icon-180.png",
    "./assets/kasirpro-symbol.svg",
    "./assets/kasirpro-symbol-monochrome.svg",
    "./assets/logo-kasirpro-horizontal.svg",
    "./assets/logo-kasirpro-horizontal-white.svg",
    "./assets/icon-192.png",
    "./assets/icon-512.png",
    "./assets/icon-maskable-512.png",
    "./assets/shortcut-pos-192.png",
    "./assets/shortcut-management-192.png",
    "./management/index.html",
    "./management/management.css",
    "./management/management-mobile.css",
    "./pos/index.html",
    "./pos/pos.css",
    "./modules/diagnostic-reporter.js",
    "./modules/diagnostic-reporter.css"
];

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const cache = await caches.open(STATIC_CACHE);
        await cache.addAll(STATIC_ASSETS);
    })());
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name !== STATIC_CACHE).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener("message", event => {
    if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

async function networkOnlyWithOfflinePage(request) {
    try { return await fetch(request, { cache: "no-store" }); }
    catch (error) {
        if (request.mode === "navigate") {
            const cache = await caches.open(STATIC_CACHE);
            return (await cache.match("./offline.html")) || Response.error();
        }
        throw error;
    }
}

async function staticNetworkFirst(request) {
    const cache = await caches.open(STATIC_CACHE);
    try {
        const response = await fetch(request, { cache: "no-store" });
        if (response.ok) await cache.put(request, response.clone());
        return response;
    } catch (error) {
        return (await cache.match(request, { ignoreSearch: true })) || Response.error();
    }
}

self.addEventListener("fetch", event => {
    const { request } = event;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    const same = url.origin === self.location.origin;
    const source = /\.(?:js|mjs|json)$/i.test(url.pathname);
    const excel = /\.xlsx?$/i.test(url.pathname);
    if (!same || source || excel) {
        event.respondWith(networkOnlyWithOfflinePage(request));
        return;
    }
    if (request.mode === "navigate" || same) event.respondWith(staticNetworkFirst(request));
});
