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

    function withBase(value) {
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
        if (!isFileProtocol) return withBase(value);
        const target = new URL(value, window.location.href);
        if (target.pathname.endsWith("/")) target.pathname += "index.html";
        return target.href;
    }

    function normalizeCatalogLinks(value) {
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) {
            value.forEach(normalizeCatalogLinks);
            return value;
        }
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
        try {
            const url = "https://api.themoviedb.org/3/search/multi?api_key=" + encodeURIComponent(tmdbApiKey) + "&include_adult=true&query=" + encodeURIComponent(query);
            const response = await originalFetch(url);
            if (!response.ok) throw new Error("TMDb search failed");
            const payload = await response.json();
            return (payload.results || []).filter(function (item) { return item.media_type === "movie" || item.media_type === "tv"; }).slice(0, limit || 18).map(normalizeTmdbItem);
        } catch (_) {
            const normalized = query.toLowerCase();
            return localCatalogItems().filter(function (item) { return String(item.title || "").toLowerCase().includes(normalized); }).slice(0, limit || 18);
        }
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
                subtitle: [item.artistName, item.collectionName].filter(Boolean).join(" â€¢ "),
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
            return '<article class="content-card"><a href="' + escapeHtml(item.detail_url) + '"><img class="card-poster" src="' + escapeHtml(item.poster) + '" alt="' + escapeHtml(item.title) + '" loading="lazy"><div class="card-overlay"></div><div class="card-topline"><span class="badge">' + escapeHtml(item.type) + '</span><span class="source-badge">TMDb</span></div><div class="card-body"><h3 class="card-title">' + escapeHtml(item.title) + '</h3><div class="card-meta">' + escapeHtml(item.year) + ' â€¢ ' + escapeHtml(item.type) + '</div><span class="card-button">Open</span></div></a></article>';
        }).join("") : 'No matching titles came back for "' + escapeHtml(query) + '".';
        const adPanel = document.querySelector(".ad-panel");
        (adPanel || summary).insertAdjacentElement("afterend", section);
    }

    function tmdbImage(path, size) { return path ? "https://image.tmdb.org/t/p/" + (size || "w780") + path : ""; }
    function trailerEmbed(videos) { const video = ((videos || {}).results || []).find(function (entry) { return entry.site === "YouTube" && (entry.type === "Trailer" || entry.type === "Teaser"); }); return video ? "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(video.key) : ""; }
    function tmdbStreamUrl(kind, id, season, episode) { return kind === "tv" ? "https://vidsrc.in/embed/tv/" + encodeURIComponent(id) + "/" + encodeURIComponent(season || 1) + "/" + encodeURIComponent(episode || 1) : "https://vidsrc.in/embed/movie/" + encodeURIComponent(id); }
    function fact(label, value) { return value ? '<div class="fact"><span class="fact-label">' + escapeHtml(label) + '</span><div class="fact-value">' + escapeHtml(value) + '</div></div>' : ""; }
    function castMarkup(cast) { return (cast || []).slice(0, 12).map(function (person) { const photo = tmdbImage(person.profile_path, "w185"); return '<article class="cast-item cast-card"><div class="cast-photo-shell">' + (photo ? '<img class="cast-photo" src="' + escapeHtml(photo) + '" alt="' + escapeHtml(person.name) + '" loading="lazy" referrerpolicy="no-referrer">' : '<div class="cast-photo-fallback">' + escapeHtml((person.name || "?").charAt(0).toUpperCase()) + '</div>') + '</div><div class="cast-name">' + escapeHtml(person.name) + '</div><div class="cast-meta">' + escapeHtml(person.character || "Cast") + '</div><a class="cast-search-link" href="' + escapeHtml(withBase('/search/index.html?q=' + encodeURIComponent(person.name || ""))) + '">Watch titles with ' + escapeHtml(person.name) + '</a></article>'; }).join(""); }
    function snapshotsMarkup(title, poster, backdrop) { return [[backdrop, "Backdrop snapshot"], [poster, "Poster snapshot"], [backdrop || poster, "Scene snapshot"]].filter(function (entry) { return entry[0]; }).map(function (entry) { return '<figure class="snapshot-card"><img src="' + escapeHtml(entry[0]) + '" alt="' + escapeHtml(title + " " + entry[1]) + '" loading="lazy"><figcaption class="snapshot-caption">' + escapeHtml(entry[1]) + '</figcaption></figure>'; }).join(""); }

    async function hydrateGenericTitle() {
        if (!location.pathname.endsWith("/title/index.html")) return;
        const params = new URLSearchParams(location.search);
        const param = function (name) { return params.get(name) || params.get(name.replace("_", "\\_")) || ""; };
        const tmdbId = param("tmdb_id"), mangaId = param("manga_id"), anilistId = param("anilist_id");
        const kind = param("media_type") === "series" || param("media_type") === "tv" ? "tv" : "movie";
        if (!tmdbId && !mangaId && !anilistId) return;
        const fallback = localCatalogItems().find(function (entry) { return (tmdbId && String(entry.tmdb_id || "") === tmdbId) || (mangaId && String(entry.manga_id || "") === mangaId) || (anilistId && String(entry.anilist_id || "") === anilistId); }) || {};
        let title = fallback.title || param("title") || "Title", plot = fallback.plot || "", poster = fallback.poster || "", backdrop = fallback.backdrop || poster, detail = null, seasonData = null;
        let selectedSeason = Math.max(1, Number(param("season") || 1)), selectedEpisode = Math.max(1, Number(param("episode") || 1));
        try {
            if (tmdbId) {
                const response = await originalFetch("https://api.themoviedb.org/3/" + kind + "/" + encodeURIComponent(tmdbId) + "?api_key=" + encodeURIComponent(tmdbApiKey) + "&append_to_response=credits,videos");
                if (!response.ok) throw new Error("TMDb detail failed"); detail = await response.json(); title = detail.title || detail.name || title; plot = detail.overview || plot; poster = tmdbImage(detail.poster_path, "w500") || poster; backdrop = tmdbImage(detail.backdrop_path, "original") || poster || backdrop;
                if (kind === "tv") { const seasons = (detail.seasons || []).filter(function (season) { return Number(season.season_number) > 0; }); if (!seasons.some(function (season) { return Number(season.season_number) === selectedSeason; })) selectedSeason = Number(seasons[0] && seasons[0].season_number) || 1; const seasonResponse = await originalFetch("https://api.themoviedb.org/3/tv/" + encodeURIComponent(tmdbId) + "/season/" + selectedSeason + "?api_key=" + encodeURIComponent(tmdbApiKey)); if (seasonResponse.ok) seasonData = await seasonResponse.json(); const episodes = (seasonData || {}).episodes || []; if (!episodes.some(function (episode) { return Number(episode.episode_number) === selectedEpisode; })) selectedEpisode = Number(episodes[0] && episodes[0].episode_number) || 1; }
            } else if (mangaId) {
                const response = await originalFetch("https://api.mangadex.org/manga/" + encodeURIComponent(mangaId) + "?includes[]=cover_art"); if (!response.ok) throw new Error("MangaDex detail failed"); detail = (await response.json()).data || {}; const attrs = detail.attributes || {}, titles = attrs.title || {}, descriptions = attrs.description || {}; title = titles.en || Object.values(titles)[0] || title; plot = descriptions.en || Object.values(descriptions)[0] || plot; const cover = (detail.relationships || []).find(function (relation) { return relation.type === "cover_art"; }); const fileName = cover && cover.attributes && cover.attributes.fileName; poster = fileName ? "https://uploads.mangadex.org/covers/" + mangaId + "/" + fileName + ".512.jpg" : poster; backdrop = poster || backdrop;
            } else {
                const query = "query($id:Int){Media(id:$id,type:ANIME){title{english romaji native}description bannerImage coverImage{extraLarge large}episodes averageScore genres status seasonYear}}"; const response = await originalFetch("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: query, variables: { id: Number(anilistId) } }) }); if (!response.ok) throw new Error("AniList detail failed"); detail = (await response.json()).data.Media || {}; title = detail.title.english || detail.title.romaji || detail.title.native || title; plot = String(detail.description || plot).replace(/<[^>]+>/g, ""); poster = detail.coverImage.extraLarge || detail.coverImage.large || poster; backdrop = detail.bannerImage || poster || backdrop;
            }
        } catch (_) { detail = detail || fallback; }
        document.title = title + " | Free movie";
        const hero = document.querySelector(".hero"), stack = document.querySelector(".page-stack"); if (!hero || !stack) return;
        const rating = tmdbId && detail ? (detail.vote_average ? Number(detail.vote_average).toFixed(1) : "—") : (detail && detail.averageScore ? (detail.averageScore / 10).toFixed(1) : "—");
        const year = tmdbId && detail ? String((detail.first_air_date || detail.release_date || "").slice(0, 4)) : String((detail && detail.seasonYear) || fallback.year || "");
        const genres = tmdbId && detail ? (detail.genres || []).map(function (genre) { return genre.name; }).join(", ") : ((detail && detail.genres) || []).join(", ");
        const trailer = tmdbId && detail ? trailerEmbed(detail.videos) : "", cast = tmdbId && detail ? ((detail.credits || {}).cast || []) : [], runtime = tmdbId && detail ? (kind === "tv" ? ((detail.episode_run_time || [])[0] ? detail.episode_run_time[0] + " min / episode" : "") : (detail.runtime ? detail.runtime + " min" : "")) : "";
        const seasons = kind === "tv" && detail ? (detail.seasons || []).filter(function (season) { return Number(season.season_number) > 0; }) : [], episodes = (seasonData || {}).episodes || [];
        hero.innerHTML = '<div class="hero-backdrop" style="background-image:linear-gradient(90deg,rgba(0,0,0,.88),rgba(0,0,0,.2)),url(\'' + escapeHtml(backdrop).replace(/&#39;/g, "%27") + '\')"></div><div class="hero-content"><div class="poster-card">' + (poster ? '<img src="' + escapeHtml(poster) + '" alt="' + escapeHtml(title) + '">' : '') + '</div><div class="hero-copy"><div class="eyebrow">' + escapeHtml(kind === "tv" ? "Series spotlight" : "Movie spotlight") + '</div><h1>' + escapeHtml(title) + '</h1><div class="hero-meta"><span>' + escapeHtml(year || "—") + '</span><span>' + escapeHtml(kind === "tv" ? "Series" : (mangaId ? "Manga" : anilistId ? "Anime" : "Movie")) + '</span><span>TMDb ' + escapeHtml(rating) + '</span></div><p>' + escapeHtml(plot || "Details were not returned by the source.") + '</p><div class="hero-actions"><button class="title-like-button" type="button">Like</button><button class="title-like-button" type="button">Loop Play</button></div></div></div>';
        const facts = fact("Genre", genres) + fact("Released", year) + fact("Runtime", runtime) + fact("Language", tmdbId && detail ? ((detail.spoken_languages || [])[0] || {}).english_name : "") + fact(kind === "tv" ? "Network" : "Director", tmdbId && detail ? (kind === "tv" ? ((detail.networks || [])[0] || {}).name : (((detail.credits || {}).crew || []).filter(function (person) { return person.job === "Director"; }).map(function (person) { return person.name; }).join(", "))) : "") + fact("Source", tmdbId ? "TMDb" : mangaId ? "MangaDex" : "AniList");
        const episodeControls = kind === "tv" ? '<div class="stream-control-group"><div class="stream-control-head"><div class="stream-label">Season</div></div><select id="watchSeasonSelect" class="season-select" aria-label="Select season">' + seasons.map(function (season) { return '<option value="' + season.season_number + '"' + (Number(season.season_number) === selectedSeason ? " selected" : "") + '>Season ' + season.season_number + '</option>'; }).join("") + '</select></div><div class="stream-control-group"><div class="stream-control-head"><div class="stream-label">Episodes</div><div class="stream-subcopy">Choose an episode to update the player.</div></div><div class="episode-chip-row" id="playerEpisodeRail">' + episodes.map(function (episode) { const image = tmdbImage(episode.still_path, "w300") || backdrop; return '<button class="episode-chip' + (Number(episode.episode_number) === selectedEpisode ? " active" : "") + '" type="button" data-episode="' + episode.episode_number + '">' + (image ? '<img class="episode-chip-image" src="' + escapeHtml(image) + '" alt="">' : "") + '<strong>Episode ' + episode.episode_number + '</strong><span class="episode-chip-title">' + escapeHtml(episode.name || "Episode " + episode.episode_number) + '</span></button>'; }).join("") + '</div></div>' : "";
        const player = tmdbId ? '<section class="surface stream-shell" id="streamSection"><div class="stream-panel"><div class="watch-header"><div class="watch-topline"><div><div class="section-kicker">Main Player</div><h2>Watch ' + escapeHtml(title) + '</h2></div><div class="stream-meta"><span class="status-chip">Server <strong>VidSrc</strong></span>' + (kind === "tv" ? '<span class="status-chip">Season <strong id="activeSeasonNumber">' + selectedSeason + '</strong></span><span class="status-chip">Episode <strong id="activeEpisodeNumber">' + selectedEpisode + '</strong></span>' : "") + '</div></div><div class="watch-note">If one server does not work, try another supported source.</div></div><div class="stream-stage" id="streamStage"><iframe id="streamFrame" class="stream-frame" src="' + escapeHtml(tmdbStreamUrl(kind, tmdbId, selectedSeason, selectedEpisode)) + '" allow="fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe></div><div class="stream-actions"><button class="stream-action" id="fullscreenToggle" type="button">Fullscreen</button></div><div class="stream-controls">' + episodeControls + '</div></div></section>' : "";
        stack.innerHTML = player + (trailer ? '<section class="panel surface" id="trailerSection"><div class="section-head"><div><div class="section-kicker">Preview</div><h2>Trailer</h2></div></div><div class="trailer-shell"><iframe class="trailer-frame" src="' + escapeHtml(trailer) + '" title="' + escapeHtml(title) + ' trailer" loading="lazy" allowfullscreen></iframe></div></section>' : "") + '<section class="panel surface"><div class="section-head"><div><div class="section-kicker">Full Details</div><h2>About ' + escapeHtml(title) + '</h2></div></div><div class="snapshot-strip">' + snapshotsMarkup(title, poster, backdrop) + '</div><div class="detail-clusters"><div class="details-card"><div class="stream-label" style="margin-bottom:10px">Story</div><p class="detail-plot">' + escapeHtml(plot || "Details were not returned by the source.") + '</p></div><div class="details-grid">' + facts + '</div>' + (cast.length ? '<div><div class="section-head"><div><div class="section-kicker">Cast</div><h3>Watch More From The Cast</h3></div></div><div class="cast-grid">' + castMarkup(cast) + '</div></div>' : "") + '</div></section>';
        const frame = document.getElementById("streamFrame"); document.getElementById("fullscreenToggle")?.addEventListener("click", function () { const stage = document.getElementById("streamStage"); if (stage && stage.requestFullscreen) stage.requestFullscreen(); }); document.getElementById("watchSeasonSelect")?.addEventListener("change", function (event) { const next = new URL(location.href); next.searchParams.set("season", event.target.value); next.searchParams.set("episode", "1"); location.href = next.toString(); }); document.querySelectorAll("[data-episode]").forEach(function (button) { button.addEventListener("click", function () { const episode = button.dataset.episode; if (frame) frame.src = tmdbStreamUrl(kind, tmdbId, selectedSeason, episode); document.querySelectorAll("[data-episode]").forEach(function (node) { node.classList.toggle("active", node === button); }); const label = document.getElementById("activeEpisodeNumber"); if (label) label.textContent = episode; const next = new URL(location.href); next.searchParams.set("episode", episode); history.replaceState({}, "", next.toString()); }); });
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
