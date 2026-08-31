"""Download public catalog APIs into static JSON/JS assets.

This runs at build time only. The deployed site reads the generated snapshot and
does not need Django or a database. `catalog.js` mirrors the JSON so the same
data also works when index.html is opened directly with the file:// protocol.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path
from urllib.parse import urlencode

import requests


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
TMDB_KEY = "aca4b5488125d1293e96c997ae62296d"
TMDB_API = "https://api.themoviedb.org/3"
TMDB_IMAGE = "https://image.tmdb.org/t/p/"
MANGADEX_API = "https://api.mangadex.org"
MANGADEX_COVERS = "https://uploads.mangadex.org/covers"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "freemovie-static-builder/1.0"})


def get_json(url: str, *, params=None) -> dict:
    response = SESSION.get(url, params=params, timeout=30)
    response.raise_for_status()
    return response.json()


def slugify(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return value or "title"


def title_url(item: dict) -> str:
    params = {
        "title": item["title"],
        "media_type": item["type"],
        "source": item.get("source", "tmdb"),
    }
    for key in ("tmdb_id", "manga_id", "anilist_id", "imdb_id"):
        if item.get(key):
            params[key] = item[key]
    media_type = str(item.get("type") or "movie")
    return f"/title/{media_type}/{slugify(item['title'])}/?" + urlencode(params)


def normalize_tmdb(entry: dict, media_type: str, source="tmdb") -> dict:
    title = entry.get("title") or entry.get("name") or "Untitled"
    date = entry.get("release_date") or entry.get("first_air_date") or ""
    item_type = "series" if media_type == "tv" else media_type
    tmdb_id = str(entry.get("id") or "")
    item = {
        "id": f"tmdb-{media_type}-{tmdb_id}",
        "title": title,
        "year": date[:4],
        "type": item_type,
        "poster": f"{TMDB_IMAGE}w342{entry['poster_path']}" if entry.get("poster_path") else "https://placehold.co/600x900/111827/e5e7eb?text=No+Poster",
        "backdrop": f"{TMDB_IMAGE}original{entry['backdrop_path']}" if entry.get("backdrop_path") else "",
        "plot": html.unescape(re.sub(r"<[^>]+>", "", entry.get("overview") or "")),
        "rating": f"{float(entry.get('vote_average') or 0):.1f}" if entry.get("vote_average") else "",
        "tmdb_id": tmdb_id,
        "imdb_id": "",
        "source": source,
        "source_label": "TMDb",
        "external_label": "TMDb",
        "external_url": f"https://www.themoviedb.org/{'tv' if media_type == 'tv' else 'movie'}/{tmdb_id}",
        "embed_url": f"https://vidsrc.in/embed/{'tv' if media_type == 'tv' else 'movie'}?tmdb={tmdb_id}",
        "has_embed": True,
    }
    item["detail_url"] = title_url(item)
    return item


def tmdb_list(path: str, media_type: str, **params) -> list[dict]:
    payload = get_json(f"{TMDB_API}{path}", params={"api_key": TMDB_KEY, "include_adult": "false", **params})
    return [normalize_tmdb(entry, media_type) for entry in payload.get("results", []) if entry.get("id")][:20]


def anilist_list(sort: str) -> list[dict]:
    query = """
    query ($sort: [MediaSort]) {
      Page(page: 1, perPage: 20) {
        media(type: ANIME, sort: $sort, isAdult: false) {
          id title { english romaji native } coverImage { extraLarge large }
          bannerImage averageScore startDate { year } description genres
        }
      }
    }
    """
    response = SESSION.post("https://graphql.anilist.co", json={"query": query, "variables": {"sort": [sort]}}, timeout=30)
    response.raise_for_status()
    entries = response.json().get("data", {}).get("Page", {}).get("media", [])
    items = []
    for entry in entries:
        titles = entry.get("title") or {}
        title = titles.get("english") or titles.get("romaji") or titles.get("native") or "Untitled"
        item = {
            "id": f"anilist-{entry.get('id')}", "title": title,
            "year": str((entry.get("startDate") or {}).get("year") or ""), "type": "anime",
            "poster": (entry.get("coverImage") or {}).get("extraLarge") or (entry.get("coverImage") or {}).get("large") or "",
            "backdrop": entry.get("bannerImage") or "", "plot": html.unescape(re.sub(r"<[^>]+>", "", entry.get("description") or "")),
            "rating": f"{float(entry.get('averageScore') or 0) / 10:.1f}" if entry.get("averageScore") else "",
            "anilist_id": str(entry.get("id") or ""), "source": "anilist", "source_label": "AniList",
            "external_label": "AniList", "external_url": f"https://anilist.co/anime/{entry.get('id')}",
            "embed_url": "", "has_embed": False,
        }
        item["detail_url"] = title_url(item)
        items.append(item)
    return items


def manga_list(order_key: str) -> list[dict]:
    params = [
        ("limit", "20"), ("includes[]", "cover_art"), (f"order[{order_key}]", "desc"),
        ("contentRating[]", "safe"), ("contentRating[]", "suggestive"), ("hasAvailableChapters", "true"),
    ]
    response = SESSION.get(f"{MANGADEX_API}/manga", params=params, timeout=30)
    response.raise_for_status()
    items = []
    for entry in response.json().get("data", []):
        attrs = entry.get("attributes") or {}
        titles = attrs.get("title") or {}
        title = titles.get("en") or next(iter(titles.values()), "Untitled")
        cover_name = ""
        for relation in entry.get("relationships") or []:
            if relation.get("type") == "cover_art":
                cover_name = (relation.get("attributes") or {}).get("fileName") or ""
                break
        manga_id = entry.get("id") or ""
        poster = f"{MANGADEX_COVERS}/{manga_id}/{cover_name}.512.jpg" if cover_name else ""
        description_map = attrs.get("description") or {}
        item = {
            "id": f"mangadex-{manga_id}", "title": title,
            "year": str(attrs.get("year") or ""), "type": "manga", "poster": poster, "backdrop": poster,
            "plot": description_map.get("en") or next(iter(description_map.values()), ""), "rating": "",
            "manga_id": manga_id, "source": "mangadex", "source_label": "MangaDex",
            "external_label": "MangaDex", "external_url": f"https://mangadex.org/title/{manga_id}",
            "embed_url": "", "has_embed": False,
        }
        item["detail_url"] = title_url(item)
        items.append(item)
    return items


def make_row(row_id: str, title: str, items: list[dict], browse_url: str, subtitle="") -> dict:
    return {"id": row_id, "title": title, "subtitle": subtitle, "items": items[:16], "browse_url": browse_url, "browse_label": "Show More"}


def build_catalog() -> dict:
    trending_movies = tmdb_list("/trending/movie/week", "movie")
    trending_series = tmdb_list("/trending/tv/week", "tv")
    top_movies = tmdb_list("/movie/top_rated", "movie", language="en-US")
    top_series = tmdb_list("/tv/top_rated", "tv", language="en-US")
    cartoons = tmdb_list("/discover/movie", "cartoon", with_genres="16", sort_by="popularity.desc")
    top_cartoons = tmdb_list("/discover/movie", "cartoon", with_genres="16", sort_by="vote_average.desc", **{"vote_count.gte": "300"})
    anime = anilist_list("TRENDING_DESC")
    top_anime = anilist_list("SCORE_DESC")
    manga = manga_list("followedCount")
    latest_manga = manga_list("updatedAt")
    rows = [
        make_row("trending-movies", "Trending Movies", trending_movies, "/browse/trending-movies/"),
        make_row("trending-series", "Trending Series", trending_series, "/browse/trending-series/"),
        make_row("trending-anime", "Trending Anime", anime, "/browse/trending-anime/"),
        make_row("trending-cartoons", "Trending Cartoons", cartoons, "/browse/trending-cartoons/"),
        make_row("trending-manga", "Trending Manga", manga, "/browse-mode/manga/", "Manga, manhwa and webcomics"),
        make_row("top-movies", "Top Movies", top_movies, "/browse/top-movies/"),
        make_row("top-series", "Top Series", top_series, "/browse/top-series/"),
        make_row("top-anime", "Top Anime", top_anime, "/browse/top-anime/"),
        make_row("top-cartoons", "Top Cartoons", top_cartoons, "/browse/top-cartoons/"),
        make_row("top-manga", "Top Manga", manga, "/browse/top-manga/"),
        make_row("latest-manga", "Latest Updated Manga", latest_manga, "/browse/latest-manga/"),
    ]
    categories = [
        {"key": "movies", "title": "Movies", "art_label": "Movie", "description": "Trending and top-rated movies.", "url": "/browse-mode/movies/", "count": len(trending_movies)},
        {"key": "series", "title": "Series", "art_label": "TV", "description": "Trending and top-rated series.", "url": "/browse-mode/series/", "count": len(trending_series)},
        {"key": "anime", "title": "Anime", "art_label": "Anime", "description": "Trending anime from AniList.", "url": "/browse-mode/anime/", "count": len(anime)},
        {"key": "cartoon", "title": "Cartoons", "art_label": "Cartoon", "description": "Popular animated movies and shows.", "url": "/browse-mode/cartoon/", "count": len(cartoons)},
        {"key": "manga", "title": "Manga", "art_label": "Manga", "description": "Manga and webcomics from MangaDex.", "url": "/browse-mode/manga/", "count": len(manga)},
        {"key": "r-rated", "title": "R Rated", "art_label": "18+", "description": "Adult catalog area.", "url": "/r-rated/", "count": 8},
    ]
    return {
        "featured_items": (trending_movies[:4] + trending_series[:4]),
        "category_cards": categories,
        "classic_cartoon_category_cards": [],
        "content_rows": rows,
        "explicit_adult_rows": [],
        "live_source_error": "",
        "has_home_content": True,
        "active_provider": "all",
        "active_provider_name": "All Services",
        "homepage_filters": {},
    }


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    catalog = build_catalog()
    encoded = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    (DATA_DIR / "catalog.json").write_text(encoded, encoding="utf-8")
    (DATA_DIR / "catalog.js").write_text("window.__FM_CATALOG__=" + encoded + ";\n", encoding="utf-8")
    rows = {row["id"]: row["items"] for row in catalog["content_rows"]}
    source_payloads = {
        "tmdb.json": {
            "trending_movies": rows["trending-movies"], "trending_series": rows["trending-series"],
            "trending_cartoons": rows["trending-cartoons"], "top_movies": rows["top-movies"],
            "top_series": rows["top-series"], "top_cartoons": rows["top-cartoons"],
        },
        "anilist.json": {"trending_anime": rows["trending-anime"], "top_anime": rows["top-anime"]},
        "mangadex.json": {"trending_manga": rows["trending-manga"], "top_manga": rows["top-manga"], "latest_manga": rows["latest-manga"]},
    }
    for filename, payload in source_payloads.items():
        (DATA_DIR / filename).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    counts = {row["id"]: len(row["items"]) for row in catalog["content_rows"]}
    print(json.dumps(counts, indent=2))


if __name__ == "__main__":
    main()
