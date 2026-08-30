
const APP_VERSION = "freemovies-app-v10-free-tier-safe";
const FREE_TIER_SAFE_MODE = true;
const SHELL_CACHE = `${APP_VERSION}-shell`;
const PAGE_CACHE = `${APP_VERSION}-pages`;
const META_CACHE = `${APP_VERSION}-meta`;
const APP_SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const scopePath = (value) => `${APP_SCOPE_PATH}/${String(value || "").replace(/^\/+/, "")}`;
const OFFLINE_URL = scopePath("/offline/");
const CONTENT_ALERT_SCAN_URL = scopePath("/api/content-alerts/");
const CONTENT_ALERT_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CONTENT_ALERT_STATE_URL = scopePath("/__freemovies__/content-alert-state");
const CONTENT_ALERT_CONFIG_URL = scopePath("/__freemovies__/content-alert-config");
const CACHEABLE_PAGE_PATHS = new Set([
    OFFLINE_URL,
]);
const PRECACHE_URLS = [
    OFFLINE_URL,
    scopePath("/static/manifest.json"),
    scopePath("/static/images/freemovies-logo.png"),
    scopePath("/static/images/freemovies-logo.svg"),
    scopePath("/static/js/app-shell.js"),
];
const API_PATH_PREFIXES = [
    scopePath("/api/"),
];
const STATIC_FILE_PATTERN = /\.(?:css|js|png|jpg|jpeg|svg|webp|gif|ico|woff2?|ttf)$/i;
const NOTIFICATION_DEFAULTS = {
    icon: scopePath("/static/images/freemovies-logo.png"),
    badge: scopePath("/static/images/freemovies-logo.png"),
    tag: "freemovies-default",
    renotify: false,
    requireInteraction: false,
    data: {
        url: scopePath("/"),
    },
};
const DEFAULT_CONTENT_ALERT_STATE = {
    primed: false,
    unseen_count: 0,
    trending: {},
    liked: {},
    last_scan_at: 0,
};
const DEFAULT_CONTENT_ALERT_CONFIG = {
    liked_titles: [],
    settings: {
        backgroundAlerts: false,
    },
    notification_permission: "default",
    last_synced_at: 0,
};

async function openCache(name) {
    return caches.open(name);
}

async function readJsonRecord(url, fallback) {
    try {
        const cache = await openCache(META_CACHE);
        const response = await cache.match(url);
        if (!response) {
            return fallback;
        }
        return await response.json();
    } catch (error) {
        return fallback;
    }
}

async function writeJsonRecord(url, value) {
    const cache = await openCache(META_CACHE);
    await cache.put(
        url,
        new Response(JSON.stringify(value), {
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            },
        })
    );
}

async function readContentAlertState() {
    const stored = await readJsonRecord(CONTENT_ALERT_STATE_URL, DEFAULT_CONTENT_ALERT_STATE);
    return {
        ...DEFAULT_CONTENT_ALERT_STATE,
        ...(stored || {}),
        trending: { ...(DEFAULT_CONTENT_ALERT_STATE.trending || {}), ...((stored || {}).trending || {}) },
        liked: { ...(DEFAULT_CONTENT_ALERT_STATE.liked || {}), ...((stored || {}).liked || {}) },
    };
}

async function writeContentAlertState(nextState) {
    const normalized = {
        ...DEFAULT_CONTENT_ALERT_STATE,
        ...(nextState || {}),
        trending: { ...((nextState || {}).trending || {}) },
        liked: { ...((nextState || {}).liked || {}) },
    };
    await writeJsonRecord(CONTENT_ALERT_STATE_URL, normalized);
    return normalized;
}

async function readContentAlertConfig() {
    const stored = await readJsonRecord(CONTENT_ALERT_CONFIG_URL, DEFAULT_CONTENT_ALERT_CONFIG);
    return {
        ...DEFAULT_CONTENT_ALERT_CONFIG,
        ...(stored || {}),
        settings: {
            ...(DEFAULT_CONTENT_ALERT_CONFIG.settings || {}),
            ...((stored || {}).settings || {}),
        },
        liked_titles: Array.isArray((stored || {}).liked_titles) ? stored.liked_titles : [],
    };
}

async function writeContentAlertConfig(nextConfig) {
    const normalized = {
        ...DEFAULT_CONTENT_ALERT_CONFIG,
        ...(nextConfig || {}),
        settings: {
            ...(DEFAULT_CONTENT_ALERT_CONFIG.settings || {}),
            ...((nextConfig || {}).settings || {}),
        },
        liked_titles: Array.isArray((nextConfig || {}).liked_titles) ? nextConfig.liked_titles : [],
        last_synced_at: Date.now(),
    };
    await writeJsonRecord(CONTENT_ALERT_CONFIG_URL, normalized);
    return normalized;
}

async function precacheAppShell() {
    if (FREE_TIER_SAFE_MODE) return;
    const cache = await openCache(SHELL_CACHE);
    await Promise.all(
        PRECACHE_URLS.map(async (url) => {
            try {
                await cache.add(url);
            } catch (error) {
            }
        })
    );
}

async function trimOldCaches() {
    const keys = await caches.keys();
    await Promise.all(
        keys
            .filter((key) => ![SHELL_CACHE, PAGE_CACHE, META_CACHE].includes(key))
            .map((key) => caches.delete(key))
    );
}

function isSameOrigin(request) {
    return new URL(request.url).origin === self.location.origin;
}

function isApiRequest(url) {
    return API_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

async function cacheFirst(request, cacheName) {
    const cache = await openCache(cacheName);
    const cached = await cache.match(request);
    if (cached) {
        return cached;
    }
    const response = await fetch(request);
    if (response && response.ok) {
        cache.put(request, response.clone());
    }
    return response;
}

async function staleWhileRevalidate(request, cacheName, fallbackUrl = "") {
    const cache = await openCache(cacheName);
    const cached = await cache.match(request);
    const networkFetch = fetch(request)
        .then((response) => {
            if (response && response.ok) {
                cache.put(request, response.clone());
            }
            return response;
        })
        .catch(() => null);
    if (cached) {
        return cached;
    }
    const response = await networkFetch;
    if (response) {
        return response;
    }
    if (fallbackUrl) {
        return cache.match(fallbackUrl) || caches.match(fallbackUrl);
    }
    throw new Error("No cached or network response available.");
}

async function networkFirst(request, cacheName, fallbackUrl = OFFLINE_URL) {
    const cache = await openCache(cacheName);
    try {
        const response = await fetch(request);
        if (response && response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        const cached = await cache.match(request);
        if (cached) {
            return cached;
        }
        if (request.mode === "navigate") {
            return cache.match(fallbackUrl) || caches.match(fallbackUrl);
        }
        throw error;
    }
}

async function networkOnly(request) {
    return fetch(request);
}

async function networkOnlyWithOfflineFallback(request) {
    try {
        return await fetch(request);
    } catch (error) {
        if (request.mode === "navigate") {
            return caches.match(OFFLINE_URL);
        }
        throw error;
    }
}

function truncateTitles(items, limit = 3) {
    return (items || [])
        .slice(0, limit)
        .map((item) => String(item?.title || "").trim())
        .filter(Boolean);
}

function joinNotificationTitles(items) {
    if (!items.length) return "";
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items[0]}, ${items[1]}, and more`;
}

async function updateAppBadge() {
    const contentAlertState = await readContentAlertState();
    const unseenCount = Math.max(0, Number(contentAlertState.unseen_count || 0));
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if ("setAppBadge" in self.navigator) {
        const visibleClients = windows.filter((client) => client.visibilityState !== "hidden");
        try {
            if (visibleClients.length || unseenCount <= 0) {
                await self.navigator.clearAppBadge();
            } else {
                await self.navigator.setAppBadge(unseenCount);
            }
        } catch (error) {
        }
    }
}

async function showManagedNotification(title, options = {}) {
    const mergedOptions = {
        ...NOTIFICATION_DEFAULTS,
        ...options,
        data: {
            ...(NOTIFICATION_DEFAULTS.data || {}),
            ...((options && options.data) || {}),
        },
    };
    await self.registration.showNotification(title, mergedOptions);
}

async function syncContentAlertPreferences(payload = {}) {
    const currentConfig = await readContentAlertConfig();
    return writeContentAlertConfig({
        ...currentConfig,
        liked_titles: Array.isArray(payload.liked_titles) ? payload.liked_titles.slice(0, 24) : currentConfig.liked_titles,
        notification_permission: payload.notification_permission || currentConfig.notification_permission,
        settings: {
            ...(currentConfig.settings || {}),
            ...((payload.settings && typeof payload.settings === "object") ? payload.settings : {}),
        },
    });
}

async function scanContentAlerts({ allowNotifications = true } = {}) {
    if (FREE_TIER_SAFE_MODE) {
        return { ok: false, skipped: "safe-mode", state: await readContentAlertState() };
    }
    const config = await readContentAlertConfig();
    if (!config.settings?.backgroundAlerts) {
        return { ok: false, skipped: "disabled", state: await readContentAlertState() };
    }
    if (config.notification_permission !== "granted") {
        return { ok: false, skipped: "permission", state: await readContentAlertState() };
    }

    let payload = null;
    try {
        const response = await fetch(CONTENT_ALERT_SCAN_URL, {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
                "X-No-Loader": "true",
            },
            body: JSON.stringify({
                liked_titles: Array.isArray(config.liked_titles) ? config.liked_titles.slice(0, 24) : [],
            }),
        });
        if (!response.ok) {
            return { ok: false, skipped: `http-${response.status}`, state: await readContentAlertState() };
        }
        payload = await response.json();
    } catch (error) {
        return { ok: false, skipped: "network", state: await readContentAlertState() };
    }

    const previousState = await readContentAlertState();
    const nextTrendingState = {};
    const nextLikedState = {};
    let unseenCount = Number(previousState.unseen_count || 0);
    let notificationsSent = 0;

    for (const bucket of payload.trending_buckets || []) {
        const bucketKey = String(bucket?.key || "");
        const items = Array.isArray(bucket?.items) ? bucket.items : [];
        const currentIds = items.map((item) => String(item?.id || "")).filter(Boolean);
        nextTrendingState[bucketKey] = currentIds;

        if (!previousState.primed) continue;

        const previousIds = new Set(Array.isArray(previousState.trending?.[bucketKey]) ? previousState.trending[bucketKey] : []);
        const newItems = items.filter((item) => {
            const itemId = String(item?.id || "");
            return itemId && !previousIds.has(itemId);
        });
        if (!newItems.length || !allowNotifications) continue;

        unseenCount += newItems.length;
        notificationsSent += 1;
        await showManagedNotification(`New ${bucket.label || "trending picks"}`, {
            body: joinNotificationTitles(truncateTitles(newItems)),
            image: newItems[0]?.poster || undefined,
            tag: `trending-${bucketKey}`,
            renotify: true,
            requireInteraction: false,
            actions: [
                { action: "open-home", title: "Open app" },
            ],
            data: {
                url: newItems[0]?.detail_url ? scopePath(newItems[0].detail_url) : scopePath("/"),
            },
        });
    }

    for (const entry of payload.liked_updates || []) {
        const titleId = String(entry?.title_id || "");
        const stateKey = String(entry?.state_key || "");
        if (!titleId || !stateKey) continue;
        nextLikedState[titleId] = stateKey;

        const previousStateKey = String(previousState.liked?.[titleId] || "");
        if (!previousState.primed || !previousStateKey || previousStateKey === stateKey || !allowNotifications) {
            continue;
        }

        unseenCount += 1;
        notificationsSent += 1;
        await showManagedNotification(entry.notification_title || "New update", {
            body: entry.notification_body || "Fresh content is available.",
            image: entry.poster || undefined,
            tag: `liked-${titleId}`,
            renotify: true,
            requireInteraction: true,
            actions: [
                { action: "open-home", title: "Open app" },
            ],
            data: {
                url: entry.target_url ? scopePath(entry.target_url) : scopePath("/"),
            },
        });
    }

    const nextState = await writeContentAlertState({
        primed: true,
        unseen_count: unseenCount,
        trending: nextTrendingState,
        liked: nextLikedState,
        last_scan_at: Date.now(),
    });
    await updateAppBadge();
    return {
        ok: true,
        notificationsSent,
        state: nextState,
    };
}

self.addEventListener("install", (event) => {
    event.waitUntil(precacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        await trimOldCaches();
        if ("navigationPreload" in self.registration) {
            try {
                await self.registration.navigationPreload.enable();
            } catch (error) {
            }
        }
        await self.clients.claim();
        await updateAppBadge();
    })());
});

self.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") {
        return;
    }

    const url = new URL(request.url);

    if (request.mode === "navigate") {
        if (CACHEABLE_PAGE_PATHS.has(url.pathname)) {
            event.respondWith(networkFirst(request, PAGE_CACHE, OFFLINE_URL));
        } else {
            event.respondWith(networkOnlyWithOfflineFallback(request));
        }
        return;
    }

    if (isApiRequest(url)) {
        event.respondWith(networkOnly(request));
        return;
    }

    if (isSameOrigin(request) && STATIC_FILE_PATTERN.test(url.pathname)) {
        event.respondWith(cacheFirst(request, SHELL_CACHE));
        return;
    }

    if (!isSameOrigin(request) && STATIC_FILE_PATTERN.test(url.pathname)) {
        return;
    }
});

self.addEventListener("message", (event) => {
    const payload = event.data || {};
    const replyPort = event.ports?.[0] || null;
    if (payload.type === "SKIP_WAITING") {
        self.skipWaiting();
        return;
    }
    if (payload.type === "WARM_URLS" && Array.isArray(payload.urls)) {
        if (FREE_TIER_SAFE_MODE) return;
        event.waitUntil((async () => {
            const cache = await openCache(PAGE_CACHE);
            await Promise.all(
                payload.urls
                    .filter((url) => typeof url === "string" && url.startsWith("/"))
                    .filter((url) => !url.startsWith("/api/") && !url.startsWith("/title/") && !url.startsWith("/search/"))
                    .slice(0, 3)
                    .map(async (url) => {
                        try {
                            const response = await fetch(url, { credentials: "same-origin" });
                            if (response.ok) {
                                await cache.put(url, response.clone());
                            }
                        } catch (error) {
                        }
                    })
            );
        })());
        return;
    }
    if (payload.type === "SYNC_CONTENT_ALERT_PREFERENCES") {
        event.waitUntil((async () => {
            const config = await syncContentAlertPreferences(payload);
            replyPort?.postMessage({ ok: true, config });
        })());
        return;
    }
    if (payload.type === "SCAN_CONTENT_ALERTS") {
        event.waitUntil((async () => {
            const result = await scanContentAlerts({
                allowNotifications: payload.allowNotifications !== false,
            });
            replyPort?.postMessage(result);
        })());
        return;
    }
    if (payload.type === "CLEAR_CONTENT_ALERT_BADGE") {
        event.waitUntil((async () => {
            const currentState = await readContentAlertState();
            const nextState = await writeContentAlertState({
                ...currentState,
                unseen_count: 0,
            });
            await updateAppBadge();
            replyPort?.postMessage({ ok: true, state: nextState });
        })());
        return;
    }
    if (payload.type === "SHOW_NOTIFICATION" && payload.title) {
        const options = {
            ...NOTIFICATION_DEFAULTS,
            ...(payload.options || {}),
            data: {
                ...(NOTIFICATION_DEFAULTS.data || {}),
                ...((payload.options && payload.options.data) || {}),
            },
        };
        event.waitUntil(self.registration.showNotification(payload.title, options));
    }
});

self.addEventListener("sync", (event) => {
    if (FREE_TIER_SAFE_MODE) return;
    if (event.tag === "content-alerts-sync") {
        event.waitUntil(scanContentAlerts({ allowNotifications: true }));
    }
});

self.addEventListener("periodicsync", (event) => {
    if (FREE_TIER_SAFE_MODE) return;
    if (event.tag === "content-alerts") {
        event.waitUntil(scanContentAlerts({ allowNotifications: true }));
    }
});

self.addEventListener("push", (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (error) {
        payload = { title: "Free Movies App", body: event.data ? event.data.text() : "New update available." };
    }
    const title = payload.title || "Free Movies App";
    const options = {
        ...NOTIFICATION_DEFAULTS,
        ...(payload.options || {}),
        body: payload.body || "Fresh titles or updates are ready.",
        actions: payload.actions || [
            { action: "open-home", title: "Open app" },
            { action: "open-live-tv", title: "Live TV" },
        ],
        data: {
            ...(NOTIFICATION_DEFAULTS.data || {}),
            ...(payload.data || {}),
        },
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const targetUrl = (() => {
        if (event.action === "open-live-tv") return scopePath("/live-tv/");
        if (event.action === "open-search") return scopePath("/search/");
        return event.notification.data?.url || scopePath("/");
    })();

    event.waitUntil((async () => {
        const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const absoluteTarget = new URL(targetUrl, self.location.origin).href;
        for (const client of allClients) {
            if ("focus" in client) {
                if (client.url === absoluteTarget || client.url.startsWith(absoluteTarget)) {
                    await client.focus();
                    return;
                }
            }
        }
        if (self.clients.openWindow) {
            await self.clients.openWindow(absoluteTarget);
        }
    })());
});
