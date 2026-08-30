(function () {
    const APP_NAMESPACE = "freemovies-native-app";
    const OFFLINE_FORM_QUEUE_KEY = `${APP_NAMESPACE}:offline-form-queue`;
    const NOTIFICATION_SCHEDULE_KEY = `${APP_NAMESPACE}:notification-schedule`;
    const INSTALL_DISMISSED_KEY = `${APP_NAMESPACE}:install-dismissed`;
    const CONTENT_ALERT_STATE_KEY = `${APP_NAMESPACE}:content-alert-state-v1`;
    const APP_SETTINGS_KEY = `${APP_NAMESPACE}:settings-v2`;
    const CONTENT_ALERT_SCAN_URL = "/api/content-alerts/";
    const PUSH_PUBLIC_KEY_URL = "/api/push/public-key/";
    const PUSH_SUBSCRIBE_URL = "/api/push/subscribe/";
    const PUSH_UNSUBSCRIBE_URL = "/api/push/unsubscribe/";
    const PUSH_TEST_URL = "/api/push/test/";
    const CONTENT_ALERT_META_CACHE = `${APP_NAMESPACE}:content-alert-meta`;
    const CONTENT_ALERT_STATE_URL = "/__freemovies__/content-alert-state";
    const PUSH_SUBSCRIPTION_URL = "/__freemovies__/push-subscription";
    const LIKED_TITLES_STORAGE_KEY = "freemovie_liked_titles_v1";
    const SEARCH_HISTORY_STORAGE_KEY = "freemovie_search_history_v1";
    const SEARCH_HISTORY_LIMIT = 12;
    const CONTENT_ALERT_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
    const NATIVE_BAR = document.getElementById("nativeAppBar");
    const NATIVE_BAR_TITLE = document.getElementById("nativeAppBarTitle");
    const NATIVE_BAR_TEXT = document.getElementById("nativeAppBarText");
    const INSTALL_BUTTON = document.getElementById("nativeInstallButton");
    const INSTALL_BUTTONS = Array.from(document.querySelectorAll(".js-app-install-button"));
    const NOTIFY_BUTTON = document.getElementById("nativeNotifyButton");
    const TOAST_STACK = document.getElementById("nativeToastStack");
    const HAPTIC_SELECTORS = [
        "a[href]",
        "button",
        "[role='button']",
        "input[type='submit']",
        "input[type='button']",
        "label[for]",
        ".bottom-link",
        ".card-link",
        ".server-button",
        ".season-chip",
        ".episode-chip",
        ".audio-chip",
        ".custom-select-trigger",
        ".custom-select-option",
    ].join(",");
    let installPromptEvent = null;
    let deferredPreloadFired = false;
    let domReadyAt = 0;
    let contentAlertScanTimer = null;
    let contentAlertListenersBound = false;
    const DEFAULT_SETTINGS = {
        autoNotificationPrompt: true,
        haptics: true,
        backgroundAlerts: false,
        smartPreload: false,
        cinematicTransitions: true,
    };
    const LOCKED_ON_SETTINGS = new Set();

    function urlBase64ToUint8Array(base64String) {
        const normalized = String(base64String || "").replace(/-/g, "+").replace(/_/g, "/");
        const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
        const rawData = window.atob(normalized + padding);
        return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
    }

    function canUseStorage() {
        try {
            window.localStorage.setItem(`${APP_NAMESPACE}:probe`, "1");
            window.localStorage.removeItem(`${APP_NAMESPACE}:probe`);
            return true;
        } catch (error) {
            return false;
        }
    }

    function readJson(key, fallback) {
        if (!canUseStorage()) return fallback;
        try {
            const value = window.localStorage.getItem(key);
            return value ? JSON.parse(value) : fallback;
        } catch (error) {
            return fallback;
        }
    }

    function writeJson(key, value) {
        if (!canUseStorage()) return;
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
        }
    }

    function readLikedTitles() {
        return readJson(LIKED_TITLES_STORAGE_KEY, []).filter((entry) => entry && typeof entry === "object");
    }

    function normalizeAppSettings(nextValue) {
        const merged = {
            ...DEFAULT_SETTINGS,
            ...(nextValue || {}),
        };
        LOCKED_ON_SETTINGS.forEach((key) => {
            merged[key] = true;
        });
        return merged;
    }

    function readAppSettings() {
        return normalizeAppSettings(readJson(APP_SETTINGS_KEY, {}));
    }

    function writeAppSettings(nextValue) {
        const merged = normalizeAppSettings(nextValue);
        writeJson(APP_SETTINGS_KEY, merged);
        syncContentAlertPreferences().catch(() => {});
        return merged;
    }

    function ensureAppSettings() {
        const stored = readJson(APP_SETTINGS_KEY, null);
        const normalized = readAppSettings();
        if (!stored || JSON.stringify(normalized) !== JSON.stringify(normalizeAppSettings(stored))) {
            writeJson(APP_SETTINGS_KEY, normalized);
        }
        return normalized;
    }

    function shouldRunContentAlerts() {
        return false;
        if (!ensureAppSettings().backgroundAlerts) {
            return false;
        }
        if (!("Notification" in window) || Notification.permission !== "granted") {
            return false;
        }
        return true;
    }

    function showToast(message) {
        if (!TOAST_STACK || !message) return;
        const toast = document.createElement("div");
        toast.className = "native-toast";
        toast.textContent = message;
        TOAST_STACK.appendChild(toast);
        window.requestAnimationFrame(() => {
            toast.classList.add("is-visible");
        });
        window.setTimeout(() => {
            toast.classList.remove("is-visible");
            window.setTimeout(() => toast.remove(), 220);
        }, 2600);
    }

    function showLoader(title = "Loading", text = "Preparing your next screen.") {
        return;
    }

    function hideLoader(force = false) {
        return;
    }

    function pulseLoader(title, text, durationMs = 1000) {
        showLoader(title, text);
        window.setTimeout(() => hideLoader(), durationMs);
    }

    function normalizeRequestUrl(input) {
        try {
            if (typeof input === "string") {
                return new URL(input, window.location.href);
            }
            if (input instanceof URL) {
                return input;
            }
            if (typeof Request !== "undefined" && input instanceof Request) {
                return new URL(input.url, window.location.href);
            }
        } catch (error) {
        }
        return null;
    }

    function shouldIgnoreAutoLoader(url, options = {}) {
        if (!url || url.origin !== window.location.origin) return true;
        if (!url.pathname.startsWith("/api/")) return true;
        if (url.pathname.includes("/api/tracking/collect/")) return true;
        if (url.pathname.includes("/api/search/suggest/")) return true;

        const headers = new Headers(options.headers || (options instanceof Request ? options.headers : undefined) || {});
        if (headers.get("x-no-loader") === "true") return true;
        return false;
    }

    function installFetchLoader() {
        return;
    }

    function vibrate(pattern) {
        if (!("vibrate" in navigator)) return false;
        try {
            return navigator.vibrate(pattern);
        } catch (error) {
            return false;
        }
    }

    function haptic(kind = "light") {
        if (!ensureAppSettings().haptics) return;
        const patternMap = {
            light: 10,
            medium: [16],
            heavy: [22, 18, 22],
            success: [12, 40, 12],
            warning: [18, 60, 18],
        };
        vibrate(patternMap[kind] || patternMap.light);
    }

    function setBarState({ visible, title, text, installVisible }) {
        if (!NATIVE_BAR) return;
        NATIVE_BAR.classList.toggle("is-visible", Boolean(visible));
        if (title && NATIVE_BAR_TITLE) NATIVE_BAR_TITLE.textContent = title;
        if (text && NATIVE_BAR_TEXT) NATIVE_BAR_TEXT.textContent = text;
        if (INSTALL_BUTTON) {
            INSTALL_BUTTON.hidden = !installVisible;
        }
        INSTALL_BUTTONS.forEach((button) => {
            button.dataset.installReady = installVisible ? "true" : "false";
        });
    }

    function isStandaloneMode() {
        return Boolean(
            window.matchMedia?.("(display-mode: standalone)")?.matches
            || window.navigator.standalone
        );
    }

    function syncInstallButtons() {
        INSTALL_BUTTONS.forEach((button) => {
            const installed = isStandaloneMode();
            button.classList.toggle("is-installed", installed);
            button.textContent = installed ? "App Installed" : "Install App";
            button.setAttribute("aria-label", installed ? "App already installed" : "Install app");
        });
    }

    async function registerServiceWorker() {
        if (!("serviceWorker" in navigator)) return null;
        try {
            const registration = await navigator.serviceWorker.register("/service-worker.js", {
                scope: "/",
                updateViaCache: "none",
            });
            navigator.serviceWorker.addEventListener("message", () => {});
            navigator.serviceWorker.ready.then(async () => {
                await syncContentAlertPreferences().catch(() => {});
                await registerBackgroundContentAlertSync().catch(() => {});
            }).catch(() => {});
            return registration;
        } catch (error) {
            return null;
        }
    }

    async function requestNotificationPermission() {
        if (!("Notification" in window)) {
            showToast("Notifications are not supported in this browser.");
            return "unsupported";
        }
        const permission = await Notification.requestPermission();
        if (permission === "granted") {
            haptic("success");
            showToast("Notifications enabled.");
            window.setTimeout(() => {
                refreshBackgroundServices().catch(() => {});
            }, 0);
        }
        syncContentAlertPreferences().catch(() => {});
        return permission;
    }

    async function showNotification(title, options = {}) {
        if (!title) return false;
        const permission = Notification.permission === "granted"
            ? "granted"
            : await requestNotificationPermission();
        if (permission !== "granted") return false;

        const registration = await navigator.serviceWorker.ready.catch(() => null);
        if (registration) {
            await registration.showNotification(title, {
                body: options.body || "",
                icon: "/static/images/freemovies-logo.png",
                badge: "/static/images/freemovies-logo.png",
                ...options,
            });
        } else {
            new Notification(title, options);
        }
        return true;
    }

    function scheduleNotification(title, options = {}, delayMs = 5000) {
        if (!title) return null;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const queue = readJson(NOTIFICATION_SCHEDULE_KEY, []);
        const entry = {
            id,
            title,
            options,
            dueAt: Date.now() + Math.max(1000, Number(delayMs) || 0),
        };
        queue.push(entry);
        writeJson(NOTIFICATION_SCHEDULE_KEY, queue);
        window.setTimeout(async () => {
            await showNotification(entry.title, entry.options);
            removeScheduledNotification(id);
        }, delayMs);
        return id;
    }

    function removeScheduledNotification(id) {
        const queue = readJson(NOTIFICATION_SCHEDULE_KEY, []);
        writeJson(
            NOTIFICATION_SCHEDULE_KEY,
            queue.filter((item) => item.id !== id)
        );
    }

    async function readSharedJson(url, fallback) {
        if (!("caches" in window)) return fallback;
        try {
            const cache = await caches.open(CONTENT_ALERT_META_CACHE);
            const response = await cache.match(url);
            if (!response) return fallback;
            return await response.json();
        } catch (error) {
            return fallback;
        }
    }

    async function writeSharedJson(url, value) {
        if (!("caches" in window)) return;
        try {
            const cache = await caches.open(CONTENT_ALERT_META_CACHE);
            await cache.put(
                url,
                new Response(JSON.stringify(value), {
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store",
                    },
                })
            );
        } catch (error) {
        }
    }

    async function readStoredPushSubscription() {
        return readSharedJson(PUSH_SUBSCRIPTION_URL, null);
    }

    async function writeStoredPushSubscription(value) {
        return writeSharedJson(PUSH_SUBSCRIPTION_URL, value || null);
    }

    async function fetchPushPublicKey() {
        try {
            const response = await fetch(PUSH_PUBLIC_KEY_URL, {
                credentials: "same-origin",
                headers: { "X-No-Loader": "true" },
            });
            if (!response.ok) return null;
            const payload = await response.json();
            if (!payload?.enabled || !payload?.public_key) return null;
            return payload.public_key;
        } catch (error) {
            return null;
        }
    }

    async function getActiveServiceWorker() {
        if (!("serviceWorker" in navigator)) return null;
        const controller = navigator.serviceWorker.controller;
        if (controller) return controller;
        const registration = await navigator.serviceWorker.ready.catch(() => null);
        return registration?.active || null;
    }

    async function postServiceWorkerMessage(payload) {
        const worker = await getActiveServiceWorker();
        if (!worker) return null;
        return new Promise((resolve) => {
            let settled = false;
            const channel = new MessageChannel();
            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            channel.port1.onmessage = (event) => finish(event.data || null);
            try {
                worker.postMessage(payload, [channel.port2]);
            } catch (error) {
                finish(null);
                return;
            }
            window.setTimeout(() => finish(null), 4000);
        });
    }

    async function getPushSubscriptionSnapshot() {
        const registration = await navigator.serviceWorker?.ready?.catch(() => null);
        if (!registration?.pushManager) return null;
        const subscription = await registration.pushManager.getSubscription().catch(() => null);
        if (!subscription) return null;
        return subscription.toJSON ? subscription.toJSON() : subscription;
    }

    async function sendPushSubscriptionToServer(subscriptionPayload) {
        if (!subscriptionPayload?.endpoint) return false;
        try {
            const response = await fetch(PUSH_SUBSCRIBE_URL, {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Content-Type": "application/json",
                    "X-No-Loader": "true",
                },
                body: JSON.stringify({
                    subscription: subscriptionPayload,
                    liked_titles: readLikedTitles().slice(0, 24),
                    settings: {
                        backgroundAlerts: Boolean(readAppSettings().backgroundAlerts),
                    },
                    notification_permission: "Notification" in window ? Notification.permission : "unsupported",
                }),
            });
            if (!response.ok) return false;
            await writeStoredPushSubscription(subscriptionPayload);
            return true;
        } catch (error) {
            return false;
        }
    }

    async function unsubscribePushNotifications() {
        const registration = await navigator.serviceWorker?.ready?.catch(() => null);
        const activeSubscription = await registration?.pushManager?.getSubscription?.().catch(() => null);
        const payload = activeSubscription?.toJSON ? activeSubscription.toJSON() : (await readStoredPushSubscription());
        try {
            if (payload?.endpoint) {
                await fetch(PUSH_UNSUBSCRIBE_URL, {
                    method: "POST",
                    credentials: "same-origin",
                    headers: {
                        "Content-Type": "application/json",
                        "X-No-Loader": "true",
                    },
                    body: JSON.stringify({ subscription: payload }),
                });
            }
        } catch (error) {
        }
        if (activeSubscription) {
            await activeSubscription.unsubscribe().catch(() => {});
        }
        await writeStoredPushSubscription(null);
        return true;
    }

    async function ensurePushSubscription() {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
        if (!ensureAppSettings().backgroundAlerts) return false;
        if (!("Notification" in window) || Notification.permission !== "granted") return false;
        const registration = await navigator.serviceWorker.ready.catch(() => null);
        if (!registration?.pushManager) return false;
        const publicKey = await fetchPushPublicKey();
        if (!publicKey) return false;
        let subscription = await registration.pushManager.getSubscription().catch(() => null);
        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
            }).catch(() => null);
        }
        const subscriptionPayload = subscription?.toJSON ? subscription.toJSON() : subscription;
        if (!subscriptionPayload?.endpoint) return false;
        return sendPushSubscriptionToServer(subscriptionPayload);
    }

    async function sendTestPush() {
        const subscriptionPayload = await getPushSubscriptionSnapshot();
        if (!subscriptionPayload?.endpoint) return false;
        try {
            const response = await fetch(PUSH_TEST_URL, {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Content-Type": "application/json",
                    "X-No-Loader": "true",
                },
                body: JSON.stringify({ subscription: subscriptionPayload }),
            });
            if (!response.ok) return false;
            const payload = await response.json();
            return Boolean(payload?.ok);
        } catch (error) {
            return false;
        }
    }

    async function syncContentAlertPreferences() {
        const payload = {
            type: "SYNC_CONTENT_ALERT_PREFERENCES",
            liked_titles: readLikedTitles().slice(0, 24),
            settings: {
                backgroundAlerts: Boolean(readAppSettings().backgroundAlerts),
            },
            notification_permission: "Notification" in window ? Notification.permission : "unsupported",
        };
        const serviceWorkerResult = await postServiceWorkerMessage(payload);
        if (!ensureAppSettings().backgroundAlerts || ("Notification" in window && Notification.permission === "denied")) {
            await unsubscribePushNotifications().catch(() => {});
        } else if ("Notification" in window && Notification.permission === "granted") {
            await ensurePushSubscription().catch(() => {});
        }
        return serviceWorkerResult;
    }

    async function registerBackgroundContentAlertSync() {
        return;
        const registration = await navigator.serviceWorker?.ready?.catch(() => null);
        if (!registration) return;
        const shouldRegister = shouldRunContentAlerts();

        if ("periodicSync" in registration) {
            try {
                if (shouldRegister) {
                    await registration.periodicSync.register("content-alerts", {
                        minInterval: CONTENT_ALERT_SCAN_INTERVAL_MS,
                    });
                } else if (typeof registration.periodicSync.getTags === "function") {
                    const tags = await registration.periodicSync.getTags();
                    if (tags.includes("content-alerts") && typeof registration.periodicSync.unregister === "function") {
                        await registration.periodicSync.unregister("content-alerts");
                    }
                }
            } catch (error) {
            }
        }

        if (shouldRegister && "sync" in registration) {
            try {
                await registration.sync.register("content-alerts-sync");
            } catch (error) {
            }
        }
    }

    async function flushScheduledNotifications() {
        const queue = readJson(NOTIFICATION_SCHEDULE_KEY, []);
        const now = Date.now();
        const remaining = [];
        for (const item of queue) {
            if (item.dueAt <= now) {
                await showNotification(item.title, item.options);
            } else {
                remaining.push(item);
                window.setTimeout(async () => {
                    await showNotification(item.title, item.options);
                    removeScheduledNotification(item.id);
                }, item.dueAt - now);
            }
        }
        writeJson(NOTIFICATION_SCHEDULE_KEY, remaining);
    }

    async function copyText(text) {
        if (!text) return false;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                haptic("success");
                showToast("Copied to clipboard.");
                return true;
            }
        } catch (error) {
        }
        const helper = document.createElement("textarea");
        helper.value = text;
        helper.setAttribute("readonly", "readonly");
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.appendChild(helper);
        helper.select();
        const worked = document.execCommand("copy");
        helper.remove();
        if (worked) {
            haptic("success");
            showToast("Copied to clipboard.");
        }
        return worked;
    }

    async function readClipboardText() {
        if (!navigator.clipboard?.readText) {
            throw new Error("Clipboard read is not supported.");
        }
        return navigator.clipboard.readText();
    }

    async function getBatteryStatus() {
        if (!navigator.getBattery) return null;
        const battery = await navigator.getBattery();
        return {
            level: Math.round((battery.level || 0) * 100),
            charging: Boolean(battery.charging),
            chargingTime: battery.chargingTime,
            dischargingTime: battery.dischargingTime,
        };
    }

    async function requestBluetoothDevice(options = { acceptAllDevices: true }) {
        if (!navigator.bluetooth?.requestDevice) {
            throw new Error("Web Bluetooth is not supported.");
        }
        return navigator.bluetooth.requestDevice(options);
    }

    async function requestOrientationAccess() {
        const orientationPermission = window.DeviceOrientationEvent?.requestPermission;
        if (typeof orientationPermission === "function") {
            const result = await orientationPermission.call(window.DeviceOrientationEvent);
            if (result !== "granted") {
                throw new Error("Orientation permission denied.");
            }
        }
        return true;
    }

    async function startMotionSensors(callback) {
        await requestOrientationAccess().catch(() => null);
        const listener = (event) => {
            callback?.({
                alpha: event.alpha,
                beta: event.beta,
                gamma: event.gamma,
                absolute: event.absolute,
            });
        };
        window.addEventListener("deviceorientation", listener, { passive: true });
        return () => window.removeEventListener("deviceorientation", listener);
    }

    async function updateBadge(count = 0) {
        try {
            if ("setAppBadge" in navigator && count > 0) {
                await navigator.setAppBadge(count);
            }
            if ("clearAppBadge" in navigator && count <= 0) {
                await navigator.clearAppBadge();
            }
        } catch (error) {
        }
    }

    async function readContentAlertState() {
        const localState = readJson(CONTENT_ALERT_STATE_KEY, {
            primed: false,
            unseen_count: 0,
            trending: {},
            liked: {},
            last_scan_at: 0,
        });
        const sharedState = await readSharedJson(CONTENT_ALERT_STATE_URL, localState);
        const normalized = {
            primed: Boolean(sharedState?.primed),
            unseen_count: Number(sharedState?.unseen_count || 0),
            trending: sharedState?.trending && typeof sharedState.trending === "object" ? sharedState.trending : {},
            liked: sharedState?.liked && typeof sharedState.liked === "object" ? sharedState.liked : {},
            last_scan_at: Number(sharedState?.last_scan_at || 0),
        };
        writeJson(CONTENT_ALERT_STATE_KEY, normalized);
        return normalized;
    }

    async function writeContentAlertState(nextState) {
        writeJson(CONTENT_ALERT_STATE_KEY, nextState);
        await writeSharedJson(CONTENT_ALERT_STATE_URL, nextState);
    }

    function truncateTitles(items, limit = 3) {
        return items
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

    async function performLocalContentAlertScan() {
        if (!navigator.onLine) return;

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
                    liked_titles: readLikedTitles().slice(0, 24),
                }),
            });
            if (!response.ok) return;
            payload = await response.json();
        } catch (error) {
            return;
        }

        if (!payload) return;

        const permission = "Notification" in window ? Notification.permission : "denied";
        const canNotify = permission === "granted";
        const previousState = await readContentAlertState();
        const nextTrendingState = {};
        const nextLikedState = {};
        let unseenCount = Number(previousState.unseen_count || 0);

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
            if (!newItems.length || !canNotify) continue;

            unseenCount += newItems.length;
            await showNotification(`New ${bucket.label || "trending picks"}`, {
                body: joinNotificationTitles(truncateTitles(newItems)),
                icon: "/static/images/freemovies-logo.png",
                badge: "/static/images/freemovies-logo.png",
                image: newItems[0]?.poster || undefined,
                tag: `trending-${bucketKey}`,
                renotify: true,
                requireInteraction: false,
                actions: [
                    { action: "open-home", title: "Open app" },
                ],
                data: {
                    url: newItems[0]?.detail_url || "/",
                },
            });
        }

        for (const entry of payload.liked_updates || []) {
            const titleId = String(entry?.title_id || "");
            const stateKey = String(entry?.state_key || "");
            if (!titleId || !stateKey) continue;
            nextLikedState[titleId] = stateKey;

            const previousStateKey = String(previousState.liked?.[titleId] || "");
            if (!previousState.primed || !previousStateKey || previousStateKey === stateKey || !canNotify) {
                continue;
            }

            unseenCount += 1;
            await showNotification(entry.notification_title || "New update", {
                body: entry.notification_body || "Fresh content is available.",
                icon: "/static/images/freemovies-logo.png",
                badge: "/static/images/freemovies-logo.png",
                image: entry.poster || undefined,
                tag: `liked-${titleId}`,
                renotify: true,
                requireInteraction: true,
                actions: [
                    { action: "open-home", title: "Open app" },
                ],
                data: {
                    url: entry.target_url || "/",
                },
            });
        }

        await writeContentAlertState({
            primed: true,
            unseen_count: unseenCount,
            trending: nextTrendingState,
            liked: nextLikedState,
            last_scan_at: Date.now(),
        });
        await updateBadge(unseenCount);
    }

    async function scanContentAlerts() {
        return { ok: false, skipped: "safe-mode" };
        await syncContentAlertPreferences().catch(() => {});
        const serviceWorkerResult = await postServiceWorkerMessage({
            type: "SCAN_CONTENT_ALERTS",
            allowNotifications: true,
        });
        if (serviceWorkerResult?.state) {
            await writeContentAlertState(serviceWorkerResult.state);
            await updateBadge(Number(serviceWorkerResult.state.unseen_count || 0));
            return serviceWorkerResult;
        }
        await performLocalContentAlertScan();
        return { ok: true };
    }

    async function clearContentAlertBadge() {
        const serviceWorkerResult = await postServiceWorkerMessage({
            type: "CLEAR_CONTENT_ALERT_BADGE",
        });
        if (serviceWorkerResult?.state) {
            await writeContentAlertState(serviceWorkerResult.state);
            await updateBadge(0);
            return;
        }

        const currentState = await readContentAlertState();
        if (!currentState.unseen_count) return;
        await writeContentAlertState({
            ...currentState,
            unseen_count: 0,
        });
        await updateBadge(0);
    }

    function scheduleContentAlertScans() {
        window.clearInterval(contentAlertScanTimer);
        contentAlertScanTimer = null;
        if (!shouldRunContentAlerts()) return;
        const kickOffScan = () => {
            syncContentAlertPreferences().catch(() => {});
            registerBackgroundContentAlertSync().catch(() => {});
            scanContentAlerts();
            contentAlertScanTimer = window.setInterval(() => {
                if (!navigator.onLine) return;
                syncContentAlertPreferences().catch(() => {});
                scanContentAlerts();
            }, CONTENT_ALERT_SCAN_INTERVAL_MS);
        };

        if ("requestIdleCallback" in window) {
            window.requestIdleCallback(kickOffScan, { timeout: 4000 });
        } else {
            window.setTimeout(kickOffScan, 2500);
        }

        if (contentAlertListenersBound) return;
        contentAlertListenersBound = true;
        window.addEventListener("storage", (event) => {
            if (event.key === LIKED_TITLES_STORAGE_KEY || event.key === APP_SETTINGS_KEY) {
                syncContentAlertPreferences().catch(() => {});
            }
        });
        window.addEventListener("online", () => {
            syncContentAlertPreferences().catch(() => {});
            registerBackgroundContentAlertSync().catch(() => {});
            scanContentAlerts();
        });
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
                clearContentAlertBadge();
                syncContentAlertPreferences().catch(() => {});
                scanContentAlerts();
            }
        });
        window.addEventListener("focus", () => {
            clearContentAlertBadge();
            syncContentAlertPreferences().catch(() => {});
        });
    }

    async function refreshBackgroundServices() {
        ensureAppSettings();
        await syncContentAlertPreferences().catch(() => {});
        await registerBackgroundContentAlertSync().catch(() => {});
        scheduleContentAlertScans();
        if (shouldRunContentAlerts()) {
            await scanContentAlerts();
        }
    }

    function serializeForm(form) {
        const formData = new FormData(form);
        const payload = {};
        for (const [key, value] of formData.entries()) {
            if (Object.prototype.hasOwnProperty.call(payload, key)) {
                payload[key] = Array.isArray(payload[key]) ? payload[key].concat(value) : [payload[key], value];
            } else {
                payload[key] = value;
            }
        }
        return payload;
    }

    async function flushOfflineForms() {
        const queue = readJson(OFFLINE_FORM_QUEUE_KEY, []);
        if (!queue.length || !navigator.onLine) return;
        const remaining = [];
        for (const entry of queue) {
            try {
                const response = await fetch(entry.action, {
                    method: entry.method || "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(entry.headers || {}),
                    },
                    body: JSON.stringify(entry.payload || {}),
                    credentials: "same-origin",
                });
                if (!response.ok) {
                    remaining.push(entry);
                }
            } catch (error) {
                remaining.push(entry);
            }
        }
        writeJson(OFFLINE_FORM_QUEUE_KEY, remaining);
        await updateBadge(remaining.length);
        if (queue.length && !remaining.length) {
            showToast("Queued actions synced.");
        }
    }

    async function queueOfflineForm(form) {
        const queue = readJson(OFFLINE_FORM_QUEUE_KEY, []);
        queue.push({
            action: form.action || window.location.href,
            method: (form.method || "POST").toUpperCase(),
            payload: serializeForm(form),
            createdAt: Date.now(),
        });
        writeJson(OFFLINE_FORM_QUEUE_KEY, queue);
        haptic("success");
        showToast("Saved offline. It will sync when you're back online.");
        await updateBadge(queue.length);
    }

    function bindOfflineForms() {
        document.querySelectorAll("form[data-offline-form='true']").forEach((form) => {
            if (form.dataset.offlineBound === "true") return;
            form.dataset.offlineBound = "true";
            form.addEventListener("submit", async (event) => {
                if (navigator.onLine) return;
                event.preventDefault();
                await queueOfflineForm(form);
            });
        });
    }

    function warmImportantLinks() {
        return;
        if (!ensureAppSettings().smartPreload) return;
        if (deferredPreloadFired) return;
        deferredPreloadFired = true;
        const urls = Array.from(document.querySelectorAll("a[href^='/']"))
            .map((link) => link.getAttribute("href"))
            .filter(Boolean)
            .filter((href) => !href.startsWith("/api/") && !href.startsWith("/title/") && !href.startsWith("/search/"))
            .slice(0, 3);
        if (!urls.length || !navigator.serviceWorker?.controller) return;
        navigator.serviceWorker.controller.postMessage({
            type: "WARM_URLS",
            urls,
        });
    }

    function bindHaptics() {
        document.addEventListener("pointerdown", (event) => {
            const target = event.target instanceof Element ? event.target.closest(HAPTIC_SELECTORS) : null;
            if (!target) return;
            haptic(target.hasAttribute("data-haptic-strong") ? "medium" : "light");
        }, { passive: true });
    }

    function submitSearchForm(form) {
        if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
            return;
        }
        form.submit();
    }

    function normalizeSearchQuery(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function readSearchHistory() {
        return readJson(SEARCH_HISTORY_STORAGE_KEY, [])
            .map((entry) => normalizeSearchQuery(entry))
            .filter(Boolean);
    }

    function writeSearchHistory(items) {
        writeJson(
            SEARCH_HISTORY_STORAGE_KEY,
            items
                .map((entry) => normalizeSearchQuery(entry))
                .filter(Boolean)
                .slice(0, SEARCH_HISTORY_LIMIT)
        );
    }

    function saveSearchHistory(query) {
        const normalizedQuery = normalizeSearchQuery(query);
        if (!normalizedQuery) return;
        const history = readSearchHistory().filter((entry) => entry.toLowerCase() !== normalizedQuery.toLowerCase());
        writeSearchHistory([normalizedQuery, ...history]);
    }

    function deleteSearchHistory(query) {
        const normalizedQuery = normalizeSearchQuery(query);
        if (!normalizedQuery) return;
        writeSearchHistory(
            readSearchHistory().filter((entry) => entry.toLowerCase() !== normalizedQuery.toLowerCase())
        );
    }

    function clearSearchHistory() {
        writeSearchHistory([]);
    }

    function hideSearchBox(box) {
        if (!box) return;
        box.classList.remove("visible", "has-history");
        box.innerHTML = "";
    }

    function renderSearchHistory(form, input, box, options = {}) {
        if (!form || !input || !box) return;
        const history = readSearchHistory();
        const query = normalizeSearchQuery(input.value);
        const shouldFilter = Boolean(options.filterWithQuery);
        const filteredHistory = shouldFilter && query.length
            ? history.filter((entry) => entry.toLowerCase().includes(query.toLowerCase()))
            : history;
        if (!filteredHistory.length) {
            hideSearchBox(box);
            return;
        }

        box.innerHTML = `
            <div class="suggest-history-head">
                <span>Recent searches</span>
                <button class="suggest-history-clear" type="button" data-search-history-clear="true">Clear all</button>
            </div>
            ${filteredHistory.map((entry) => `
                <div class="suggest-history-row">
                    <button class="suggest-history-action" type="button" data-search-history-run="${escapeHtml(entry)}">
                        <span class="suggest-history-icon" aria-hidden="true">↺</span>
                        <span class="suggest-history-copy">
                            <span class="suggest-history-query">${escapeHtml(entry)}</span>
                            <span class="suggest-history-note">Search again</span>
                        </span>
                    </button>
                    <button class="suggest-history-delete" type="button" aria-label="Delete search history item" title="Delete" data-search-history-delete="${escapeHtml(entry)}">×</button>
                </div>
            `).join("")}
        `;
        box.classList.add("visible", "has-history");
    }

    function bindSearchHistory() {
        document.querySelectorAll(".js-search-form").forEach((form) => {
            if (form.dataset.searchHistoryBound === "true") return;
            form.dataset.searchHistoryBound = "true";

            const input = form.querySelector(".js-search-input");
            const box = form.querySelector(".js-suggest-box");
            if (!input || !box) return;

            form.addEventListener("submit", () => {
                saveSearchHistory(input.value);
            });

            input.addEventListener("focus", () => {
                renderSearchHistory(form, input, box, { filterWithQuery: false });
            });

            input.addEventListener("click", () => {
                renderSearchHistory(form, input, box, { filterWithQuery: false });
            });

            input.addEventListener("input", () => {
                if (normalizeSearchQuery(input.value).length < 2) {
                    window.setTimeout(() => renderSearchHistory(form, input, box, { filterWithQuery: false }), 0);
                    return;
                }
                box.classList.remove("has-history");
            });

            box.addEventListener("click", (event) => {
                const clearButton = event.target instanceof Element ? event.target.closest("[data-search-history-clear]") : null;
                if (clearButton) {
                    event.preventDefault();
                    clearSearchHistory();
                    hideSearchBox(box);
                    return;
                }

                const deleteButton = event.target instanceof Element ? event.target.closest("[data-search-history-delete]") : null;
                if (deleteButton) {
                    event.preventDefault();
                    const query = deleteButton.getAttribute("data-search-history-delete") || "";
                    deleteSearchHistory(query);
                    renderSearchHistory(form, input, box, { filterWithQuery: false });
                    return;
                }

                const runButton = event.target instanceof Element ? event.target.closest("[data-search-history-run]") : null;
                if (runButton) {
                    event.preventDefault();
                    const query = runButton.getAttribute("data-search-history-run") || "";
                    input.value = query;
                    saveSearchHistory(query);
                    submitSearchForm(form);
                }
            });
        });
    }

    function bindVoiceSearch() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        let activeRecognition = null;
        let activeButton = null;

        function normalizeTranscript(value) {
            return String(value || "").replace(/\s+/g, " ").trim();
        }

        document.querySelectorAll(".js-search-form").forEach((form) => {
            if (form.dataset.voiceSearchBound === "true") return;
            form.dataset.voiceSearchBound = "true";
            const button = form.querySelector(".js-voice-search-button");
            const input = form.querySelector(".js-search-input");
            if (!button || !input) return;
            if (!SpeechRecognition) {
                button.classList.add("is-unavailable");
                button.addEventListener("click", () => {
                    showToast("Voice search works in Chrome or Edge with microphone access.");
                });
                return;
            }

            let recognition = null;
            let isListening = false;
            let finalTranscript = "";
            let bestTranscript = "";
            let heardSpeech = false;
            let recognitionHadError = false;
            let startTimer = null;
            let networkErrorRetries = 0;

            function setIdle() {
                isListening = false;
                window.clearTimeout(startTimer);
                button.classList.remove("is-listening");
                button.setAttribute("aria-label", "Search with your voice");
                button.title = "Search with your voice";
                if (activeRecognition === recognition) activeRecognition = null;
                if (activeButton === button) activeButton = null;
            }

            function setInputFromSpeech(value) {
                const transcript = normalizeTranscript(value);
                if (!transcript) return "";
                input.value = transcript;
                input.focus({ preventScroll: true });
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
                return transcript;
            }

            async function requestMicrophoneAccess() {
                if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) return true;
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    stream.getTracks().forEach((track) => track.stop());
                    return true;
                } catch (error) {
                    showToast("Allow microphone access to use voice search.");
                    return false;
                }
            }

            function createRecognition() {
                const nextRecognition = new SpeechRecognition();
                nextRecognition.lang = document.documentElement.lang || navigator.language || "en-US";
                nextRecognition.continuous = false;
                nextRecognition.interimResults = true;
                nextRecognition.maxAlternatives = 1;

                nextRecognition.onstart = () => {
                    isListening = true;
                    finalTranscript = "";
                    bestTranscript = "";
                    heardSpeech = false;
                    recognitionHadError = false;
                    button.classList.add("is-listening");
                    button.setAttribute("aria-label", "Listening");
                    showToast("Listening...");
                    startTimer = window.setTimeout(() => {
                        if (isListening && !heardSpeech) {
                            showToast("Still listening. Speak clearly near your microphone.");
                        }
                    }, 3500);
                };
                nextRecognition.onspeechstart = () => {
                    heardSpeech = true;
                };
                nextRecognition.onresult = (event) => {
                    let interimTranscript = "";
                    for (let index = event.resultIndex; index < event.results.length; index += 1) {
                        const transcript = event.results[index][0]?.transcript || "";
                        if (event.results[index].isFinal) {
                            finalTranscript = normalizeTranscript(`${finalTranscript} ${transcript}`);
                        } else {
                            interimTranscript = normalizeTranscript(`${interimTranscript} ${transcript}`);
                        }
                    }
                    bestTranscript = setInputFromSpeech(finalTranscript || interimTranscript) || bestTranscript;
                };
                nextRecognition.onerror = (event) => {
                    recognitionHadError = true;
                    setIdle();
                    const errorName = event.error || "";
                    if (errorName === "not-allowed" || errorName === "service-not-allowed") {
                        showToast("Microphone access is blocked. Enable it in your browser settings.");
                    } else if (errorName === "no-speech") {
                        showToast("No speech detected. Tap the mic and try again.");
                    } else if (errorName === "audio-capture") {
                        showToast("No microphone was found.");
                    } else if (errorName === "network") {
                        const query = setInputFromSpeech(finalTranscript || bestTranscript || input.value);
                        if (query) {
                            submitSearchForm(form);
                        } else if (navigator.onLine === false) {
                            showToast("Voice search needs an internet connection.");
                        } else if (networkErrorRetries < 2) {
                            networkErrorRetries += 1;
                            showToast("Voice search had a quick service hiccup. Retrying...");
                            window.setTimeout(startRecognition, 450);
                        } else {
                            showToast("Voice search could not reach the browser speech service. Tap the mic to try again.");
                        }
                    } else if (errorName !== "aborted") {
                        showToast("Voice search stopped. Tap the mic to try again.");
                    }
                };
                nextRecognition.onend = () => {
                    setIdle();
                    if (recognitionHadError) return;
                    const query = setInputFromSpeech(finalTranscript || bestTranscript || input.value);
                    if (!query) return;
                    submitSearchForm(form);
                };
                return nextRecognition;
            }

            function startRecognition() {
                recognition = createRecognition();
                activeRecognition = recognition;
                activeButton = button;
                try {
                    recognition.start();
                } catch (error) {
                    setIdle();
                    showToast("Voice search is already starting. Try again in a moment.");
                }
            }

            button.addEventListener("click", async () => {
                networkErrorRetries = 0;
                if (isListening && recognition) {
                    recognition.stop();
                    return;
                }
                if (activeRecognition && activeButton && activeButton !== button) {
                    activeRecognition.abort();
                }
                if (!window.isSecureContext && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
                    showToast("Voice search needs HTTPS so the browser can use your microphone.");
                    return;
                }
                const hasMic = await requestMicrophoneAccess();
                if (!hasMic) return;
                startRecognition();
            });
        });
    }

    function bindClipboardActions() {
        document.addEventListener("click", async (event) => {
            const target = event.target instanceof Element ? event.target.closest("[data-copy-text]") : null;
            if (!target) return;
            event.preventDefault();
            await copyText(target.getAttribute("data-copy-text") || "");
        });
    }

    function bindNavigationLoader() {
        function isPrimaryNavigationEvent(event) {
            return !event.defaultPrevented
                && !event.metaKey
                && !event.ctrlKey
                && !event.shiftKey
                && !event.altKey
                && (typeof event.button !== "number" || event.button === 0);
        }

        function resolveInternalLink(target) {
            const link = target instanceof Element ? target.closest("a[href]") : null;
            if (!link) return null;
            if (link.hasAttribute("data-no-loader")) return null;
            if (link.target && link.target !== "_self") return null;
            if (link.hasAttribute("download")) return null;

            const href = link.getAttribute("href") || "";
            if (!href || href.startsWith("#") || href.startsWith("javascript:")) return null;

            try {
                const nextUrl = new URL(href, window.location.href);
                if (nextUrl.origin !== window.location.origin) return null;
                return link;
            } catch (error) {
                return null;
            }
        }

        function showNavigationLoader(title = "Opening", text = "Loading the next screen.") {
            return;
        }

        document.addEventListener("click", (event) => {
            if (!isPrimaryNavigationEvent(event)) return;
            const link = resolveInternalLink(event.target);
            if (!link) return;
            showNavigationLoader();
        }, true);

        document.addEventListener("submit", (event) => {
            const form = event.target instanceof HTMLFormElement ? event.target : null;
            if (!form || form.hasAttribute("data-no-loader")) return;
            const method = String(form.method || "get").toUpperCase();
            showNavigationLoader(
                method === "GET" ? "Searching" : "Submitting",
                method === "GET" ? "Getting fresh results for you." : "Sending your request."
            );
        }, true);

        window.addEventListener("pageshow", () => {});
    }

    function bindInstallPrompt() {
        window.addEventListener("beforeinstallprompt", (event) => {
            event.preventDefault();
            installPromptEvent = event;
            if (window.localStorage?.getItem(INSTALL_DISMISSED_KEY) === "true") return;
            setBarState({
                visible: true,
                title: "Install the app",
                text: "Use standalone mode, multiple home screen shortcuts, cached pages, and native-feeling navigation.",
                installVisible: true,
            });
            syncInstallButtons();
        });

        async function handleInstallClick() {
            if (isStandaloneMode()) {
                showToast("The app is already installed on this device.");
                return;
            }
            if (!installPromptEvent) {
                showToast("Use your browser menu and choose Install App or Add to Home Screen.");
                return;
            }
            await installPromptEvent.prompt();
            const choice = await installPromptEvent.userChoice.catch(() => null);
            if (choice?.outcome === "accepted") {
                haptic("success");
                showToast("App install started. After install, long-press the app icon to see quick actions.");
                setBarState({
                    visible: true,
                    title: "App install in progress",
                    text: "Once installed, open it from your home screen and long-press the icon for quick actions.",
                    installVisible: false,
                });
            }
            installPromptEvent = null;
            syncInstallButtons();
        }

        INSTALL_BUTTON?.addEventListener("click", handleInstallClick);
        INSTALL_BUTTONS.forEach((button) => {
            button.addEventListener("click", handleInstallClick);
        });

        window.addEventListener("appinstalled", () => {
            haptic("success");
            showToast("App installed.");
            setBarState({
                visible: true,
                title: "Installed",
                text: "The app can now launch in standalone mode with offline support and shortcut actions.",
                installVisible: false,
            });
            syncInstallButtons();
        });
    }

    function bindNotificationButton() {
        NOTIFY_BUTTON?.addEventListener("click", async () => {
            const permission = await requestNotificationPermission();
            if (permission === "granted") {
                await showNotification("Free Movies App", {
                    body: "Notifications are ready. You'll see updates here when supported.",
                    actions: [
                        { action: "open-home", title: "Open app" },
                        { action: "open-live-tv", title: "Live TV" },
                    ],
                    data: { url: window.location.pathname },
                });
                setBarState({
                    visible: true,
                    title: "Notifications enabled",
                    text: "Action buttons, persistent alerts, and badges will work where your browser supports them.",
                    installVisible: Boolean(installPromptEvent),
                });
                await scanContentAlerts();
                scheduleContentAlertScans();
            }
        });
    }

    async function maybePromptForNotificationsOnVisit() {
        if (!readAppSettings().autoNotificationPrompt) return;
        if (!navigator.onLine) return;
        if (!("Notification" in window)) return;
        if (Notification.permission !== "default") return;
        window.setTimeout(() => {
            requestNotificationPermission().catch(() => {});
        }, 1200);
    }

    function setupOnlineState() {
        const refreshState = () => {
            const notificationPermissionIsDefault = "Notification" in window && Notification.permission === "default";
            setBarState({
                visible: !navigator.onLine || Boolean(installPromptEvent) || notificationPermissionIsDefault,
                title: navigator.onLine ? "Native app tools ready" : "Offline mode active",
                text: navigator.onLine
                    ? "Install the app, enable notifications, and keep key pages available offline."
                    : "Cached pages stay available and queued actions will sync when the connection returns.",
                installVisible: Boolean(installPromptEvent),
            });
            if (navigator.onLine) {
                flushOfflineForms();
            }
        };
        window.addEventListener("online", refreshState);
        window.addEventListener("offline", refreshState);
        refreshState();
    }

    function setupViewTransitions() {
        if (!ensureAppSettings().cinematicTransitions) return;
        if (!document.startViewTransition) return;
        document.addEventListener("click", (event) => {
            const link = event.target instanceof Element ? event.target.closest("a[href^='/']") : null;
            if (!link) return;
            if (link.target && link.target !== "_self") return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const href = link.getAttribute("href");
            if (!href || href.startsWith("#")) return;
            link.dataset.prefetched = "true";
        });
    }

    function setupVisibilityPrefetch() {
        return;
        if (!ensureAppSettings().smartPreload) return;
        if (!("IntersectionObserver" in window)) return;
        const observer = new IntersectionObserver((entries) => {
            const visibleLinks = entries
                .filter((entry) => entry.isIntersecting)
                .map((entry) => entry.target.getAttribute("href"))
                .filter((href) => href && href.startsWith("/"));
            if (visibleLinks.length && navigator.serviceWorker?.controller) {
                navigator.serviceWorker.controller.postMessage({
                    type: "WARM_URLS",
                    urls: visibleLinks
                        .filter((href) => !href.startsWith("/api/") && !href.startsWith("/title/") && !href.startsWith("/search/"))
                        .slice(0, 2),
                });
            }
        }, { rootMargin: "120px" });

        document.querySelectorAll("a[href^='/']").forEach((link) => {
            observer.observe(link);
        });
    }

    function markDeferredSections() {
        return;
    }

    function setupInstallDismissal() {
        NATIVE_BAR?.addEventListener("dblclick", () => {
            if (!installPromptEvent) return;
            window.localStorage?.setItem(INSTALL_DISMISSED_KEY, "true");
            setBarState({
                visible: !navigator.onLine,
                title: "Install prompt hidden",
                text: "You can still install later from your browser menu.",
                installVisible: false,
            });
        });
    }

    async function clearCachedData() {
        if ("caches" in window) {
            const cacheKeys = await caches.keys().catch(() => []);
            await Promise.all(cacheKeys.map((key) => caches.delete(key).catch(() => false)));
        }
        showToast("Cached files cleared.");
    }

    async function clearOfflineQueue() {
        writeJson(OFFLINE_FORM_QUEUE_KEY, []);
        writeJson(NOTIFICATION_SCHEDULE_KEY, []);
        await updateBadge(0);
        showToast("Queued actions cleared.");
    }

    function clearLocalAppData() {
        if (!canUseStorage()) return;
        const exactKeys = new Set([
            APP_SETTINGS_KEY,
            OFFLINE_FORM_QUEUE_KEY,
            NOTIFICATION_SCHEDULE_KEY,
            INSTALL_DISMISSED_KEY,
            CONTENT_ALERT_STATE_KEY,
            LIKED_TITLES_STORAGE_KEY,
        ]);
        const fragments = [
            "homepage",
            "provider_catalog",
            "loopPlay",
            "liked",
            "favorites",
            "seen",
            "two-step",
            "streamPreference",
            "progress",
            "manga",
        ];
        Object.keys(window.localStorage).forEach((key) => {
            if (exactKeys.has(key) || key.startsWith(`${APP_NAMESPACE}:`) || fragments.some((fragment) => key.includes(fragment))) {
                window.localStorage.removeItem(key);
            }
        });
        ensureAppSettings();
        writeSharedJson(CONTENT_ALERT_STATE_URL, {
            primed: false,
            unseen_count: 0,
            trending: {},
            liked: {},
            last_scan_at: 0,
        }).catch(() => {});
        syncContentAlertPreferences().catch(() => {});
        showToast("Local app data cleared.");
    }

    async function clearAllAppData() {
        clearLocalAppData();
        await clearOfflineQueue();
        await clearCachedData();
        showToast("App data reset complete.");
    }

    async function getDiagnostics() {
        const queue = readJson(OFFLINE_FORM_QUEUE_KEY, []);
        const scheduledNotifications = readJson(NOTIFICATION_SCHEDULE_KEY, []);
        const contentAlerts = await readContentAlertState();
        const storageEstimate = await navigator.storage?.estimate?.().catch(() => null);
        const pushSubscription = await getPushSubscriptionSnapshot();
        return {
            notificationPermission: "Notification" in window ? Notification.permission : "unsupported",
            standalone: isStandaloneMode(),
            online: navigator.onLine,
            settings: ensureAppSettings(),
            lockedSettings: Array.from(LOCKED_ON_SETTINGS),
            queuedForms: queue.length,
            scheduledNotifications: scheduledNotifications.length,
            unseenAlerts: Number(contentAlerts.unseen_count || 0),
            likedTitles: readLikedTitles().length,
            pushSubscribed: Boolean(pushSubscription?.endpoint),
            storageEstimate,
        };
    }

    function exposeApi() {
        window.FreemovieApp = {
            haptic,
            vibrate,
            copyText,
            readClipboardText,
            requestNotificationPermission,
            showNotification,
            scheduleNotification,
            ensurePushSubscription,
            unsubscribePushNotifications,
            sendTestPush,
            startMotionSensors,
            getBatteryStatus,
            requestBluetoothDevice,
            updateBadge,
            flushOfflineForms,
            scanContentAlerts,
            clearContentAlertBadge,
            refreshBackgroundServices,
            readAppSettings,
            writeAppSettings,
            ensureAppSettings,
            lockedSettings: Array.from(LOCKED_ON_SETTINGS),
            clearCachedData,
            clearOfflineQueue,
            clearLocalAppData,
            clearAllAppData,
            getDiagnostics,
            showLoader,
            hideLoader,
            pulseLoader,
        };
    }

    document.addEventListener("DOMContentLoaded", async () => {
        domReadyAt = Date.now();
        ensureAppSettings();
        syncInstallButtons();
        bindHaptics();
        bindSearchHistory();
        bindVoiceSearch();
        bindClipboardActions();
        bindOfflineForms();
        installFetchLoader();
        bindInstallPrompt();
        bindNotificationButton();
        bindNavigationLoader();
        setupOnlineState();
        setupViewTransitions();
        setupVisibilityPrefetch();
        setupInstallDismissal();
        markDeferredSections();
        exposeApi();
        await registerServiceWorker();
        await syncContentAlertPreferences().catch(() => {});
        scheduleContentAlertScans();
        maybePromptForNotificationsOnVisit();
        if ("requestIdleCallback" in window) {
            window.requestIdleCallback(() => flushScheduledNotifications(), { timeout: 5000 });
        } else {
            window.setTimeout(flushScheduledNotifications, 2500);
        }
        if (ensureAppSettings().smartPreload) {
            window.setTimeout(warmImportantLinks, 1800);
            if ("requestIdleCallback" in window) {
                window.requestIdleCallback(warmImportantLinks, { timeout: 5000 });
            }
        }
    });
})();
