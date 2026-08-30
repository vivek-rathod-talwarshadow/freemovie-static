"""Export the sibling Django site as a GitHub Pages compatible static site.

The Django project remains the design/data source during development only.  The
generated site has no Python, Django, database, or server runtime dependency.
"""

from __future__ import annotations

import json
import html
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


TARGET_ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = TARGET_ROOT.parent / "freemovie"
SITE_URL = "https://vivek-rathod-talwarshadow.github.io/freemovie-static"

sys.path.insert(0, str(SOURCE_ROOT))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "sitcom_ediction.settings")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(SOURCE_ROOT / 'db.sqlite3').as_posix()}")
os.environ.setdefault("BANDWIDTH_FREE_TIER_SAFE_MODE", "true")
os.environ.setdefault("BANDWIDTH_GUARD_ENABLED", "false")

import django  # noqa: E402

django.setup()

from django.test import Client  # noqa: E402
from main_app import views  # noqa: E402


# Static builds do not record visitors or touch any analytics tables.
views._register_visitor = lambda response, request: response
# The source currently references an undeclared module-level ``limit`` in the
# Anime browse branch. Supplying the intended page size keeps this static copy
# working without mutating the Django project.
views._fetch_browse_mode_page.__globals__.setdefault("limit", views.BROWSE_MODE_PAGE_SIZE)

client = Client(HTTP_HOST="localhost", SERVER_NAME="localhost")


def output_file(route: str, *, json_endpoint: bool = False) -> Path:
    clean_path = urlsplit(route).path.strip("/")
    if not clean_path:
        return TARGET_ROOT / "index.html"
    if clean_path.endswith((".js", ".txt", ".xml")):
        return TARGET_ROOT / clean_path
    return TARGET_ROOT / clean_path / "index.html"


def relative_root(destination: Path) -> str:
    depth = len(destination.relative_to(TARGET_ROOT).parts) - 1
    return "../" * depth or "./"


def rewrite_root_url(value: str, prefix: str) -> str:
    if not value.startswith("/") or value.startswith("//"):
        return value
    parts = urlsplit(value)
    path = parts.path.lstrip("/")
    return urlunsplit(("", "", f"{prefix}{path}", parts.query, parts.fragment))


def prepare_html(content: str, destination: Path) -> str:
    prefix = relative_root(destination)
    content = content.replace("http://localhost", SITE_URL)
    content = content.replace("https://localhost", SITE_URL)

    # HTML attributes emitted by Django's url/static tags.
    attr_pattern = re.compile(r'(?P<head>\b(?:href|src|action|poster)=["\'])(?P<url>/[^"\']*)(?P<tail>["\'])')
    content = attr_pattern.sub(
        lambda match: f"{match.group('head')}{rewrite_root_url(match.group('url'), prefix)}{match.group('tail')}",
        content,
    )

    config = (
        f'<script>window.__FM_STATIC_ROOT__={json.dumps(prefix)};'
        f'window.__FM_SITE_URL__={json.dumps(SITE_URL)};</script>\n'
        f'<script src="{prefix}data/catalog.js"></script>\n'
        f'<script src="{prefix}assets/static-runtime.js"></script>\n'
    )
    return content.replace("</head>", f"{config}</head>", 1)


def export(route: str, *, destination: Path | None = None, allow=(200,)) -> bytes:
    destination = destination or output_file(route)
    if os.getenv("FM_INCREMENTAL") == "1" and destination.exists():
        payload = destination.read_bytes()
        print(f"SKIP {route:<55} -> {destination.relative_to(TARGET_ROOT)}", flush=True)
        return payload
    response = client.get(route, follow=False)
    if response.status_code not in allow:
        raise RuntimeError(f"GET {route} returned HTTP {response.status_code}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = bytes(response.content)
    content_type = response.get("Content-Type", "")
    if "text/html" in content_type:
        payload = prepare_html(payload.decode("utf-8"), destination).encode("utf-8")
    destination.write_bytes(payload)
    print(f"{response.status_code:3} {route:<55} -> {destination.relative_to(TARGET_ROOT)}", flush=True)
    return payload


def export_json(route: str) -> dict:
    payload = export(route)
    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"GET {route} did not return JSON") from exc


def write_full_live_tv_catalog(initial_payload: dict) -> dict:
    filtered = views._filter_live_tv_channels()
    channels = filtered["channels"]
    items = [views._serialize_live_tv_channel(channel) for channel in channels]
    payload = {
        **initial_payload,
        "items": items,
        "all_items": items,
        "page": 1,
        "page_size": len(items),
        "total": len(items),
        "total_pages": 1,
        "has_next": False,
    }
    destination = output_file("/api/live-tv/")
    destination.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"ALL /api/live-tv/ ({len(items)} channels)", flush=True)
    return payload


def copy_assets() -> None:
    destination = TARGET_ROOT / "static"
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(SOURCE_ROOT / "static", destination)
    manifest_path = destination / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        manifest["id"] = "../"
        manifest["start_url"] = "../"
        manifest["scope"] = "../"

        def rewrite_manifest_urls(value):
            if isinstance(value, dict):
                for key, child in list(value.items()):
                    if key in {"src", "url"} and isinstance(child, str) and child.startswith("/"):
                        value[key] = ("." + child.removeprefix("/static")) if child.startswith("/static/") else (".." + child)
                    else:
                        rewrite_manifest_urls(child)
            elif isinstance(value, list):
                for child in value:
                    rewrite_manifest_urls(child)

        rewrite_manifest_urls(manifest)
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def make_service_worker_scope_safe() -> None:
    path = TARGET_ROOT / "service-worker.js"
    content = path.read_text(encoding="utf-8")
    if "const APP_SCOPE_PATH" in content:
        return
    content = content.replace(
        "const META_CACHE = `${APP_VERSION}-meta`;",
        "const META_CACHE = `${APP_VERSION}-meta`;\n"
        "const APP_SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\\/$/, \"\");\n"
        "const scopePath = (value) => `${APP_SCOPE_PATH}/${String(value || \"\").replace(/^\\/+/, \"\")}`;",
    )
    replacements = {
        'const OFFLINE_URL = "/offline/";': 'const OFFLINE_URL = scopePath("/offline/");',
        'const CONTENT_ALERT_SCAN_URL = "/api/content-alerts/";': 'const CONTENT_ALERT_SCAN_URL = scopePath("/api/content-alerts/");',
        'const CONTENT_ALERT_STATE_URL = "/__freemovies__/content-alert-state";': 'const CONTENT_ALERT_STATE_URL = scopePath("/__freemovies__/content-alert-state");',
        'const CONTENT_ALERT_CONFIG_URL = "/__freemovies__/content-alert-config";': 'const CONTENT_ALERT_CONFIG_URL = scopePath("/__freemovies__/content-alert-config");',
        '    "/static/manifest.json",': '    scopePath("/static/manifest.json"),',
        '    "/static/images/freemovies-logo.png",': '    scopePath("/static/images/freemovies-logo.png"),',
        '    "/static/images/freemovies-logo.svg",': '    scopePath("/static/images/freemovies-logo.svg"),',
        '    "/static/js/app-shell.js",': '    scopePath("/static/js/app-shell.js"),',
        '    "/api/",': '    scopePath("/api/"),',
        '    icon: "/static/images/freemovies-logo.png",': '    icon: scopePath("/static/images/freemovies-logo.png"),',
        '    badge: "/static/images/freemovies-logo.png",': '    badge: scopePath("/static/images/freemovies-logo.png"),',
        '        url: "/",': '        url: scopePath("/"),',
        '                url: newItems[0]?.detail_url || "/",': '                url: newItems[0]?.detail_url ? scopePath(newItems[0].detail_url) : scopePath("/"),',
        '                url: entry.target_url || "/",': '                url: entry.target_url ? scopePath(entry.target_url) : scopePath("/"),',
        '        if (event.action === "open-live-tv") return "/live-tv/";': '        if (event.action === "open-live-tv") return scopePath("/live-tv/");',
        '        if (event.action === "open-search") return "/search/";': '        if (event.action === "open-search") return scopePath("/search/");',
        '        return event.notification.data?.url || "/";': '        return event.notification.data?.url || scopePath("/");',
    }
    for original, replacement in replacements.items():
        content = content.replace(original, replacement)
    path.write_text(content, encoding="utf-8")


def rewrite_site_metadata() -> None:
    for name in ("robots.txt", "sitemap.xml"):
        path = TARGET_ROOT / name
        content = path.read_text(encoding="utf-8")
        path.write_text(content.replace("http://localhost", SITE_URL).replace("https://localhost", SITE_URL), encoding="utf-8")


def generate_and_apply_public_catalog() -> dict:
    subprocess.run([sys.executable, str(TARGET_ROOT / "generate_catalog.py")], cwd=TARGET_ROOT, check=True)
    catalog_path = TARGET_ROOT / "data" / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    encoded = json.dumps(catalog, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003C")

    api_path = output_file("/api/homepage/")
    api_path.write_text(encoded, encoding="utf-8")

    home_path = TARGET_ROOT / "index.html"
    home = home_path.read_text(encoding="utf-8")
    home = re.sub(
        r'<script id="homepage-initial-data" type="application/json">.*?</script>',
        lambda _match: f'<script id="homepage-initial-data" type="application/json">{encoded}</script>',
        home,
        count=1,
        flags=re.DOTALL,
    )
    marker = 'inMemoryProviderCatalogs.set("all", initialHomepagePayload);'
    home = home.replace(marker, marker + "\n        renderHomepage(initialHomepagePayload);", 1)
    home_path.write_text(home, encoding="utf-8")

    # Add the file:// compatible JS mirror to every rendered page. Pages built
    # after this function already receive it through prepare_html.
    for page in TARGET_ROOT.rglob("*.html"):
        if "api" in page.relative_to(TARGET_ROOT).parts or page.parent.name == "post-comment":
            continue
        content = page.read_text(encoding="utf-8")
        if "data/catalog.js" in content:
            continue
        prefix = relative_root(page)
        content = content.replace(
            f'<script src="{prefix}assets/static-runtime.js"></script>',
            f'<script src="{prefix}data/catalog.js"></script>\n<script src="{prefix}assets/static-runtime.js"></script>',
            1,
        )
        page.write_text(content, encoding="utf-8")

    live_api = output_file("/api/live-tv/")
    if live_api.exists():
        live_payload = live_api.read_text(encoding="utf-8")
        (TARGET_ROOT / "data" / "live-tv.js").write_text("window.__FM_LIVE_TV__=" + live_payload + ";\n", encoding="utf-8")
        live_page = TARGET_ROOT / "live-tv" / "index.html"
        content = live_page.read_text(encoding="utf-8")
        if "data/live-tv.js" not in content:
            content = content.replace('<script src="../data/catalog.js"></script>', '<script src="../data/catalog.js"></script>\n<script src="../data/live-tv.js"></script>', 1)
            live_page.write_text(content, encoding="utf-8")
    return catalog


def make_page_links_explicit() -> None:
    attribute_pattern = re.compile(r'(?P<head>\b(?:href|action)=["\'])(?P<url>[^"\']+)(?P<tail>["\'])')

    def rewrite(match):
        value = html.unescape(match.group("url"))
        if value.startswith(("#", "?", "//", "http://", "https://", "mailto:", "tel:", "javascript:")):
            return match.group(0)
        parts = urlsplit(value)
        if not parts.path.endswith("/"):
            return match.group(0)
        path = parts.path + "index.html"
        rewritten = urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment)).replace("&", "&amp;")
        return f"{match.group('head')}{rewritten}{match.group('tail')}"

    for page in TARGET_ROOT.rglob("*.html"):
        relative_parts = page.relative_to(TARGET_ROOT).parts
        if "api" in relative_parts or page.parent.name == "post-comment":
            continue
        content = page.read_text(encoding="utf-8")
        page.write_text(attribute_pattern.sub(rewrite, content), encoding="utf-8")


def export_catalog_title_pages(payloads: list[dict], limit: int = 40) -> None:
    urls: list[str] = []

    def walk(value):
        if isinstance(value, dict):
            detail_url = value.get("detail_url")
            if isinstance(detail_url, str) and detail_url.startswith("/title/"):
                urls.append(detail_url)
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    for payload in payloads:
        walk(payload)

    seen = set()
    for url in urls:
        if len(seen) >= limit:
            break
        parts = urlsplit(url)
        route_key = parts.path.rstrip("/") + "/"
        if route_key in seen:
            continue
        seen.add(route_key)
        try:
            export(url, destination=output_file(route_key))
        except Exception as exc:  # A single unavailable upstream title must not abort the build.
            print(f"WARN title export skipped: {url}: {exc}")


def export_linked_reader_pages(limit: int = 12) -> None:
    seen = set()
    pattern = re.compile(r'href="[^"]*?/read/(?P<slug>[^/?"]+)/\?(?P<query>[^"]+)"')
    for title_page in (TARGET_ROOT / "title" / "manga").glob("*/index.html"):
        content = title_page.read_text(encoding="utf-8")
        for match in pattern.finditer(content):
            slug = match.group("slug")
            if slug in seen or len(seen) >= limit:
                continue
            seen.add(slug)
            route = f"/read/{slug}/?{html.unescape(match.group('query'))}"
            try:
                export(route, destination=TARGET_ROOT / "read" / slug / "index.html")
            except Exception as exc:
                print(f"WARN reader export skipped: {route}: {exc}")


def main() -> None:
    copy_assets()
    catalog_payloads: list[dict] = []

    for route in (
        "/",
        "/r-rated/",
        "/offline/",
        "/settings/",
        "/live-tv/",
        "/music/",
        "/loop-play/",
        "/shorts/",
        "/terms/",
        "/search/",
    ):
        export(route)

    export("/service-worker.js")
    make_service_worker_scope_safe()
    export("/robots.txt")
    export("/sitemap.xml")
    rewrite_site_metadata()

    for route in ("/api/homepage/", "/api/r-rated/", "/api/shorts/"):
        catalog_payloads.append(export_json(route))
    catalog_payloads.append(write_full_live_tv_catalog(export_json("/api/live-tv/")))

    # Browser-only replacements handle notifications, subscriptions, comments,
    # tracking, live search, music lookup, and arbitrary title lookup.
    local_api_defaults = {
        "/api/content-alerts/": {"items": [], "alerts": [], "count": 0},
        "/api/push/public-key/": {"configured": False, "public_key": ""},
        "/api/push/subscribe/": {"status": "local", "subscribed": True},
        "/api/push/unsubscribe/": {"status": "local", "subscribed": False},
        "/api/push/test/": {"status": "local", "message": "Notifications are stored on this device."},
        "/api/tracking/collect/": {"status": "ignored", "static": True},
        "/api/music/search/": {"tracks": [], "radios": [], "sources": []},
        "/api/music/stream/": {"stream_url": "", "source": "local"},
        "/api/loop-play-item/": {"stream_servers": [], "season_options": [], "episodes_map": {}},
        "/api/search/suggest/": {"items": []},
        "/post-comment/": {"status": "success", "storage": "local"},
    }
    for route, payload in local_api_defaults.items():
        destination = output_file(route)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")

    for provider in views.FEATURED_STREAMING_PROVIDERS:
        slug = provider["slug"]
        export(f"/providers/{slug}/")
        catalog_payloads.append(export_json(f"/api/providers/{slug}/"))

    for slug in views.SHELF_BROWSE_CONFIG:
        export(f"/browse/{slug}/")

    # Resolving the large hand-curated classic list one title at a time makes a
    # build take many minutes. Reuse already-exported catalog entries, with the
    # source's own lightweight card shape as a deterministic offline fallback.
    catalog_by_title: dict[str, dict] = {}

    def index_catalog(value):
        if isinstance(value, dict):
            title = value.get("title")
            if title and value.get("detail_url"):
                catalog_by_title.setdefault(views._normalize_title_key(title), value)
            for child in value.values():
                index_catalog(child)
        elif isinstance(value, list):
            for child in value:
                index_catalog(child)

    for catalog_payload in catalog_payloads:
        index_catalog(catalog_payload)

    def resolve_classic_fast(title, preferred_types=(), description=""):
        match = catalog_by_title.get(views._normalize_title_key(title))
        if match:
            return {**match, "plot": match.get("plot") or description}
        media_type = "anime" if "anime" in preferred_types else "cartoon"
        label = urlencode({"text": title}).split("=", 1)[1]
        return views._build_lightweight_item(
            title=title,
            media_type=media_type,
            year="Classic Pick",
            poster=f"https://placehold.co/600x900/111827/e5e7eb?text={label}",
            backdrop=f"https://placehold.co/1600x900/05070b/e5e7eb?text={label}",
            plot=description,
            source="curated",
        )

    views._resolve_classic_cartoon_item = resolve_classic_fast

    for slug in views.BROWSE_MODE_CONFIG:
        export(f"/browse-mode/{slug}/")

    export("/title/movie/title/?title=Title", destination=TARGET_ROOT / "title" / "index.html")
    export_catalog_title_pages(catalog_payloads)
    export_linked_reader_pages()
    generate_and_apply_public_catalog()
    make_page_links_explicit()

    # GitHub Pages serves this for arbitrary dynamic title/read routes.  The
    # runtime redirects those URLs to the matching static generic shell.
    shutil.copyfile(TARGET_ROOT / "index.html", TARGET_ROOT / "404.html")
    not_found = (TARGET_ROOT / "404.html").read_text(encoding="utf-8")
    not_found = not_found.replace('window.__FM_STATIC_ROOT__="./"', 'window.__FM_STATIC_ROOT__="/freemovie-static/"')
    not_found = not_found.replace('src="./data/catalog.js"', 'src="/freemovie-static/data/catalog.js"')
    not_found = not_found.replace('src="./assets/static-runtime.js"', 'src="/freemovie-static/assets/static-runtime.js"')
    (TARGET_ROOT / "404.html").write_text(not_found, encoding="utf-8")
    (TARGET_ROOT / ".nojekyll").touch()
    print("Static export complete.")


if __name__ == "__main__":
    main()
