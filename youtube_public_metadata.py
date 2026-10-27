"""Bounded read-only metadata checks for public YouTube watch pages."""
from __future__ import annotations

import json
import re
import urllib.parse
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
DATE = re.compile(r'<meta\s+itemprop="datePublished"\s+content="(\d{4}-\d{2}-\d{2})', re.I)
VIEWS = re.compile(r'"viewCount":"(\d{1,15})"')
CACHE: dict[str, tuple[float, dict]] = {}
LOCK = threading.Lock()


def parse_watch_metadata(page: str) -> dict:
    date_match = DATE.search(page)
    view_match = VIEWS.search(page)
    return {
        "video_published_at": date_match.group(1) if date_match else None,
        "video_views": f"{int(view_match.group(1)):,}" if view_match else None,
    }


def fetch_watch_metadata(video_id: str) -> dict:
    if not VIDEO_ID.fullmatch(video_id):
        return {}
    now = time.time()
    with LOCK:
        cached = CACHE.get(video_id)
    if cached and now - cached[0] < (21_600 if any(cached[1].values()) else 600):
        return dict(cached[1])
    request = urllib.request.Request(
        f"https://www.youtube.com/watch?v={video_id}",
        headers={"User-Agent": "ResourceFinder/1.0 (local metadata lookup)",
                 "Accept": "text/html"},
    )
    try:
        with urllib.request.urlopen(request, timeout=7) as response:
            if "text/html" not in response.headers.get("Content-Type", ""):
                return {}
            page = response.read(1_600_000).decode("utf-8", "replace")
        metadata = parse_watch_metadata(page)
    except (OSError, ValueError, TimeoutError):
        metadata = {}
    with LOCK:
        CACHE[video_id] = (time.time(), metadata)
    return dict(metadata)


def fetch_many(video_ids: list[str]) -> dict[str, dict]:
    ids = list(dict.fromkeys(value for value in video_ids[:12] if VIDEO_ID.fullmatch(value)))
    with ThreadPoolExecutor(max_workers=3) as pool:
        return dict(zip(ids, pool.map(fetch_watch_metadata, ids)))



def _text(node: dict) -> str:
    if not isinstance(node, dict):
        return ""
    if isinstance(node.get("simpleText"), str):
        return node["simpleText"]
    return "".join(str(run.get("text") or "") for run in node.get("runs") or [])


def _renderers(value):
    if isinstance(value, dict):
        renderer = value.get("videoRenderer")
        if isinstance(renderer, dict):
            yield renderer
        for child in value.values():
            yield from _renderers(child)
    elif isinstance(value, list):
        for child in value:
            yield from _renderers(child)


def parse_search_page(page: str, limit: int = 30) -> list[dict]:
    marker = "var ytInitialData = "
    start = page.find(marker)
    if start < 0:
        return []
    try:
        data, _ = json.JSONDecoder().raw_decode(page[start + len(marker):])
    except (ValueError, TypeError):
        return []
    results = []
    seen = set()
    for entry in _renderers(data):
        video_id = str(entry.get("videoId") or "")
        if not VIDEO_ID.fullmatch(video_id) or video_id in seen:
            continue
        title = _text(entry.get("title") or {}).strip()
        if not title:
            continue
        seen.add(video_id)
        views = _text(entry.get("viewCountText") or {})
        count_match = re.search(r"([0-9][0-9,.]*)\s+views?", views, re.I)
        snippet = _text(entry.get("descriptionSnippet") or {})
        if not snippet:
            parts = entry.get("detailedMetadataSnippets") or []
            snippet = " ".join(_text(part.get("snippetText") or {}) for part in parts[:2])
        results.append({
            "title": title,
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "text": snippet or title,
            "author": _text(entry.get("ownerText") or {}) or None,
            "raw": {
                "view_count": int(count_match.group(1).replace(",", "")) if count_match else None,
                "published_relative": _text(entry.get("publishedTimeText") or {}) or None,
            },
        })
        if len(results) >= limit:
            break
    return results

def search_public_youtube(query: str, limit: int = 30) -> list[dict]:
    url = "https://www.youtube.com/results?" + urllib.parse.urlencode({"search_query": query})
    request = urllib.request.Request(
        url, headers={"User-Agent": "ResourceFinder/1.0 (local public video search)",
                      "Accept": "text/html"})
    with urllib.request.urlopen(request, timeout=8) as response:
        if "text/html" not in response.headers.get("Content-Type", ""):
            return []
        page = response.read(3_000_000).decode("utf-8", "replace")
    return parse_search_page(page, limit)

