(function () {
    "use strict";

    const configuredRoot = String(window.__FM_STATIC_ROOT__ || "./");
    const rootUrl = new URL(configuredRoot, window.location.href);
    const basePath = rootUrl.pathname.replace(/\/$/, "");
    const isFileProtocol = window.location.protocol === "file:";
    const originalFetch = window.fetch.bind(window);
    const localPrefix = "freemovie:static:";
    const tmdbApiKey = "aca4b5488125d1293e96c997ae62296d";
    let liveCatalogPromise = null;

    // Keep exported Django title pages intact. They contain the complete
    // copied player UI (audio, downloads, favorites, custom server picker,
    // episodes, cast and recommendations). Live-search results are already
    // emitted as /title/index.html and use the generic fallback shell.
    function genericTitleRoute(value) {
        return "";
    }

    function withBase(value) {
        const genericRoute = genericTitleRoute(value);
        if (genericRoute) return genericRoute;
        if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return value;
        if (isFileProtocol) {
            const target = new URL(value.replace(/^\/+/, ""), rootUrl);
            if (target.pathname.endsWith("/")) target.pathname += "index.html";
            return target.href;
        }
        if (basePath && (value === basePath || value.startsWith(basePath + "/"))) return value;
        return `${basePath}${value}` || value;
    }

    function navigableUrl(value) {
        const genericRoute = genericTitleRoute(value);
        if (genericRoute) return genericRoute;
        if (!isFileProtocol || value.startsWith("/")) return withBase(value);
        const target = new URL(value, window.location.href);
        if (target.pathname.endsWith("/")) target.pathname += "index.html";
        return target.href;
    }

    window.__fmStaticNavigate = function (value) {
        window.location.href = withBase(String(value || "/"));
    };

    function titleSlug(value) {
        return String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    }

    function exportedDetailUrl(item) {
        const current = String(item && item.detail_url || "");
        const type = String(item && item.type || "").toLowerCase();
        const allowed = { movie: "movie", series: "series", tv: "series", anime: "anime", manga: "manga", cartoon: "cartoon" };
        if (!allowed[type] || !current.includes("/title/index.html")) return current;
        const slug = titleSlug(item.title);
        if (!slug) return current;
        const query = current.includes("?") ? current.slice(current.indexOf("?")) : "";
        return "/title/" + allowed[type] + "/" + slug + "/index.html" + query;
    }

    function normalizeCatalogLinks(value) {
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) {
            value.forEach(normalizeCatalogLinks);
            return value;
        }
        if (typeof value.detail_url === "string") value.detail_url = exportedDetailUrl(value);
        ["detail_url", "secondary_url", "browse_url", "url"].forEach(function (key) {
            if (typeof value[key] === "string" && value[key].startsWith("/") && !value[key].startsWith("//")) {
                value[key] = withBase(value[key]);
            }
        });
        Object.keys(value).forEach(function (key) {
            if (value[key] && typeof value[key] === "object") normalizeCatalogLinks(value[key]);
        });
        return value;
    }

    window.__fmStaticNormalizeCatalogLinks = normalizeCatalogLinks;
    normalizeCatalogLinks(window.__FM_CATALOG__);

    function requestUrl(input) {
        if (typeof input === "string") return withBase(input);
        if (input instanceof URL) return new URL(withBase(input.pathname + input.search + input.hash), location.origin);
        if (input instanceof Request) return new Request(withBase(new URL(input.url).pathname + new URL(input.url).search), input);
        return input;
    }

    function jsonResponse(payload, status) {
        return new Response(JSON.stringify(payload), {
            status: status || 200,
            headers: { "Content-Type": "application/json; charset=utf-8" }
        });
    }

    function readJson(key, fallback) {
        try { return JSON.parse(localStorage.getItem(localPrefix + key) || "null") ?? fallback; }
        catch (_) { return fallback; }
    }

    function writeJson(key, value) {
        try { localStorage.setItem(localPrefix + key, JSON.stringify(value)); } catch (_) {}
    }

    function normalizeTmdbItem(item) {
        const mediaType = item.media_type === "tv" ? "series" : "movie";
        const title = item.title || item.name || "Untitled";
        const year = String(item.release_date || item.first_air_date || "").slice(0, 4);
        return {
            id: String(item.id || ""), tmdb_id: String(item.id || ""), title: title,
            year: year, type: mediaType, rating: item.vote_average ? Number(item.vote_average).toFixed(1) : "",
            poster: item.poster_path ? "https://image.tmdb.org/t/p/w342" + item.poster_path : "https://placehold.co/600x900/111827/e5e7eb?text=No+Poster",
            backdrop: item.backdrop_path ? "https://image.tmdb.org/t/p/w780" + item.backdrop_path : "",
            plot: item.overview || "", source: "tmdb", source_label: "TMDb",
            detail_url: withBase("/title/index.html") + "?title=" + encodeURIComponent(title) + "&tmdb_id=" + encodeURIComponent(item.id || "") + "&media_type=" + mediaType + "&source=tmdb"
        };
    }

    function localCatalogItems() {
        const rows = (window.__FM_CATALOG__ && window.__FM_CATALOG__.content_rows) || [];
        const seen = new Set();
        const items = [];
        rows.forEach(function (row) {
            (row.items || []).forEach(function (item) {
                const key = String(item.id || item.detail_url || item.title || "");
                if (!key || seen.has(key)) return;
                seen.add(key); items.push(item);
            });
        });
        return items;
    }

    async function searchTmdb(query, limit) {
        if (!query || query.length < 2) return [];
        // Keep local anime/manga/catalog hits, then merge live TMDb results
        // so search is not limited to titles that happened to exist at build
        // time. The generic static detail page can render any returned TMDb id.
        const normalized = query.toLowerCase();
        const localMatches = localCatalogItems().filter(function (item) { return String(item.title || "").toLowerCase().includes(normalized); }).slice(0, limit || 18);
        const tmdbUrl = "https://api.themoviedb.org/3/search/multi?api_key=" + encodeURIComponent(tmdbApiKey) + "&include_adult=true&query=" + encodeURIComponent(query);
        const anilistQuery = "query($search:String){Page(page:1,perPage:12){media(search:$search,type:ANIME){id title{english romaji native}coverImage{large}seasonYear averageScore}}}";
        const mangaUrl = "https://api.mangadex.org/manga?limit=12&includes[]=cover_art&title=" + encodeURIComponent(query) + "&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica";
        const requests = await Promise.allSettled([
            originalFetch(tmdbUrl).then(function (response) { return response.ok ? response.json() : { results: [] }; }),
            originalFetch("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: anilistQuery, variables: { search: query } }) }).then(function (response) { return response.ok ? response.json() : { data: { Page: { media: [] } } }; }),
            originalFetch(mangaUrl).then(function (response) { return response.ok ? response.json() : { data: [] }; })
        ]);
        const tmdbPayload = requests[0].status === "fulfilled" ? requests[0].value : { results: [] };
        const anilistPayload = requests[1].status === "fulfilled" ? requests[1].value : { data: { Page: { media: [] } } };
        const mangaPayload = requests[2].status === "fulfilled" ? requests[2].value : { data: [] };
        const tmdbMatches = (tmdbPayload.results || []).filter(function (item) { return item.media_type === "movie" || item.media_type === "tv"; }).map(normalizeTmdbItem);
        const animeMatches = (((anilistPayload.data || {}).Page || {}).media || []).map(function (item) {
            const titles = item.title || {}, title = titles.english || titles.romaji || titles.native || "Untitled";
            return { id: "anilist-" + item.id, anilist_id: String(item.id), title: title, year: String(item.seasonYear || ""), type: "anime", rating: item.averageScore ? (item.averageScore / 10).toFixed(1) : "", poster: (item.coverImage || {}).large || "", source: "anilist", source_label: "AniList", detail_url: withBase("/title/index.html") + "?title=" + encodeURIComponent(title) + "&anilist_id=" + encodeURIComponent(item.id) + "&media_type=anime&source=anilist" };
        });
        const mangaMatches = (mangaPayload.data || []).map(function (item) {
            const attrs = item.attributes || {}, titles = attrs.title || {}, title = titles.en || Object.values(titles)[0] || "Untitled";
            const cover = (item.relationships || []).find(function (relation) { return relation.type === "cover_art"; });
            const fileName = cover && cover.attributes && cover.attributes.fileName;
            return { id: "mangadex-" + item.id, manga_id: item.id, title: title, year: String(attrs.year || ""), type: "manga", rating: "", poster: fileName ? "https://uploads.mangadex.org/covers/" + item.id + "/" + fileName + ".512.jpg" : "", source: "mangadex", source_label: "MangaDex", detail_url: withBase("/title/index.html") + "?title=" + encodeURIComponent(title) + "&manga_id=" + encodeURIComponent(item.id) + "&media_type=manga&source=mangadex" };
        });
        const seen = new Set();
        return localMatches.concat(tmdbMatches, animeMatches, mangaMatches).filter(function (item) {
            const key = [item.tmdb_id, item.anilist_id, item.manga_id, item.id].find(Boolean) || item.title;
            if (seen.has(String(key))) return false;
            seen.add(String(key));
            return true;
        }).slice(0, limit || 18);
    }

    async function searchMusic(query) {
        const url = "https://itunes.apple.com/search?media=music&entity=song&limit=24&term=" + encodeURIComponent(query || "");
        const response = await originalFetch(url);
        const payload = response.ok ? await response.json() : { results: [] };
        const tracks = (payload.results || []).map(function (item) {
            const artwork = String(item.artworkUrl100 || "").replace("100x100bb", "600x600bb");
            return {
                id: String(item.trackId || item.collectionId || item.trackName), title: item.trackName || "Untitled",
                artist: item.artistName || "", album: item.collectionName || "",
                subtitle: [item.artistName, item.collectionName].filter(Boolean).join(" • "),
                cover: artwork, backdrop: artwork, duration: "Preview", stream_url: item.previewUrl || "",
                source: "itunes", kind: "track", is_radio: false, is_preview: true,
                external_url: item.trackViewUrl || ""
            };
        }).filter(function (item) { return item.stream_url; });
        return { tracks: tracks, radios: [], sources: [{ key: "itunes", title: "Apple Music previews", available: tracks.length > 0 }] };
    }

    async function loadLiveCatalog() {
        if (window.__FM_LIVE_TV__) return window.__FM_LIVE_TV__;
        if (!liveCatalogPromise) {
            liveCatalogPromise = originalFetch(withBase("/api/live-tv/")).then(function (response) { return response.json(); });
        }
        return liveCatalogPromise;
    }

    async function localApi(url, input, init) {
        const pathname = url.pathname;
        const method = String((init && init.method) || (input instanceof Request && input.method) || "GET").toUpperCase();
        if (pathname.endsWith("/api/tracking/collect/")) return jsonResponse({ status: "ignored", static: true });
        if (pathname.endsWith("/api/homepage/")) return jsonResponse(window.__FM_CATALOG__ || { featured_items: [], content_rows: [] });
        if (pathname.includes("/api/providers/")) {
            const payload = Object.assign({}, window.__FM_CATALOG__ || { featured_items: [], content_rows: [] });
            const parts = pathname.split("/").filter(Boolean);
            const providerIndex = parts.indexOf("providers");
            const slug = providerIndex >= 0 ? (parts[providerIndex + 1] || "all") : "all";
            payload.active_provider = slug || "all";
            payload.active_provider_name = (slug || "all").replace(/-/g, " ").replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
            return jsonResponse(payload);
        }
        if (pathname.endsWith("/api/push/public-key/")) return jsonResponse({ configured: false, public_key: "" });
        if (pathname.endsWith("/api/push/subscribe/")) { writeJson("push", { subscribed: true }); return jsonResponse({ status: "local", subscribed: true }); }
        if (pathname.endsWith("/api/push/unsubscribe/")) { writeJson("push", { subscribed: false }); return jsonResponse({ status: "local", subscribed: false }); }
        if (pathname.endsWith("/api/push/test/")) return jsonResponse({ status: "local", message: "Static-site notifications stay on this device." });
        if (pathname.endsWith("/post-comment/") && method === "POST") {
            let body = {};
            try { body = JSON.parse((init && init.body) || "{}"); } catch (_) {}
            const comments = readJson("comments", []);
            const comment = { id: Date.now(), text: String(body.text || "").slice(0, 500), parent_id: body.parent_id || null, created_at: new Date().toISOString() };
            comments.push(comment); writeJson("comments", comments);
            return jsonResponse({ status: "success", comment_id: comment.id, created_at: comment.created_at });
        }
        if (pathname.endsWith("/api/search/suggest/")) {
            const items = await searchTmdb(url.searchParams.get("q") || "", 6);
            return jsonResponse({ items: items.map(function (item) { return { title: item.title, year: item.year, type: item.type, poster: item.poster, detail_url: item.detail_url, secondary_url: item.detail_url, source_label: item.source_label }; }) });
        }
        if (pathname.endsWith("/api/music/search/")) return jsonResponse(await searchMusic(url.searchParams.get("q") || ""));
        if (pathname.endsWith("/api/music/stream/")) return jsonResponse({ stream_url: url.searchParams.get("stream_url") || "", source: url.searchParams.get("source") || "local" });
        if (pathname.endsWith("/api/live-tv/")) {
            const catalog = await loadLiveCatalog();
            const query = String(url.searchParams.get("q") || "").toLowerCase();
            const country = String(url.searchParams.get("country") || "").toUpperCase();
            const category = String(url.searchParams.get("category") || "").toLowerCase();
            const page = Math.max(1, Number(url.searchParams.get("page") || 1));
            const pageSize = 24;
            const allItems = catalog.all_items || catalog.items || [];
            const filtered = allItems.filter(function (item) {
                const text = [item.name, item.country_code, item.categories && item.categories.join(" ")].join(" ").toLowerCase();
                return (!query || text.includes(query)) && (!country || String(item.country_code || "").toUpperCase() === country) && (!category || (item.categories || []).some(function (value) { return String(value).toLowerCase() === category; }));
            });
            const start = (page - 1) * pageSize;
            return jsonResponse(Object.assign({}, catalog, { items: filtered.slice(start, start + pageSize), page: page, page_size: pageSize, total: filtered.length, total_pages: Math.max(1, Math.ceil(filtered.length / pageSize)), has_next: start + pageSize < filtered.length }));
        }
        if (pathname.endsWith("/api/loop-play-item/")) {
            const mediaType = url.searchParams.get("media_type") || "movie";
            const tmdbId = url.searchParams.get("tmdb_id") || "";
            const imdbId = url.searchParams.get("imdb_id") || "";
            const sourceId = imdbId || tmdbId;
            const season = url.searchParams.get("season") || "1";
            const episode = url.searchParams.get("episode") || "1";
            const embed = mediaType === "movie" ? "https://vidsrc.in/embed/movie/" + sourceId : "https://vidsrc.in/embed/tv/" + sourceId + "/" + season + "/" + episode;
            return jsonResponse({ id: sourceId, title: url.searchParams.get("title") || "Title", type: mediaType, tmdb_id: tmdbId, imdb_id: imdbId, selected_season: season, selected_episode_number: episode, season_options: [season], episodes_map: {}, stream_servers: [{ key: "vidsrc", name: "VidSrc", url: embed, default_url: embed, fallback_urls: [embed] }] });
        }
        return null;
    }

    window.fetch = async function (input, init) {
        const nextInput = requestUrl(input);
        let parsed;
        try { parsed = new URL(typeof nextInput === "string" ? nextInput : nextInput.url, location.href); } catch (_) {}
        if (parsed) {
            const local = await localApi(parsed, input, init);
            if (local) return local;
        }
        return originalFetch(nextInput, init);
    };

    if ("serviceWorker" in navigator && navigator.serviceWorker.register) {
        const originalRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
        navigator.serviceWorker.register = function (scriptURL, options) {
            const nextOptions = Object.assign({}, options || {}, { scope: `${basePath}/` || "/" });
            return originalRegister(withBase(String(scriptURL)), nextOptions);
        };
    }

    document.addEventListener("click", function (event) {
        const anchor = event.target.closest && event.target.closest("a[href]");
        if (anchor) {
            const raw = anchor.getAttribute("href") || "";
            if (isFileProtocol && raw && !raw.startsWith("#") && !/^(?:https?:|mailto:|tel:|javascript:)/i.test(raw)) {
                anchor.setAttribute("href", navigableUrl(raw));
            } else if (raw.startsWith("/") && !raw.startsWith("//")) {
                anchor.setAttribute("href", withBase(raw));
            }
            return;
        }
        const hero = event.target.closest && event.target.closest(".hero-slide[data-detail-url]");
        if (hero && isFileProtocol) {
            event.preventDefault();
            event.stopImmediatePropagation();
            window.location.href = withBase(hero.dataset.detailUrl || "/");
        }
    }, true);

    document.addEventListener("submit", function (event) {
        const form = event.target;
        const raw = form && form.getAttribute && form.getAttribute("action");
        if (!raw) return;
        if (isFileProtocol) form.setAttribute("action", navigableUrl(raw));
        else if (raw.startsWith("/")) form.setAttribute("action", withBase(raw));
    }, true);

    // App scripts create some links after load; keep them repository-relative.
    const observer = new MutationObserver(function (records) {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!(node instanceof Element)) continue;
                const anchors = node.matches("a[href]") ? [node] : node.querySelectorAll("a[href]");
                for (const anchor of anchors) {
                    const raw = anchor.getAttribute("href") || "";
                    if (isFileProtocol && raw && !raw.startsWith("#") && !/^(?:https?:|mailto:|tel:|javascript:)/i.test(raw)) anchor.setAttribute("href", navigableUrl(raw));
                    else if (raw.startsWith("/") && !raw.startsWith("//")) anchor.setAttribute("href", withBase(raw));
                }
            }
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    function escapeHtml(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]; });
    }

    async function hydrateSearchPage() {
        const query = new URLSearchParams(location.search).get("q") || "";
        const summary = document.querySelector(".summary-card");
        if (!summary || !location.pathname.includes("/search/")) return;
        const input = document.querySelector(".js-search-input");
        if (input) input.value = query;
        if (!query) return;
        const items = await searchTmdb(query, 24);
        const heading = summary.querySelector("h1");
        const count = summary.querySelector(".summary-meta span");
        if (heading) heading.textContent = "Search Results";
        if (count) count.textContent = items.length + " matches";
        const oldGrid = document.querySelector(".results-grid, .empty-state");
        if (oldGrid) oldGrid.remove();
        const section = document.createElement("section");
        section.className = items.length ? "results-grid" : "empty-state";
        section.innerHTML = items.length ? items.map(function (item) {
            return '<article class="content-card"><a href="' + escapeHtml(item.detail_url) + '"><img class="card-poster" src="' + escapeHtml(item.poster) + '" alt="' + escapeHtml(item.title) + '" loading="lazy"><div class="card-overlay"></div><div class="card-topline"><span class="badge">' + escapeHtml(item.type) + '</span><span class="source-badge">TMDb</span></div><div class="card-body"><h3 class="card-title">' + escapeHtml(item.title) + '</h3><div class="card-meta">' + escapeHtml(item.year) + ' • ' + escapeHtml(item.type) + '</div><span class="card-button">Open</span></div></a></article>';
        }).join("") : 'No matching titles came back for "' + escapeHtml(query) + '".';
        const adPanel = document.querySelector(".ad-panel");
        (adPanel || summary).insertAdjacentElement("afterend", section);
    }

    function tmdbImage(path, size) { return path ? "https://image.tmdb.org/t/p/" + (size || "w780") + path : ""; }
    function trailerEmbed(videos) { const video = ((videos || {}).results || []).find(function (entry) { return entry.site === "YouTube" && (entry.type === "Trailer" || entry.type === "Teaser"); }); return video ? "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(video.key) : ""; }
    function tmdbStreamUrl(kind, id, season, episode) { return kind === "tv" ? "https://vidsrc.in/embed/tv/" + encodeURIComponent(id) + "/" + encodeURIComponent(season || 1) + "/" + encodeURIComponent(episode || 1) : "https://vidsrc.in/embed/movie/" + encodeURIComponent(id); }
    function animeStreamUrl(id, episode) { return "https://megaplay.buzz/stream/ani/" + encodeURIComponent(id) + "/" + encodeURIComponent(episode || 1) + "/sub"; }
    function fact(label, value) { return value ? '<div class="fact"><span class="fact-label">' + escapeHtml(label) + '</span><div class="fact-value">' + escapeHtml(value) + '</div></div>' : ""; }
    function castMarkup(cast) { return (cast || []).slice(0, 12).map(function (person) { const photo = tmdbImage(person.profile_path, "w185"); return '<article class="cast-item cast-card"><div class="cast-photo-shell">' + (photo ? '<img class="cast-photo" src="' + escapeHtml(photo) + '" alt="' + escapeHtml(person.name) + '" loading="lazy" referrerpolicy="no-referrer">' : '<div class="cast-photo-fallback">' + escapeHtml((person.name || "?").charAt(0).toUpperCase()) + '</div>') + '</div><div class="cast-name">' + escapeHtml(person.name) + '</div><div class="cast-meta">' + escapeHtml(person.character || "Cast") + '</div><a class="cast-search-link" href="' + escapeHtml(withBase('/search/index.html?q=' + encodeURIComponent(person.name || ""))) + '">Watch titles with ' + escapeHtml(person.name) + '</a></article>'; }).join(""); }
    function snapshotsMarkup(title, poster, backdrop) { return [[backdrop, "Backdrop snapshot"], [poster, "Poster snapshot"], [backdrop || poster, "Scene snapshot"]].filter(function (entry) { return entry[0]; }).map(function (entry) { return '<figure class="snapshot-card"><img src="' + escapeHtml(entry[0]) + '" alt="' + escapeHtml(title + " " + entry[1]) + '" loading="lazy"><figcaption class="snapshot-caption">' + escapeHtml(entry[1]) + '</figcaption></figure>'; }).join(""); }

    function renderStaticSeasonPicker(select) {
        const shell = document.getElementById("watchSeasonPicker"), values = Array.from(select?.options || []).map(function (option) { return String(option.value); });
        if (!document.getElementById("static-season-picker-layout")) {
            const style = document.createElement("style");
            style.id = "static-season-picker-layout";
            style.textContent = "#watchSeasonPicker.open .custom-select-menu,#watchServerPicker.open .custom-select-menu{position:relative;top:auto;bottom:auto;margin-top:10px;z-index:1}#watchSeasonPicker.open,#watchServerPicker.open{z-index:90}#watchSeasonPicker.open~*,#watchServerPicker.open~*{position:relative}";
            document.head.appendChild(style);
        }
        if (!shell || !select || !values.length) return;
        const selected = values.includes(String(select.value)) ? String(select.value) : values[0];
        shell.innerHTML = '<button class="custom-select-trigger" type="button" aria-expanded="false" aria-haspopup="listbox"><span class="custom-select-trigger-copy"><span class="custom-select-trigger-kicker">Season</span><span class="custom-select-trigger-label">Season ' + escapeHtml(selected) + '</span></span><span class="custom-select-trigger-icon" aria-hidden="true"></span></button><div class="custom-select-menu" role="listbox" aria-label="Season selector">' + values.map(function (value) { return '<button class="custom-select-option' + (value === selected ? " active" : "") + '" type="button" role="option" aria-selected="' + (value === selected ? "true" : "false") + '" data-season-option="' + escapeHtml(value) + '"><span class="custom-select-option-label">Season ' + escapeHtml(value) + '</span><span class="custom-select-option-meta">' + (value === selected ? "Currently selected" : "Tap to switch") + '</span></button>'; }).join("") + '</div>';
        const trigger = shell.querySelector(".custom-select-trigger"), close = function () { shell.classList.remove("open", "open-upward"); trigger.setAttribute("aria-expanded", "false"); };
        trigger.addEventListener("click", function (event) { event.stopPropagation(); const opening = !shell.classList.contains("open"); document.querySelectorAll(".custom-select.open").forEach(function (node) { node.classList.remove("open", "open-upward"); node.querySelector(".custom-select-trigger")?.setAttribute("aria-expanded", "false"); }); shell.classList.toggle("open", opening); trigger.setAttribute("aria-expanded", opening ? "true" : "false"); if (opening) { const bounds = trigger.getBoundingClientRect(); if (window.innerHeight - bounds.bottom < 220 && bounds.top > window.innerHeight - bounds.bottom) shell.classList.add("open-upward"); } });
        shell.querySelectorAll("[data-season-option]").forEach(function (button) { button.addEventListener("click", function () { const value = String(button.dataset.seasonOption || ""); close(); if (value && select.value !== value) { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); } }); });
        document.addEventListener("click", function (event) { if (!shell.contains(event.target)) close(); });
    }

    function renderStaticServerPicker(select) {
        const shell = document.getElementById("watchServerPicker"), values = Array.from(select?.options || []);
        if (!shell || !select || !values.length) return;
        const selected = String(select.value || values[0].value), selectedOption = values.find(function (option) { return option.value === selected; }) || values[0];
        shell.innerHTML = '<button class="custom-select-trigger" type="button" aria-expanded="false" aria-haspopup="listbox"><span class="custom-select-trigger-copy"><span class="custom-select-trigger-kicker">Server</span><span class="custom-select-trigger-label">' + escapeHtml(selectedOption.textContent) + '</span></span><span class="custom-select-trigger-icon" aria-hidden="true"></span></button><div class="custom-select-menu" role="listbox" aria-label="Server selector">' + values.map(function (option) { const active = option.value === selected; return '<button class="custom-select-option' + (active ? " active" : "") + '" type="button" role="option" aria-selected="' + active + '" data-server-option="' + escapeHtml(option.value) + '"><span class="custom-select-option-label">' + escapeHtml(option.textContent) + '</span><span class="custom-select-option-meta">' + (active ? "Currently selected" : "Switch player source") + '</span></button>'; }).join("") + '</div>';
        const trigger = shell.querySelector(".custom-select-trigger"), close = function () { shell.classList.remove("open", "open-upward"); trigger.setAttribute("aria-expanded", "false"); };
        trigger.addEventListener("click", function (event) { event.stopPropagation(); const opening = !shell.classList.contains("open"); document.querySelectorAll(".custom-select.open").forEach(function (node) { node.classList.remove("open", "open-upward"); node.querySelector(".custom-select-trigger")?.setAttribute("aria-expanded", "false"); }); shell.classList.toggle("open", opening); trigger.setAttribute("aria-expanded", opening ? "true" : "false"); });
        shell.addEventListener("click", function (event) { const button = event.target.closest("[data-server-option]"); if (!button) return; event.preventDefault(); event.stopImmediatePropagation(); const value = String(button.dataset.serverOption || ""); close(); if (value && select.value !== value) { select.value = value; shell.querySelector(".custom-select-trigger-label").textContent = button.querySelector(".custom-select-option-label").textContent; shell.querySelectorAll("[data-server-option]").forEach(function (option) { const active = option === button; option.classList.toggle("active", active); option.setAttribute("aria-selected", String(active)); const meta = option.querySelector(".custom-select-option-meta"); if (meta) meta.textContent = active ? "Currently selected" : "Switch player source"; }); select.dispatchEvent(new Event("change", { bubbles: true })); } }, true);
        document.addEventListener("click", function (event) { if (!shell.contains(event.target)) close(); });
    }

    function staticServerUrl(server, kind, id, season, episode, isAnime) {
        const safeId = encodeURIComponent(id), safeSeason = encodeURIComponent(season || 1), safeEpisode = encodeURIComponent(episode || 1);
        if (server === "megaplay") return animeStreamUrl(id, episode);
        const bases = { vsembed: "https://vsembed.ru", "vidsrc-ru": "https://vidsrc-embed.ru", "vidsrc-su": "https://vidsrc-embed.su", "111movies": "https://111movies.net", "2embed": "https://2embed.online", vidfast: "https://vidfast.pro", vidsrcmov: "https://vidsrc.mov", vidlink: "https://vidlink.pro", godrive: "https://godriveplayer.com", multiembed: "https://multiembed.mov", vidstreams: "https://vidstreams.net", vidsrcto: "https://vidsrc.to", vidsrcme: "https://vidsrcme.ru", vidsrcmeru: "https://vidsrc-me.ru", vidsrcmesu: "https://vidsrcme.su", vidsrcembedru2: "https://vidsrc-embed.ru", vidsrcembedsu2: "https://vidsrc-embed.su", vsrcsu: "https://vsrc.su", "2embedcc": "https://2embed.cc", superembed: "https://superembed.stream", vidsrccc: "https://vidsrc.cc", embedsu: "https://embed.su", vidplay: "https://vidplay.online", vidsrcdev: "https://vidsrc.dev", vidsrcwin: "https://vidsrc.win", vidsrcvip: "https://vidsrc.wiki", fsapi: "https://fsapi.xyz", "2embedskin": "https://2embed.skin", kimostream: "https://embed.kimostream.eu.org", curtstream: "https://curtstream.com", moviewp: "https://moviewp.com", vidplaypro: "https://vidplay.pro", streamwish: "https://streamwish.com", mycloudplayer: "https://mycloudplayer.com", vidsrcin: "https://vidsrc.in" };
        if (isAnime) {
            const base = bases[server] || "https://vidsrc.in";
            if (server === "vidsrcmov") return base + "/embed/tv/" + safeId + "/" + safeSeason + "/" + safeEpisode;
            if (server === "111movies" || server === "vidlink" || server === "vidfast" || server === "fsapi") return base + "/tv/" + safeId + "/" + safeSeason + "/" + safeEpisode + (server === "vidfast" ? "?autoPlay=true" : "");
            if (server === "vidsrcme" || server === "vidsrcmeru" || server === "vidsrcmesu" || server === "vsrcsu") return base + "/embed/anime/" + safeId + "/" + safeEpisode + "/0";
            if (server === "godrive") return base + "/player.php?type=series&tmdb=" + safeId + "&season=" + safeSeason + "&episode=" + safeEpisode;
            if (server === "multiembed") return base + "/?video_id=" + safeId + "&s=" + safeSeason + "&e=" + safeEpisode;
            if (server === "vidstreams") return base + "/embed/tvd" + safeId + "/" + safeSeason + "/" + safeEpisode + "/";
            if (server === "vidsrccc") return base + "/v2/embed/tv/" + safeId + "/" + safeSeason + "/" + safeEpisode;
            return base + "/embed/tv?tmdb=" + safeId + "&season=" + safeSeason + "&episode=" + safeEpisode;
        }
        if (server === "vidsrc" || server === "vidsrcin") return tmdbStreamUrl(kind, id, season, episode);
        const base = bases[server] || "https://vidsrc.in";
        const media = kind === "tv" ? "tv" : "movie";
        if (server === "vidsrcmov") return base + "/embed/" + media + "/" + safeId + (kind === "tv" ? "/" + safeSeason + "/" + safeEpisode : "");
        if (server === "vidlink" || server === "111movies" || server === "vidfast" || server === "fsapi") return base + "/" + media + "/" + safeId + (kind === "tv" ? "/" + safeSeason + "/" + safeEpisode : "") + (server === "vidfast" ? "?autoPlay=true" : "");
        if (server === "vidsrcme" || server === "vidsrcmeru" || server === "vidsrcmesu" || server === "vsrcsu") return base + "/embed/" + media + "/" + safeId + (kind === "tv" ? "/" + safeSeason + "/" + safeEpisode : "");
        if (server === "godrive") return base + "/player.php?type=" + media + "&tmdb=" + safeId + (kind === "tv" ? "&season=" + safeSeason + "&episode=" + safeEpisode : "");
        if (server === "multiembed") return base + "/?video_id=" + safeId + (kind === "tv" ? "&s=" + safeSeason + "&e=" + safeEpisode : "");
        if (server === "vidstreams") return base + "/embed/" + media + "/" + safeId + (kind === "tv" ? "/" + safeSeason + "/" + safeEpisode : "");
        if (server === "vidsrccc") return base + "/v2/embed/" + media + "/" + safeId + (kind === "tv" ? "/" + safeSeason + "/" + safeEpisode : "");
        return base + "/embed/" + media + "?tmdb=" + safeId + (kind === "tv" ? "&season=" + safeSeason + "&episode=" + safeEpisode : "");
    }

    function applyAudioMode(streamUrl, audio) {
        if (!streamUrl) return streamUrl;
        try {
            const target = new URL(streamUrl);
            if (!audio || audio === "default") { target.searchParams.delete("dub"); return target.href; }
            target.searchParams.set("dub", audio === "dub" ? "1" : "0");
            return target.href;
        } catch (_) {
            if (!audio || audio === "default") return streamUrl;
            return streamUrl + (streamUrl.includes("?") ? "&" : "?") + "dub=" + (audio === "dub" ? "1" : "0");
        }
    }

    async function hydrateGenericTitle() {
        if (!location.pathname.endsWith("/title/index.html")) return;
        const params = new URLSearchParams(location.search);
        const param = function (name) { return params.get(name) || params.get(name.replace("_", "\\_")) || ""; };
        const tmdbId = param("tmdb_id"), mangaId = param("manga_id"), anilistId = param("anilist_id");
        const kind = param("media_type") === "series" || param("media_type") === "tv" ? "tv" : "movie";
        if (!tmdbId && !mangaId && !anilistId) return;
        const fallback = localCatalogItems().find(function (entry) { return (tmdbId && String(entry.tmdb_id || "") === tmdbId) || (mangaId && String(entry.manga_id || "") === mangaId) || (anilistId && String(entry.anilist_id || "") === anilistId); }) || {};
        let title = fallback.title || param("title") || "Title", plot = fallback.plot || "", poster = fallback.poster || "", backdrop = fallback.backdrop || poster, detail = null, seasonData = null, animeEpisodes = [], mangaChapters = [];
        let selectedSeason = Math.max(1, Number(param("season") || 1)), selectedEpisode = Math.max(1, Number(param("episode") || 1));
        try {
            if (tmdbId) {
                const response = await originalFetch("https://api.themoviedb.org/3/" + kind + "/" + encodeURIComponent(tmdbId) + "?api_key=" + encodeURIComponent(tmdbApiKey) + "&append_to_response=credits,videos");
                if (!response.ok) throw new Error("TMDb detail failed"); detail = await response.json(); title = detail.title || detail.name || title; plot = detail.overview || plot; poster = tmdbImage(detail.poster_path, "w500") || poster; backdrop = tmdbImage(detail.backdrop_path, "original") || poster || backdrop;
                if (kind === "tv") { const seasons = (detail.seasons || []).filter(function (season) { return Number(season.season_number) > 0; }); if (!seasons.some(function (season) { return Number(season.season_number) === selectedSeason; })) selectedSeason = Number(seasons[0] && seasons[0].season_number) || 1; const seasonResponse = await originalFetch("https://api.themoviedb.org/3/tv/" + encodeURIComponent(tmdbId) + "/season/" + selectedSeason + "?api_key=" + encodeURIComponent(tmdbApiKey)); if (seasonResponse.ok) seasonData = await seasonResponse.json(); const episodes = (seasonData || {}).episodes || []; if (!episodes.some(function (episode) { return Number(episode.episode_number) === selectedEpisode; })) selectedEpisode = Number(episodes[0] && episodes[0].episode_number) || 1; }
            } else if (mangaId) {
                const response = await originalFetch("https://api.mangadex.org/manga/" + encodeURIComponent(mangaId) + "?includes[]=cover_art"); if (!response.ok) throw new Error("MangaDex detail failed"); detail = (await response.json()).data || {}; const attrs = detail.attributes || {}, titles = attrs.title || {}, descriptions = attrs.description || {}; title = titles.en || Object.values(titles)[0] || title; plot = descriptions.en || Object.values(descriptions)[0] || plot; const cover = (detail.relationships || []).find(function (relation) { return relation.type === "cover_art"; }); const fileName = cover && cover.attributes && cover.attributes.fileName; poster = fileName ? "https://uploads.mangadex.org/covers/" + mangaId + "/" + fileName + ".512.jpg" : poster; backdrop = poster || backdrop; const chaptersResponse = await originalFetch("https://api.mangadex.org/manga/" + encodeURIComponent(mangaId) + "/feed?translatedLanguage[]=en&order[chapter]=desc&limit=24"); if (chaptersResponse.ok) mangaChapters = ((await chaptersResponse.json()).data || []).map(function (chapter) { const chapterAttrs = chapter.attributes || {}; const number = chapterAttrs.chapter || ""; return { id: chapter.id, title: (number ? "Chapter " + number : "Chapter") + (chapterAttrs.title ? ": " + chapterAttrs.title : ""), released: String(chapterAttrs.publishAt || "").slice(0, 10) }; });
            } else {
                const query = "query($id:Int){Media(id:$id,type:ANIME){title{english romaji native}description bannerImage coverImage{extraLarge large}episodes averageScore genres status seasonYear}}"; const response = await originalFetch("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: query, variables: { id: Number(anilistId) } }) }); if (!response.ok) throw new Error("AniList detail failed"); detail = (await response.json()).data.Media || {}; title = detail.title.english || detail.title.romaji || detail.title.native || title; plot = String(detail.description || plot).replace(/<[^>]+>/g, ""); poster = detail.coverImage.extraLarge || detail.coverImage.large || poster; backdrop = detail.bannerImage || poster || backdrop; animeEpisodes = Array.from({ length: Math.max(0, Number(detail.episodes) || 0) }, function (_, index) { return { episode_number: index + 1, name: "Episode " + (index + 1), still_path: "" }; }); if (!animeEpisodes.some(function (episode) { return Number(episode.episode_number) === selectedEpisode; })) selectedEpisode = Number(animeEpisodes[0] && animeEpisodes[0].episode_number) || 1;
            }
        } catch (_) { detail = detail || fallback; }
        document.title = title + " | Free movie";
        const hero = document.querySelector(".hero"), stack = document.querySelector(".page-stack"); if (!hero || !stack) return;
        const rating = tmdbId && detail ? (detail.vote_average ? Number(detail.vote_average).toFixed(1) : "—") : (detail && detail.averageScore ? (detail.averageScore / 10).toFixed(1) : "—");
        const year = tmdbId && detail ? String((detail.first_air_date || detail.release_date || "").slice(0, 4)) : String((detail && detail.seasonYear) || fallback.year || "");
        const genres = tmdbId && detail ? (detail.genres || []).map(function (genre) { return genre.name; }).join(", ") : ((detail && detail.genres) || []).join(", ");
        const trailer = tmdbId && detail ? trailerEmbed(detail.videos) : "", cast = tmdbId && detail ? ((detail.credits || {}).cast || []) : [], runtime = tmdbId && detail ? (kind === "tv" ? ((detail.episode_run_time || [])[0] ? detail.episode_run_time[0] + " min / episode" : "") : (detail.runtime ? detail.runtime + " min" : "")) : "";
        const isAnime = Boolean(anilistId), seasons = kind === "tv" && detail ? (detail.seasons || []).filter(function (season) { return Number(season.season_number) > 0; }) : (isAnime ? [{ season_number: 1 }] : []), episodes = isAnime ? animeEpisodes : ((seasonData || {}).episodes || []);
        const contentType = kind === "tv" ? "Series" : (mangaId ? "Manga" : anilistId ? "Anime" : "Movie");
        hero.innerHTML = '<div class="hero-backdrop" aria-hidden="true" style="background-image:linear-gradient(90deg,rgba(0,0,0,.88),rgba(0,0,0,.2)),url(\'' + escapeHtml(backdrop).replace(/&#39;/g, "%27") + '\')"></div><div class="hero-inner"><div class="poster-card">' + (poster ? '<img src="' + escapeHtml(poster) + '" alt="' + escapeHtml(title) + '" referrerpolicy="no-referrer" loading="eager" decoding="async">' : '') + '</div><div class="hero-copy"><span class="eyebrow">' + escapeHtml(contentType + " Spotlight") + '</span><h1>' + escapeHtml(title) + '</h1><div class="hero-meta"><span>' + escapeHtml(year || "—") + '</span><span>' + escapeHtml(contentType) + '</span><span>IMDb ' + escapeHtml(rating) + '</span></div><p>' + escapeHtml(plot || "Details were not returned by the source.") + '</p><div class="hero-actions"><button class="title-like-button" type="button" id="titleLikeToggle" aria-pressed="false">Like</button><button class="title-like-button" type="button" data-loop-play-slot="loop1" aria-pressed="false">Loop Play</button><button class="title-like-button" type="button" data-loop-play-slot="loop2" aria-pressed="false">Loop Play 2</button><button class="title-like-button" type="button" data-loop-play-slot="loop3" aria-pressed="false">Loop Play 3</button></div></div></div>';
        const titleEntry = { id: String(tmdbId || anilistId || mangaId || title), title: title, type: contentType.toLowerCase(), year: year, rating: rating, poster: poster, backdrop: backdrop, tmdb_id: tmdbId, anilist_id: anilistId, manga_id: mangaId, selected_season: selectedSeason, selected_episode_number: selectedEpisode, detail_url: location.pathname + location.search };
        try { const recent = JSON.parse(localStorage.getItem("freemovie_recent_titles_v1") || "[]"); const cleaned = (Array.isArray(recent) ? recent : []).filter(function (entry) { return String(entry.id || "") !== "tt0080027" && String(entry.title || "") !== "Title Shot" && String(entry.id || "") !== titleEntry.id; }); localStorage.setItem("freemovie_recent_titles_v1", JSON.stringify([Object.assign({ viewed_at: Date.now(), has_embed: true }, titleEntry)].concat(cleaned).slice(0, 24))); } catch (_) {}
        const toggleStoredTitle = function (key, button, activeText) { let entries = []; try { entries = JSON.parse(localStorage.getItem(key) || "[]"); } catch (_) {} if (!Array.isArray(entries)) entries = []; const present = entries.some(function (entry) { return String(entry.id) === titleEntry.id; }); entries = present ? entries.filter(function (entry) { return String(entry.id) !== titleEntry.id; }) : [Object.assign({ added_at: Date.now() }, titleEntry)].concat(entries); try { localStorage.setItem(key, JSON.stringify(entries)); } catch (_) {} button.classList.toggle("is-liked", !present); button.setAttribute("aria-pressed", String(!present)); if (activeText) button.textContent = present ? (button.dataset.defaultLabel || "Like") : activeText; };
        const likeButton = document.getElementById("titleLikeToggle"); if (likeButton) { let likes = []; try { likes = JSON.parse(localStorage.getItem("freemovie_liked_titles_v1") || "[]"); } catch (_) {} const liked = Array.isArray(likes) && likes.some(function (entry) { return String(entry.id) === titleEntry.id; }); likeButton.classList.toggle("is-liked", liked); likeButton.setAttribute("aria-pressed", String(liked)); likeButton.textContent = liked ? "Liked" : "Like"; likeButton.addEventListener("click", function () { toggleStoredTitle("freemovie_liked_titles_v1", likeButton, "Liked"); }); }
        document.querySelectorAll("[data-loop-play-slot]").forEach(function (button) { const slot = button.dataset.loopPlaySlot; const storageKey = slot === "loop2" ? "freemovie_loop_play_2_v1" : (slot === "loop3" ? "freemovie_loop_play_3_v1" : "freemovie_loop_play_v1"); button.dataset.defaultLabel = button.textContent; button.addEventListener("click", function () { toggleStoredTitle(storageKey, button, "Added"); }); });
        const facts = fact("Genre", genres) + fact("Released", year) + fact("Runtime", runtime) + fact("Language", tmdbId && detail ? ((detail.spoken_languages || [])[0] || {}).english_name : "") + fact(kind === "tv" ? "Network" : "Director", tmdbId && detail ? (kind === "tv" ? ((detail.networks || [])[0] || {}).name : (((detail.credits || {}).crew || []).filter(function (person) { return person.job === "Director"; }).map(function (person) { return person.name; }).join(", "))) : "") + fact("Source", tmdbId ? "TMDb" : mangaId ? "MangaDex" : "AniList");
        const episodeControls = (kind === "tv" || isAnime) ? '<div class="stream-control-group"><div class="stream-control-head"><div class="stream-label">Season</div></div><div class="season-select-shell"><select id="watchSeasonSelect" class="season-select" aria-label="Select season" tabindex="-1">' + seasons.map(function (season) { return '<option value="' + season.season_number + '"' + (Number(season.season_number) === selectedSeason ? " selected" : "") + '>Season ' + season.season_number + '</option>'; }).join("") + '</select><div class="custom-select" id="watchSeasonPicker"></div></div></div><div class="stream-control-group"><div class="stream-control-head"><div class="stream-label">Episodes</div><div class="stream-subcopy">Use the arrows on desktop to move through the episode list faster.</div></div><div class="episode-rail-shell"><button class="episode-rail-arrow" type="button" id="episodePrevButton" aria-label="Scroll episodes left">&#10094;</button><div class="episode-chip-row" id="playerEpisodeRail">' + episodes.map(function (episode) { const image = tmdbImage(episode.still_path, "w300") || backdrop; return '<button class="episode-chip' + (Number(episode.episode_number) === selectedEpisode ? " active" : "") + '" type="button" data-episode="' + episode.episode_number + '">' + (image ? '<img class="episode-chip-image" src="' + escapeHtml(image) + '" alt="">' : "") + '<strong>Episode ' + episode.episode_number + '</strong><span class="episode-chip-title">' + escapeHtml(episode.name || "Episode " + episode.episode_number) + '</span></button>'; }).join("") + '</div><button class="episode-rail-arrow" type="button" id="episodeNextButton" aria-label="Scroll episodes right">&#10095;</button></div></div>' : "";
        const serverOptions = [{ key: "vsembed", name: "VS Embed" }, { key: "vidsrc", name: "VidSrc" }, { key: "vidsrc-ru", name: "VidSrc RU" }, { key: "vidsrc-su", name: "VidSrc SU" }, { key: "111movies", name: "111Movies" }, { key: "2embed", name: "2Embed" }, { key: "vidfast", name: "VidFast" }, { key: "vidsrcmov", name: "VidSrc Mov" }, { key: "vidlink", name: "VidLink" }, { key: "godrive", name: "GoDrive" }, { key: "multiembed", name: "MultiEmbed" }, { key: "vidstreams", name: "VidStreams" }, { key: "vidsrcto", name: "VidSrc To" }, { key: "vidsrcme", name: "VidSrcMe" }, { key: "vidsrcmeru", name: "VidSrc-Me RU" }, { key: "vidsrcmesu", name: "VidSrcMe SU" }, { key: "vidsrcembedru2", name: "VidSrc Embed RU 2" }, { key: "vidsrcembedsu2", name: "VidSrc Embed SU 2" }, { key: "vsrcsu", name: "VSrc SU" }, { key: "2embedcc", name: "2Embed CC" }, { key: "superembed", name: "SuperEmbed" }, { key: "vidsrccc", name: "VidSrc CC" }, { key: "embedsu", name: "Embed SU" }, { key: "vidplay", name: "VidPlay Online" }, { key: "vidsrcdev", name: "VidSrc Dev" }, { key: "vidsrcwin", name: "VidSrc Win" }, { key: "vidsrcvip", name: "VidSrc VIP" }, { key: "fsapi", name: "FSAPI" }, { key: "2embedskin", name: "2Embed Skin" }, { key: "kimostream", name: "KimoStream" }, { key: "curtstream", name: "CurtStream" }, { key: "moviewp", name: "MovieWP" }, { key: "vidplaypro", name: "VidPlay Pro" }, { key: "streamwish", name: "StreamWish" }, { key: "mycloudplayer", name: "MyCloudPlayer" }, { key: "vidsrcin", name: "VidSrc In" }, { key: "megaplay", name: "MegaPlay" }];
        const requestedServer = param("server");
        const defaultServer = serverOptions.find(function (server) { return server.key === requestedServer; }) || serverOptions.find(function (server) { return server.key === (isAnime ? "megaplay" : "vidfast"); }) || serverOptions[0];
        const serverControls = '<div class="stream-control-group"><div class="stream-control-head"><div class="stream-label">Servers</div><div class="stream-subcopy">Use the full list to switch player sources.</div></div><div class="server-picker-shell"><div class="server-picker-row"><select id="watchServerSelect" class="season-select" aria-label="Select server" tabindex="-1">' + serverOptions.map(function (server) { return '<option value="' + server.key + '"' + (server.key === defaultServer.key ? " selected" : "") + '>' + server.name + '</option>'; }).join("") + '</select><div class="custom-select" id="watchServerPicker"></div></div></div></div>';
        const requestedAudio = ["default", "sub", "dub"].includes(param("audio")) ? param("audio") : "default";
        const audioControls = '<div class="stream-control-group"><div class="stream-control-head"><div class="stream-label">Audio</div><div class="stream-subcopy">Switch between default, sub, and dub when that server exposes those options.</div></div><div class="audio-chip-row" id="playerAudioRail">' + ["default", "sub", "dub"].map(function (audio) { return '<button class="audio-chip' + (audio === requestedAudio ? " active" : "") + '" type="button" data-audio="' + audio + '">Audio: ' + (audio === "default" ? "Default" : audio.charAt(0).toUpperCase() + audio.slice(1)) + '</button>'; }).join("") + '</div></div>';
        const player = (tmdbId || anilistId) ? '<section class="surface stream-shell" id="streamSection"><div class="stream-panel"><div class="watch-header"><div class="watch-topline"><div><div class="section-kicker">Main Player</div><h2>Watch ' + escapeHtml(title) + '</h2></div><div class="stream-meta"><span class="status-chip">Server <strong id="activeServerName">' + defaultServer.name + '</strong></span>' + ((kind === "tv" || isAnime) ? '<span class="status-chip">Season <strong id="activeSeasonNumber">' + selectedSeason + '</strong></span><span class="status-chip">Episode <strong id="activeEpisodeNumber">' + selectedEpisode + '</strong></span>' : "") + '<span class="status-chip">Audio <strong id="activeAudioMode">' + escapeHtml(requestedAudio === "default" ? "Default" : requestedAudio.charAt(0).toUpperCase() + requestedAudio.slice(1)) + '</strong></span></div></div><div class="watch-note">If one server does not work, try another supported source.</div></div><div class="stream-stage" id="streamStage"><iframe id="streamFrame" class="stream-frame" src="' + escapeHtml(applyAudioMode(staticServerUrl(defaultServer.key, kind, tmdbId || anilistId, selectedSeason, selectedEpisode, isAnime), requestedAudio)) + '" referrerpolicy="origin-when-cross-origin" allow="fullscreen; accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div><div class="stream-actions"><button class="stream-action" id="fullscreenToggle" type="button">Fullscreen</button><button class="stream-action is-accent" id="downloadCurrentButton" type="button">Download Current</button></div><div class="watch-note" id="downloadNotice">Offline download works only when the active source exposes a real direct video file such as MP4 or WebM.</div><div class="stream-controls">' + audioControls + serverControls + episodeControls + '</div></div></section>' : "";
        const chapterGuide = mangaChapters.length ? '<section class="panel surface"><div class="section-head"><div><div class="section-kicker">Chapter Guide</div><h2>Recent Chapters</h2></div></div><div class="episodes-list">' + mangaChapters.map(function (chapter) { return '<article class="episode-row"><div><strong>' + escapeHtml(chapter.title) + '</strong><div class="episode-meta">' + escapeHtml(chapter.released) + '</div></div><a class="cast-search-link" href="https://mangadex.org/chapter/' + encodeURIComponent(chapter.id) + '" target="_blank" rel="noopener noreferrer">Read Here</a></article>'; }).join("") + '</div></section>' : "";
        stack.innerHTML = player + chapterGuide + (trailer ? '<section class="panel surface" id="trailerSection"><div class="section-head"><div><div class="section-kicker">Preview</div><h2>Trailer</h2></div></div><div class="trailer-shell"><iframe class="trailer-frame" src="' + escapeHtml(trailer) + '" title="' + escapeHtml(title) + ' trailer" loading="lazy" allowfullscreen></iframe></div></section>' : "") + '<section class="panel surface"><div class="section-head"><div><div class="section-kicker">Full Details</div><h2>About ' + escapeHtml(title) + '</h2></div></div><div class="snapshot-strip">' + snapshotsMarkup(title, poster, backdrop) + '</div><div class="detail-clusters"><div class="details-card"><div class="stream-label" style="margin-bottom:10px">Story</div><p class="detail-plot">' + escapeHtml(plot || "Details were not returned by the source.") + '</p></div><div class="details-grid">' + facts + '</div>' + (cast.length ? '<div><div class="section-head"><div><div class="section-kicker">Cast</div><h3>Watch More From The Cast</h3></div></div><div class="cast-grid">' + castMarkup(cast) + '</div></div>' : "") + '</div></section>';
        const frame = document.getElementById("streamFrame"), seasonSelect = document.getElementById("watchSeasonSelect"), serverSelect = document.getElementById("watchServerSelect"), episodeRail = document.getElementById("playerEpisodeRail"); renderStaticSeasonPicker(seasonSelect); renderStaticServerPicker(serverSelect); document.getElementById("fullscreenToggle")?.addEventListener("click", function () { const stage = document.getElementById("streamStage"); if (stage && stage.requestFullscreen) stage.requestFullscreen(); }); serverSelect?.addEventListener("change", function (event) { const next = new URL(location.href); next.searchParams.set("server", event.target.value); history.replaceState({}, "", next.toString()); if (frame) frame.src = staticServerUrl(event.target.value, kind, tmdbId || anilistId, selectedSeason, selectedEpisode, isAnime); const label = document.getElementById("activeServerName"); if (label) label.textContent = event.target.options[event.target.selectedIndex].text; }); seasonSelect?.addEventListener("change", function (event) { const next = new URL(location.href); next.searchParams.set("season", event.target.value); next.searchParams.set("episode", "1"); history.pushState({}, "", next.toString()); hydrateGenericTitle().catch(function () {}); }); document.getElementById("episodePrevButton")?.addEventListener("click", function () { episodeRail?.scrollBy({ left: -Math.max(240, episodeRail.clientWidth * .75), behavior: "smooth" }); }); document.getElementById("episodeNextButton")?.addEventListener("click", function () { episodeRail?.scrollBy({ left: Math.max(240, episodeRail.clientWidth * .75), behavior: "smooth" }); }); document.querySelectorAll("[data-episode]").forEach(function (button) { button.addEventListener("click", function () { const episode = button.dataset.episode; if (frame) frame.src = staticServerUrl(serverSelect?.value || defaultServer.key, kind, tmdbId || anilistId, selectedSeason, episode, isAnime); document.querySelectorAll("[data-episode]").forEach(function (node) { node.classList.toggle("active", node === button); }); const label = document.getElementById("activeEpisodeNumber"); if (label) label.textContent = episode; const next = new URL(location.href); next.searchParams.set("episode", episode); history.replaceState({}, "", next.toString()); }); });
        let activeGenericAudio = requestedAudio;
        const syncGenericAudio = function () { if (!frame) return; frame.src = applyAudioMode(frame.src, activeGenericAudio); const label = document.getElementById("activeAudioMode"); if (label) label.textContent = activeGenericAudio === "default" ? "Default" : activeGenericAudio.charAt(0).toUpperCase() + activeGenericAudio.slice(1); };
        document.querySelectorAll("#playerAudioRail [data-audio]").forEach(function (button) { button.addEventListener("click", function () { activeGenericAudio = button.dataset.audio || "default"; document.querySelectorAll("#playerAudioRail [data-audio]").forEach(function (chip) { chip.classList.toggle("active", chip === button); }); const next = new URL(location.href); next.searchParams.set("audio", activeGenericAudio); history.replaceState({}, "", next.toString()); syncGenericAudio(); }); });
        serverSelect?.addEventListener("change", syncGenericAudio);
        document.querySelectorAll("[data-episode]").forEach(function (button) { button.addEventListener("click", syncGenericAudio); });
        document.getElementById("downloadCurrentButton")?.addEventListener("click", function () { const notice = document.getElementById("downloadNotice"); if (notice) notice.textContent = "The current source is opened in a new tab. Browser downloads are available only for direct MP4/WebM sources."; if (frame && frame.src) window.open(frame.src, "_blank", "noopener"); });
    }
    document.addEventListener("DOMContentLoaded", function () {
        const relativePath = basePath && location.pathname.startsWith(basePath) ? location.pathname.slice(basePath.length) : location.pathname;
        if (/^\/title\/[^/]+\/[^/]+\/?$/.test(relativePath) && !document.getElementById("title-item-data")) {
            const mediaType = relativePath.split("/")[2] || "movie";
            const params = new URLSearchParams(location.search); params.set("media_type", mediaType);
            location.replace(withBase("/title/index.html") + "?" + params.toString());
            return;
        }
        hydrateSearchPage().catch(function () {});
        hydrateGenericTitle().catch(function () {});
    });
})();
