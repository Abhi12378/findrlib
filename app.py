"""Resource Finder local server. Python 3.10+; no web framework required."""
from __future__ import annotations

import argparse
import html
import json
import os
os.environ.pop("SSLKEYLOGFILE", None)
from crawler import CrawlManager
from catalog_refresh import CatalogManager
from provider_monitor import ProviderMonitor
from provider_recovery import ProviderRecovery
from quality import canonical_query, clean_snippet, exam_paper_query, quality_score, search_variants, type_intent, weak_title
from resource_enrichment import document_access, document_format, plausible_product, video_metadata
from youtube_public_metadata import fetch_many as fetch_youtube_metadata, search_public_youtube
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CATALOG_MANAGER = CatalogManager(ROOT)
GUIDES = json.loads((ROOT / "data" / "guides.json").read_text(encoding="utf-8-sig"))
def read_google_client_id() -> str:
    configured = os.environ.get("RESOURCE_FINDER_GOOGLE_CLIENT_ID", "").strip()
    if not configured:
        try:
            configured = str(json.loads((ROOT / "config.local.json").read_text(encoding="utf-8"))
                             .get("google_client_id", "")).strip()
        except (OSError, ValueError, TypeError):
            pass
    return configured if configured.endswith(".apps.googleusercontent.com") else ""


def google_cert_request(url: str, method: str = "GET", **kwargs):
    """Use the OS certificate store to fetch Google's public signing keys."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "www.googleapis.com" or method != "GET":
        raise ValueError("Unexpected certificate endpoint")
    with urllib.request.urlopen(url, timeout=8) as response:
        return SimpleNamespace(status=response.status, data=response.read(200_000),
                               headers=dict(response.headers))


def read_support_email() -> str:
    configured = os.environ.get("RESOURCE_FINDER_SUPPORT_EMAIL", "").strip()
    if not configured:
        try:
            configured = str(json.loads((ROOT / "config.local.json").read_text(encoding="utf-8"))
                             .get("support_email", "")).strip()
        except (OSError, ValueError, TypeError):
            pass
    return configured if re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", configured) else ""


GOOGLE_CLIENT_ID = read_google_client_id()
SUPPORT_EMAIL = read_support_email()
try:
    from google.oauth2 import id_token as google_id_token
    GOOGLE_AUTH_AVAILABLE = True
except ImportError:
    GOOGLE_AUTH_AVAILABLE = False

CACHE: dict[tuple[str, str, int], tuple[float, dict]] = {}
CRAWLER = CrawlManager(ROOT / "data" / "crawl_cache.sqlite3")
CACHE_LOCK = threading.Lock()
PUBLIC_FEED_CACHE: dict[str, tuple[float, list[dict] | None]] = {}
PUBLIC_FEED_LOCK = threading.Lock()
REACH_WEB_LOCK = threading.Lock()
REACH_WEB_BACKOFF_UNTIL = 0.0
STOP = {
    "a", "an", "and", "best", "code", "examples", "find", "for", "free", "get",
    "how", "in", "library", "libraries", "of", "open", "resource", "resources",
    "source", "the", "to", "tool", "tools", "with", "api", "apis",
}
SYNONYMS = {
    "pdf": ["pdf"],
    "weather": ["forecast", "meteorolog", "climate"],
    "hacking": ["security", "penetration", "cyber"],
    "deploy": ["hosting", "deployment"],
    "deployment": ["hosting", "deploy"],
    "video": ["youtube"],
    "book": ["books", "library"],
    "platform": ["hosting", "deploy", "site"],
}


def clean_query(raw: str) -> str:
    return re.sub(r"\s+", " ", raw.strip())[:400]


def tokens_for(query: str) -> list[str]:
    tokens = re.findall(r"[\w+#.-]+", canonical_query(query).lower())
    return [token for token in tokens if token not in STOP and len(token) > 1]


def contains_term(text: str, term: str) -> bool:
    suffix = r"\w*" if term == "meteorolog" else ""
    return re.search(r"(?<!\w)" + re.escape(term) + suffix + r"(?!\w)", text) is not None


def score_item(item: dict, query: str) -> int:
    if not query:
        return 1 if item.get("source") == "Curated guide" else 0
    tokens = tokens_for(query)
    if not tokens:
        return 0
    title = item["title"].lower()
    description = item.get("description", "").lower()
    category = item.get("category", "").lower()
    tags = " ".join(item.get("tags", [])).lower()
    score = 0
    matched_terms = 0
    for token in tokens:
        variants = [token] + SYNONYMS.get(token, [])
        matched = False
        for word in variants:
            if contains_term(title, word):
                score += 9
                matched = True
                break
            if contains_term(tags, word):
                score += 7
                matched = True
                break
            if contains_term(category, word):
                score += 5
                matched = True
                break
            if contains_term(description, word):
                score += 2
                matched = True
                break
        if matched:
            matched_terms += 1
    if matched_terms < len(tokens):
        return 0
    if query.lower() in title:
        score += 12
    if score <= 0:
        return 0
    if item.get("source") == "Curated guide":
        score += 4
    if re.search(r"\bfree\b", query.lower()) and item.get("free") is True:
        score += 20
    return score


def rank_live(items: list[dict], query: str) -> list[dict]:
    terms = tokens_for(query)
    ranked = []
    stale_urls = CRAWLER.stale_urls()
    for item in items:
        if item.get("url") in stale_urls:
            continue
        title = (item.get("title") or "").lower()
        text = " ".join([title, (item.get("description") or "").lower(),
                         " ".join(item.get("topics") or []).lower(),
                         urllib.parse.unquote(str(item.get("url") or "")).lower()])
        compact_query = re.sub(r"[^a-z0-9]+", "", query.casefold())
        compact_title = re.sub(r"[^a-z0-9]+", "", title)
        brand_match = len(compact_query) >= 5 and compact_query in compact_title
        matched_count = sum(any(contains_term(text, variant) for variant in
                                [term] + SYNONYMS.get(term, [])) for term in terms)
        required = len(terms) if len(terms) <= 2 else max(2, (2 * len(terms) + 2) // 3)
        if terms and not brand_match and matched_count < required:
            continue
        if "maps" in terms and item.get("type") in {"book", "library", "paper"}:
            geographic = any(word in text for word in ["geograph", "geocod", "geospatial", "location",
                                                        "navigation", "cartograph", "gis", "mapbox",
                                                        "google maps", "openstreetmap", "tile", "spatial"])
            if not geographic:
                continue
        if "free" in query.lower() and item.get("type") == "book" and item.get("free") is not True:
            continue
        item = dict(item)
        item["description"] = clean_snippet(item.get("description", ""), item.get("title", ""))
        item["relevance_score"] = quality_score(item, query)
        if brand_match:
            item["relevance_score"] = max(item["relevance_score"], 14.0)
        if item["relevance_score"] <= 0:
            continue
        if item.get("source") == "Wikipedia" and type_intent(query) in {"api", "library", "platform"}:
            continue
        ranked.append(item)
    return sorted(ranked, key=lambda item: -item["relevance_score"])


def catalog_search(query: str, offset: int, limit: int) -> dict:
    catalog = CATALOG_MANAGER.snapshot()
    stale_urls = CRAWLER.stale_urls()
    candidates = [item for item in GUIDES + catalog if item.get("url") not in stale_urls]
    ranked = [(quality_score(item, query), item) for item in candidates
              if score_item(item, query) > 0]
    ranked = [(score, item) for score, item in ranked if score > 0 or not query]
    ranked.sort(key=lambda entry: (-entry[0], entry[1]["title"].lower()))
    return {
        "items": [{**item, "relevance_score": score}
                  for score, item in ranked[offset:offset + limit]],
        "total": len(ranked),
        "offset": offset,
        "limit": limit,
        "catalog_count": len(catalog),
    }


def fetch_json(url: str, timeout: int = 10) -> dict:
    headers = {"User-Agent": "ResourceFinder/1.0 (local personal research app)"}
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


OPENALEX_BACKOFF_LOCK = threading.Lock()
OPENALEX_BACKOFF_UNTIL = 0.0


BRAVE_CACHE_LOCK = threading.RLock()
BRAVE_CACHE: dict[tuple[str, int], tuple[float, dict]] = {}


def brave_search_key() -> str:
    key = os.environ.get("RESOURCE_FINDER_BRAVE_SEARCH_API_KEY", "").strip()
    if not key:
        try:
            key = str(json.loads((ROOT / "config.local.json").read_text(encoding="utf-8"))
                      .get("brave_search_api_key", "")).strip()
        except (OSError, ValueError, TypeError):
            pass
    return key


def brave_web_search(query: str, page: int = 1) -> dict | None:
    """Use the supported Web Search API when its server-side key is configured."""
    key = brave_search_key()
    if not key:
        return None
    if page < 1 or page > 10:
        return {"ok": True, "items": [], "has_more": False, "backend": "Brave Search API"}
    cache_key = (query.casefold(), page)
    with BRAVE_CACHE_LOCK:
        cached = BRAVE_CACHE.get(cache_key)
        if cached and time.monotonic() - cached[0] < 60:
            return cached[1]
    params = urllib.parse.urlencode({"q": query, "count": 20, "offset": page - 1,
                                    "result_filter": "web", "text_decorations": "false"})
    request = urllib.request.Request("https://api.search.brave.com/res/v1/web/search?" + params,
                                     headers={"Accept": "application/json",
                                              "X-Subscription-Token": key,
                                              "User-Agent": "ResourceFinder/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.load(response)
        web = payload.get("web") or {}
        items = [{"title": item.get("title"), "url": item.get("url"),
                  "text": item.get("description") or "",
                  "published_at": item.get("page_age")}
                 for item in web.get("results") or [] if item.get("title") and item.get("url")]
        result = {"ok": True, "items": items, "has_more": page < 10 and len(items) >= 15,
                  "backend": "Brave Search API"}
    except urllib.error.HTTPError as error:
        result = {"ok": False, "items": [], "error": {"code": "RATE_LIMITED" if error.code == 429
                  else "UPSTREAM_ERROR", "message": f"Search API returned {error.code}"}}
    except (OSError, ValueError, TypeError):
        result = {"ok": False, "items": [], "error": {"code": "UPSTREAM_ERROR",
                  "message": "Search API is temporarily unavailable."}}
    with BRAVE_CACHE_LOCK:
        BRAVE_CACHE[cache_key] = (time.monotonic(), result)
    return result


def public_feed_search(query: str) -> list[dict] | None:
    """Read a small public RSS search feed when the main web index is unavailable."""
    key = query.casefold()
    with PUBLIC_FEED_LOCK:
        cached = PUBLIC_FEED_CACHE.get(key)
    if cached and time.time() - cached[0] < (600 if cached[1] else 45):
        return cached[1]
    url = "https://www.bing.com/search?" + urllib.parse.urlencode(
        {"format": "rss", "q": query})
    request = urllib.request.Request(url, headers={
        "User-Agent": "ResourceFinder/1.0 (user-initiated search)",
        "Accept": "application/rss+xml, application/xml, text/xml",
    })
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            raw = response.read(600_000)
        root = ET.fromstring(raw)
        items = []
        for entry in root.findall("./channel/item"):
            title = (entry.findtext("title") or "").strip()
            link = (entry.findtext("link") or "").strip()
            description = (entry.findtext("description") or "").strip()
            if not title or not link.startswith(("https://", "http://")):
                continue
            items.append({"title": title, "url": link, "text": description})
        result = items[:20]
    except (OSError, ValueError, ET.ParseError):
        result = None
    with PUBLIC_FEED_LOCK:
        PUBLIC_FEED_CACHE[key] = (time.time(), result)
    return result


FEED_FILLER = {"a", "an", "and", "best", "find", "for", "of", "resources", "the", "to"}


def relevant_feed_items(items: list[dict], query: str) -> list[dict]:
    """Keep feed hits that contain the user's substantive terms or exact brand."""
    terms = [word for word in re.findall(r"[\w+#.-]+", canonical_query(query).casefold())
             if len(word) > 1 and word not in FEED_FILLER]
    compact_query = re.sub(r"[^a-z0-9]+", "", query.casefold())
    filtered = []
    for item in items:
        content = " ".join([str(item.get("title") or ""), str(item.get("text") or ""),
                            urllib.parse.unquote(str(item.get("url") or ""))]).casefold()
        compact_content = re.sub(r"[^a-z0-9]+", "", content)
        matched = sum(contains_term(content, term) for term in terms)
        needed = len(terms) if len(terms) <= 3 else max(3, (3 * len(terms) + 3) // 4)
        if (terms and matched >= needed) or (len(compact_query) >= 5 and
                                             compact_query in compact_content):
            filtered.append(item)
    return filtered


def relevant_feed_search(query: str, relevance_query: str | None = None) -> list[dict]:
    relevance_query = relevance_query or query
    variants = [query]
    words = [word for word in query.split() if word.casefold() not in FEED_FILLER]
    if "api" in [word.casefold() for word in words] and words[-1].casefold() != "api":
        variant = " ".join([word for word in words if word.casefold() != "api"] + ["API"])
        if variant.casefold() != query.casefold():
            variants.append(variant)
    if len(words) == 2 and all(len(word) <= 5 for word in words):
        compact = "".join(words)
        if compact.casefold() != query.casefold():
            variants.append(compact)
    if type_intent(query) in {"api", "library", "platform"}:
        for item in catalog_search(query, 0, 2)["items"]:
            title = str(item.get("title") or "").strip()
            if 3 <= len(title) <= 70 and title.casefold() not in {v.casefold() for v in variants}:
                variants.append(title)
    for variant in variants:
        feed = public_feed_search(variant)
        if feed:
            filtered = relevant_feed_items(feed, relevance_query)
            if filtered:
                return filtered
    return []


def reach_executable() -> str | None:
    """Find Reach when a Windows app is opened without the user's shell PATH."""
    found = shutil.which("agent-reach")
    if found:
        return found
    local = Path.home() / ".local" / "bin" / ("agent-reach.exe" if os.name == "nt" else "agent-reach")
    return str(local) if local.is_file() else None


def reach_error_code(result: dict) -> str | None:
    error = result.get("error")
    return str(error.get("code")) if isinstance(error, dict) and error.get("code") else None


def reach_search(channel: str, query: str, limit: int = 7, backend: str | None = None) -> dict:
    """Avoid queueing repeated browser-backed web failures across source tabs."""
    global REACH_WEB_BACKOFF_UNTIL
    if channel != "web":
        return _reach_search_once(channel, query, limit, backend)
    with REACH_WEB_LOCK:
        if time.monotonic() < REACH_WEB_BACKOFF_UNTIL:
            return {"ok": False, "items": [], "error": {
                "code": "BACKOFF", "message": "Web index is temporarily unavailable."}}
        result = _reach_search_once(channel, query, limit, backend)
        if not result.get("ok"):
            error = result.get("error") or {}
            retry_after = error.get("retry_after_seconds") if isinstance(error, dict) else None
            try:
                delay = float(retry_after)
            except (TypeError, ValueError):
                delay = 60.0
            REACH_WEB_BACKOFF_UNTIL = time.monotonic() + min(300.0, max(60.0, delay))
        return result


def _reach_search_once(channel: str, query: str, limit: int = 7, backend: str | None = None) -> dict:
    executable = reach_executable()
    if not executable:
        return {"ok": False, "items": [], "error": {"message": "Agent Reach is not installed."}}
    command = [executable, channel, "search", query, "--limit", str(limit), "--timeout", "13"]
    if backend:
        command += ["--backend", backend]
    environment = os.environ.copy()
    environment.pop("SSLKEYLOGFILE", None)
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=17, env=environment, stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        return json.loads(lines[-1]) if lines else {
            "ok": False, "items": [], "error": {"message": completed.stderr[-500:] or "No response"}
        }
    except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError) as error:
        return {"ok": False, "items": [], "error": {"message": str(error)}}


def github_fallback(query: str, page: int = 1) -> dict:
    url = "https://api.github.com/search/repositories?" + urllib.parse.urlencode({
        "q": query, "per_page": 20, "page": page
    })
    data = fetch_json(url)
    items = [{
        "title": repo.get("full_name", "Repository"),
        "url": repo.get("html_url", ""),
        "text": repo.get("description") or "GitHub repository",
        "author": (repo.get("owner") or {}).get("login"),
        "raw": {
            "language": repo.get("language"),
            "stargazers_count": repo.get("stargazers_count"),
            "license": (repo.get("license") or {}).get("spdx_id"),
            "archived": repo.get("archived"),
        },
    } for repo in data.get("items", [])]
    return {"items": items, "total": min(data.get("total_count", 0), 1000)}


def youtube_video_id(url: str) -> str | None:
    """Accept only public YouTube video URLs with a normal 11-character ID."""
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or "").lower()
    parts = parsed.path.strip("/").split("/")
    video_id = ""
    if host in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}:
        if parsed.path == "/watch":
            video_id = urllib.parse.parse_qs(parsed.query).get("v", [""])[0]
        elif len(parts) == 2 and parts[0] in {"shorts", "live", "embed"}:
            video_id = parts[1]
    elif host in {"youtu.be", "www.youtu.be"} and len(parts) == 1:
        video_id = parts[0]
    return video_id if re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id) else None


def normalize_reach(items: list[dict], kind: str, direct_video: bool = False) -> list[dict]:
    output = []
    for index, item in enumerate(items):
        url = item.get("url") or ""
        if not url.startswith(("https://", "http://")):
            continue
        raw = item.get("raw") or {}
        license_name = raw.get("license")
        video_id = youtube_video_id(url) if kind == "video" else None
        if kind == "video":
            if not video_id:
                continue
            url = f"https://www.youtube.com/watch?v={video_id}"
        title = str(item.get("title") or "").strip()
        if kind in {"video", "website"} and weak_title(title):
            continue
        description = clean_snippet(item.get("text") or "", title)
        output.append({
            "id": f"{kind}-{index}-{abs(hash(url))}",
            "title": title or url,
            "description": description,
            "url": url,
            "type": kind,
            "source": "GitHub" if kind == "library" else ("YouTube" if kind == "video" else "Web"),
            "category": "Repository" if kind == "library" else ("Video" if kind == "video" else "Website"),
            "author": item.get("author"),
            "language": raw.get("language") if kind == "library" else None,
            "stars": raw.get("stargazers_count") if kind == "library" else None,
            "license": license_name,
            "open_source": bool(license_name and license_name != "NOASSERTION") if kind == "library" else None,
            "free": True if kind == "library" and license_name and license_name != "NOASSERTION" else None,
            "key_required": False if kind == "library" else None,
            "published_at": item.get("published_at"),
            "archived": bool(raw.get("archived")),
            "thumbnail_url": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg" if video_id else None,
            **(video_metadata(item, direct=direct_video) if kind == "video" else {}),
        })
    return output


def search_github(query: str, page: int = 1) -> dict:
    try:
        data = github_fallback(canonical_query(query), page)
        return {"items": rank_live(normalize_reach(data["items"], "library"), query), "provider": "GitHub API",
                "page": page, "has_more": page * 20 < data["total"], "total": data["total"]}
    except Exception:
        if page > 1:
            raise
        result = reach_search("github", canonical_query(query), limit=20, backend="github-api")
        items = result.get("items", []) if result.get("ok") else []
        return {"items": rank_live(normalize_reach(items, "library"), query), "provider": "Agent Reach · GitHub",
                "page": page, "has_more": False, "notice": "GitHub API is temporarily unavailable.",
                "provider_issue": not result.get("ok"), "provider_error_code": reach_error_code(result)}


def search_videos(query: str, page: int = 1) -> dict:
    """Use indexed video pages first; try direct search only when needed."""
    search_url = "https://www.youtube.com/results?" + urllib.parse.urlencode({"search_query": query})
    if page > 4:
        return {"items": [], "provider": "YouTube", "page": page, "has_more": False,
                "search_url": search_url}
    if page == 1:
        public_failed = False
        try:
            public = search_public_youtube(search_variants(query)[0], limit=30)
            primary = rank_live(normalize_reach(public, "video", direct_video=True), query)
            if primary:
                return {"items": primary, "provider": "Public YouTube search", "page": 1,
                        "has_more": True, "search_url": search_url,
                        "notice": "Views come from public search; exact upload dates are checked on video pages."}
        except (OSError, ValueError, TimeoutError):
            public_failed = True
        curated = rank_live([dict(item) for item in GUIDES if item.get("type") == "video"
                             and score_item(item, query) > 0], query)
        if curated:
            return {"items": curated, "provider": "Curated videos", "page": 1,
                    "has_more": True, "search_url": search_url,
                    "provider_issue": public_failed,
                    "notice": "Showing reviewed videos. Load more or open YouTube for additional results."}
    suffix = {1: "", 2: " tutorial", 3: " projects", 4: " explained"}[page]
    indexed = reach_search("web", f"site:youtube.com/watch {canonical_query(query)}{suffix}", limit=30)
    videos = rank_live(normalize_reach(indexed.get("items") or [], "video"), query) if indexed.get("ok") else []
    direct = None
    if not videos and page == 1:
        direct = reach_search("youtube", canonical_query(query), limit=30)
        videos = rank_live(normalize_reach(direct.get("items") or [], "video", direct_video=True), query) if direct.get("ok") else []
        if videos:
            return {"items": videos, "provider": "Agent Reach · YouTube", "page": 1,
                    "has_more": True, "search_url": search_url}
    result = {"items": videos, "provider": "Web indexed YouTube" if videos else "YouTube search",
              "page": page, "has_more": bool(videos) and page < 4, "search_url": search_url}
    if not videos:
        curated = rank_live([dict(item) for item in GUIDES if item.get("type") == "video"
                             and score_item(item, query) > 0], query) if page == 1 else []
        if curated:
            result.update({"items": curated, "provider": "Curated videos", "has_more": False,
                           "notice": "Live video indexing is limited; showing reviewed videos. Open YouTube for more.",
                           "provider_issue": not indexed.get("ok"),
                           "provider_error_code": reach_error_code(direct or indexed)})
        elif not indexed.get("ok"):
            result.update({"notice": "Video indexing is unavailable right now. Open YouTube search for more videos.",
                           "provider_issue": True, "provider_error_code": reach_error_code(direct or indexed),
                           "error": direct is None or not direct.get("ok")})
        else:
            result["notice"] = "No matching indexed video pages. Open YouTube for its full search."
    elif page == 1:
        result["notice"] = "Showing video pages found by the web index. Open YouTube for its full search."
    return result


def wikipedia_search(query: str, page: int) -> dict:
    limit = 20
    url = "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode({
        "action": "query", "list": "search", "srsearch": query, "format": "json",
        "srlimit": limit, "sroffset": (page - 1) * limit
    })
    data = fetch_json(url)
    items = []
    for entry in data.get("query", {}).get("search", []):
        snippet = html.unescape(re.sub(r"<[^>]+>", "", entry.get("snippet", "")))
        items.append({"id": "wiki-" + str(entry["pageid"]), "title": entry["title"],
                      "description": snippet or "Read this topic on Wikipedia.",
                      "url": "https://en.wikipedia.org/?curid=" + str(entry["pageid"]),
                      "type": "website", "source": "Wikipedia", "category": "Reference",
                      "free": True, "open_source": True, "key_required": None, "language": None})
    total = data.get("query", {}).get("searchinfo", {}).get("totalhits", 0)
    return {"items": rank_live(items, query), "provider": "Wikipedia", "page": page,
            "has_more": page * limit < total, "total": total}


def search_web(query: str, page: int = 1) -> dict:
    variants = search_variants(query)
    search_url = "https://www.google.com/search?" + urllib.parse.urlencode({"q": variants[0]})
    brave = brave_web_search(variants[0], page)
    if brave and brave.get("ok"):
        ranked = rank_live(normalize_reach(brave.get("items") or [], "website"), query)
        if ranked:
            return {"items": ranked, "provider": "Brave Search API", "page": page,
                    "has_more": brave.get("has_more", False), "search_url": search_url}
    if page == 1:
        primary = reach_search("web", variants[0], limit=15)
        if primary.get("ok") and primary.get("items"):
            ranked = rank_live(normalize_reach(primary["items"], "website"), query)
            if ranked:
                return {"items": ranked, "provider": "Agent Reach · Web", "page": 1,
                        "has_more": True, "search_url": search_url,
                        "notice": "More sources are available through the public web feed."}
    else:
        primary = {"ok": False}
    with CACHE_LOCK:
        first_page = CACHE.get(("web", query.casefold(), 1))
    first_items = first_page[1].get("items", []) if first_page else []
    exam_context = sum(bool(re.search(r"\b(?:exam|recruitment|syllabus|admit card)\b",
                                   (item.get("title", "") + " " + item.get("description", "")).casefold()))
                       for item in first_items[:10]) >= 2
    variants = ({1: "", 2: " exam", 3: " syllabus", 4: " previous papers PDF"} if exam_context else
                {1: "", 2: " guide", 3: " tutorial", 4: " documentation"})
    if page in variants:
        feed_query = search_variants(query)[0] + variants[page] if page > 1 else search_variants(query)[0]
        feed = relevant_feed_search(feed_query, query)
        if feed:
            ranked = rank_live(normalize_reach(feed, "website"), query)
            # An official top result can use an expanded organization name instead
            # of the query's acronym; preserve it when the search feed ranks it first.
            for candidate in normalize_reach(feed[:3], "website"):
                host = urllib.parse.urlsplit(candidate["url"]).hostname or ""
                official = host.endswith((".gov", ".gov.in", ".nic.in", ".nic.co.in"))
                if official and len(ranked) >= 3 and candidate["url"] not in {item["url"] for item in ranked}:
                    candidate["relevance_score"] = 28.0
                    ranked.append(candidate)
            if page > 1:
                with CACHE_LOCK:
                    previous = [CACHE.get(("web", query.casefold(), index))
                                for index in range(1, page)]
                prior_urls = {item["url"] for entry in previous if entry
                              for item in entry[1].get("items", [])}
                ranked = [item for item in ranked if item["url"] not in prior_urls]
            ranked.sort(key=lambda item: -item["relevance_score"])
            if ranked:
                return {"items": ranked, "provider": "Public web feed", "page": page,
                        "has_more": page < 4, "search_url": search_url,
                        "notice": "Public web feed results; check original pages for current details."}
    if page == 1:
        curated = rank_live([item for item in GUIDES if item.get("type") == "website"
                             and score_item(item, query) > 0], query)
        if curated:
            return {"items": curated, "provider": "Verified resource pages", "page": page,
                    "has_more": False, "search_url": search_url,
                    "provider_issue": not primary.get("ok"),
                    "provider_error_code": reach_error_code(primary),
                    "notice": "Live web indexing is limited; showing verified resource pages."}
    try:
        fallback = wikipedia_search(canonical_query(query), page if page == 1 else page - 1)
        fallback["page"] = page
        fallback["search_url"] = search_url
        fallback["provider_issue"] = not primary.get("ok")
        fallback["provider_error_code"] = reach_error_code(primary)
        fallback["notice"] = ("Live web indexing is unavailable; showing reference pages and a broader search link."
                              if fallback["provider_issue"] else
                              "No matching live pages; showing reference pages and a broader search link.")
        return fallback
    except Exception:
        return {"items": [], "provider": "Web search", "page": page, "has_more": False,
                "search_url": search_url, "notice": "Live web search is unavailable.",
                "provider_issue": True, "provider_error_code": reach_error_code(primary),
                "error": True}


def search_documents(query: str, page: int = 1) -> dict:
    """Indexed public PDF, Word, and PowerPoint files; access labels cite evidence."""
    expanded = search_variants(query, documents=True)
    search_url = "https://www.google.com/search?" + urllib.parse.urlencode(
        {"q": expanded[0] if exam_paper_query(query) else f"{query} PDF DOCX PPTX documents"})
    searches = ({1: expanded[0], 2: expanded[1] if len(expanded) > 1 else expanded[0],
                 3: f"{canonical_query(query)} Word DOCX", 4: f"{canonical_query(query)} PPTX"}
                if exam_paper_query(query) else {
        1: f"{query} PDF DOCX PPTX presentation documents download",
        2: f"{query} Word document DOCX download",
        3: f"{query} PowerPoint PPTX presentation download",
        4: f"{query} PDF guide manual download",
    })
    if page not in searches:
        return {"items": [], "provider": "Indexed documents", "page": page,
                "has_more": False, "search_url": search_url}
    result = brave_web_search(searches[page])
    if not result or not result.get("ok"):
        indexed = reach_search("web", searches[page], limit=50)
        if indexed.get("ok") or not result:
            result = indexed
    # Add direct files from the public feed even when the main index responds
    # with only article pages. Deduplicate before ranking.
    feed = relevant_feed_items(public_feed_search(searches[page]) or [], query)
    sources = list(result.get("items") or []) if result.get("ok") else []
    known_urls = {source.get("url") for source in sources}
    for source in feed or []:
        if source.get("url") not in known_urls:
            sources.append(source)
            known_urls.add(source.get("url"))
    result = {"ok": bool(result.get("ok") or feed), "items": sources,
              "error": result.get("error")}
    documents = []
    if result.get("ok"):
        for index, source in enumerate(result.get("items") or []):
            url = str(source.get("url") or "")
            title = str(source.get("title") or "").strip()
            if weak_title(title) or not url.startswith(("https://", "http://")):
                continue
            file_format = document_format(url)
            access, access_note = document_access(source, file_format)
            if not file_format:
                if access != "paid":
                    continue
                label = (title + " " + str(source.get("text") or "")[:150]).casefold()
                file_format = ("PDF" if re.search(r"\bpdf\b", label) else
                               "Word" if re.search(r"\b(?:word|docx?)\b", label) else
                               "PowerPoint" if re.search(r"\b(?:powerpoint|pptx?)\b", label) else None)
                if not file_format:
                    continue
            documents.append({
                "id": f"document-{page}-{index}-{abs(hash(url))}",
                "title": title,
                "description": clean_snippet(source.get("text") or "", title),
                "url": url, "type": "documentation", "source": "Web document",
                "category": file_format + " file", "file_format": file_format,
                "access_status": access, "access_note": access_note,
                "free": True if access == "free" else False if access == "paid" else None,
                "open_source": None, "key_required": None, "language": None,
                "published_at": source.get("published_at"),
            })
    if page == 1:
        documents.extend(dict(item) for item in GUIDES
                         if item.get("type") == "documentation" and
                         item.get("file_format") and score_item(item, query) > 0)
    return {"items": rank_live(documents, query), "provider": "Indexed documents",
            "page": page, "has_more": page < 4 and bool(result.get("ok")),
            "search_url": search_url, "provider_issue": not result.get("ok"),
            "provider_error_code": reach_error_code(result),
            "notice": "Document search is unavailable right now." if not result.get("ok") else
                      "Free access means the public index read the file; reuse rights and current availability need checking."}


def official_tool_pages(query: str) -> list[dict]:
    """Publisher pages that stay available when a public web index misses them."""
    if not re.search(r"\b(?:chat\s*-?\s*gpt|codex)\b", query, re.I):
        return []
    return [
        {"id": "tool-chatgpt-official", "title": "ChatGPT",
         "description": "Official ChatGPT website for AI chat, writing, research, and apps, with links to download options.",
         "url": "https://chatgpt.com/", "type": "platform", "source": "OpenAI", "category": "App",
         "topics": ["chatgpt", "codex"], "free": None, "open_source": None,
         "key_required": None, "language": None},
        {"id": "tool-codex-official", "title": "Codex — app download",
         "description": "Official OpenAI Codex page with app downloads and web access through ChatGPT plans.",
         "url": "https://openai.com/codex/", "type": "platform", "source": "OpenAI", "category": "App",
         "topics": ["chatgpt", "codex"], "free": None, "open_source": None,
         "key_required": None, "language": None},
    ]


def search_tools(query: str, page: int = 1) -> dict:
    """Find product homepages and download pages for the Tools & apps view."""
    search_url = "https://www.google.com/search?" + urllib.parse.urlencode(
        {"q": f"{query} official app download"})
    if page > 1:
        return {"items": [], "provider": "Tools and apps", "page": page,
                "has_more": False, "search_url": search_url}
    product_query = f"{canonical_query(query)} official tools apps platforms"
    result = brave_web_search(product_query)
    if not result or not result.get("ok"):
        indexed = reach_search("web", product_query, limit=30)
        if indexed.get("ok") or not result:
            result = indexed
    if not result.get("ok") or not result.get("items"):
        feed = relevant_feed_search(f"{query} official tools apps") or relevant_feed_search(query)
        if feed:
            result = {"ok": True, "items": feed, "backend": "public feed"}
    candidates = normalize_reach(result.get("items") or [], "website") if result.get("ok") else []
    if not candidates:
        with CACHE_LOCK:
            cached_web = CACHE.get(("web", query.casefold(), 1))
        if cached_web:
            candidates = cached_web[1].get("items") or []
    tools = official_tool_pages(query)
    seen = {item["url"].rstrip("/").casefold() for item in tools}

    def add_product(item: dict) -> None:
        if not plausible_product(item):
            return
        item = dict(item)
        url = item["url"].rstrip("/").casefold()
        if url in seen:
            return
        seen.add(url)
        title = item["title"].casefold()
        item["type"] = "platform"
        item["category"] = ("App" if re.search(r"\bapps?\b", title) else
                            "Tool" if re.search(r"\btools?\b", title) else "Platform")
        item["source"] = "Web · product"
        item["id"] = "platform-" + str(abs(hash(item["url"])))
        tools.append(item)

    for item in candidates:
        add_product(item)
    search_ok = bool(result.get("ok"))
    if len(tools) < 3:
        broad = brave_web_search(canonical_query(query))
        if not broad or not broad.get("ok"):
            broad = reach_search("web", canonical_query(query), limit=30)
        if broad.get("ok"):
            search_ok = True
            for item in normalize_reach(broad.get("items") or [], "website"):
                add_product(item)
    ranked = rank_live(tools, query)
    return {"items": ranked, "provider": "Tools and apps",
            "page": 1, "has_more": False, "search_url": search_url,
            "provider_issue": not search_ok, "provider_error_code": reach_error_code(result),
            "notice": "Tool search is unavailable right now." if not search_ok and not ranked else
                      "No matching dedicated tools found for this query." if not ranked else
                      "Open each product page to confirm pricing and features."}


def search_books(query: str, page: int = 1) -> dict:
    url = "https://openlibrary.org/search.json?" + urllib.parse.urlencode({
        "q": canonical_query(query), "limit": 20, "offset": (page - 1) * 20,
        "fields": "key,title,author_name,first_publish_year,ebook_access,has_fulltext,public_scan_b,cover_i,subject"
    })
    try:
        data = fetch_json(url)
    except urllib.error.HTTPError as error:
        if error.code != 422:
            raise
        # Open Library can reject a Solr query or a requested field. Its
        # documented minimal search shape is a safe second attempt.
        basic_url = "https://openlibrary.org/search.json?" + urllib.parse.urlencode({
            "q": canonical_query(query), "limit": 20, "offset": (page - 1) * 20,
            "fields": "key,title,author_name,first_publish_year,cover_i,has_fulltext,public_scan_b",
        })
        data = fetch_json(basic_url)
    docs = data.get("docs", [])
    items = []
    for doc in docs:
        key = doc.get("key")
        if not key:
            continue
        public = doc.get("ebook_access") == "public" or doc.get("public_scan_b") is True
        items.append({
            "id": "book-" + key.replace("/", "-"),
            "title": doc.get("title") or "Untitled book",
            "description": ", ".join(doc.get("author_name", [])[:2]) or "Book record",
            "url": "https://openlibrary.org" + key,
            "type": "book", "source": "Open Library", "category": "Books",
            "author": ", ".join(doc.get("author_name", [])[:2]),
            "topics": [str(topic)[:80] for topic in doc.get("subject", [])[:8]],
            "year": doc.get("first_publish_year"), "free": True if public else None,
            "availability": "Read online" if public else (
                "Borrow or preview" if doc.get("has_fulltext") else "Catalog record"
            ),
            "open_source": None, "key_required": None, "language": None,
        })
    total = data.get("numFound", data.get("num_found", 0))
    return {"items": rank_live(items, query), "provider": "Open Library", "page": page,
            "has_more": page * 20 < total, "total": total}


def search_crossref_papers(query: str, page: int = 1) -> dict:
    """Fallback scholarly metadata; a DOI record does not prove free full text."""
    params = urllib.parse.urlencode({"query.title": canonical_query(query), "rows": 20,
                                     "offset": (page - 1) * 20})
    data = fetch_json("https://api.crossref.org/works?" + params)
    message = data.get("message") or {}
    items = []
    for work in message.get("items") or []:
        title = (work.get("title") or [""])[0]
        doi = work.get("DOI")
        url = "https://doi.org/" + doi if doi else work.get("URL")
        if not title or not url:
            continue
        parts = (work.get("published") or {}).get("date-parts") or []
        year = parts[0][0] if parts and parts[0] else None
        venue = (work.get("container-title") or [""])[0]
        items.append({"id": "crossref-" + (doi or url), "title": title,
                      "description": venue or "Scholarly publication record; full-text access not verified.",
                      "url": url, "type": "paper", "source": "Crossref",
                      "category": "Research paper", "year": year, "free": None,
                      "open_source": None, "key_required": None, "language": None})
    total = int(message.get("total-results") or 0)
    return {"items": rank_live(items, query), "provider": "Crossref · citations",
            "page": page, "has_more": page * 20 < min(total, 200), "total": total,
            "notice": "Crossref supplies citation metadata; check the publisher for full text."}


def crossref_fallback(query: str, page: int, error_code: str) -> dict:
    try:
        result = search_crossref_papers(query, page)
        result.update({"provider_issue": True, "provider_error_code": error_code,
                       "notice": "OpenAlex is rate limited; showing Crossref citations. Full-text access is unverified."})
        return result
    except (OSError, ValueError, TypeError):
        return {"items": [], "provider": "Research papers", "page": page,
                "has_more": False, "provider_issue": True,
                "provider_error_code": error_code, "error": True,
                "notice": "Research providers are temporarily unavailable."}


def search_papers(query: str, page: int = 1) -> dict:
    params = {"search": canonical_query(query), "per-page": 20, "page": page, "filter": "open_access.is_oa:true"}
    api_key = os.environ.get("OPENALEX_API_KEY")
    if api_key:
        params["api_key"] = api_key
    global OPENALEX_BACKOFF_UNTIL
    with OPENALEX_BACKOFF_LOCK:
        cooling_down = time.monotonic() < OPENALEX_BACKOFF_UNTIL
    if cooling_down:
        return crossref_fallback(query, page, "RATE_LIMITED")
    try:
        data = fetch_json("https://api.openalex.org/works?" + urllib.parse.urlencode(params))
    except urllib.error.HTTPError as error:
        if error.code == 429:
            retry_after = error.headers.get("Retry-After") if error.headers else None
            try:
                delay = min(86_400, max(60, int(retry_after)))
            except (TypeError, ValueError):
                delay = 300
            with OPENALEX_BACKOFF_LOCK:
                OPENALEX_BACKOFF_UNTIL = time.monotonic() + delay
            return crossref_fallback(query, page, "RATE_LIMITED")
        raise
    items = []
    for work in data.get("results", []):
        oa = work.get("open_access") or {}
        location = work.get("best_oa_location") or {}
        full_text = location.get("pdf_url") or oa.get("oa_url") or location.get("landing_page_url")
        if not full_text:
            continue
        items.append({
            "id": "paper-" + work.get("id", "").rsplit("/", 1)[-1],
            "title": work.get("title") or "Untitled paper",
            "description": (work.get("primary_topic") or {}).get("display_name") or "Open-access research paper",
            "url": work.get("doi") or work.get("id"),
            "pdf_url": full_text,
            "type": "paper", "source": "Research paper", "category": "Papers & PDFs",
            "year": work.get("publication_year"), "free": True, "open_source": None,
            "key_required": False, "language": work.get("language"),
        })
    total = data.get("meta", {}).get("count", 0)
    ranked = rank_live(items, query)
    return {"items": ranked, "provider": "Research paper · open access", "page": page,
            "has_more": bool(ranked) and page * 20 < min(total, 10_000), "total": total}


SEARCHERS = {
    "github": search_github,
    "videos": search_videos,
    "web": search_web,
    "books": search_books,
    "papers": search_papers,
    "documents": search_documents,
    "tools": search_tools,
}
PROVIDERS = ProviderMonitor(list(SEARCHERS))
RECOVERY = ProviderRecovery(PROVIDERS, SEARCHERS)


def schedule_status() -> dict:
    try:
        data = json.loads((ROOT / "data" / "schedule_status.json").read_text(encoding="utf-8-sig"))
        return {"installed": True, "task_name": str(data.get("task_name", "")),
                "next_run": data.get("next_run")}
    except (OSError, ValueError, TypeError):
        return {"installed": False}


def live_search(source: str, query: str, page: int = 1) -> dict:
    key = (source, query.casefold(), page)
    now = time.time()
    with CACHE_LOCK:
        cached = CACHE.get(key)
    if cached and now - cached[0] < (45 if cached[1].get("error") or not cached[1].get("items") else 900):
        return {**cached[1], "cached": True}
    started = time.perf_counter()
    try:
        result = SEARCHERS[source](query, page)
    except Exception as error:
        error_code = ("RATE_LIMITED" if isinstance(error, urllib.error.HTTPError) and error.code == 429
                      else "PROVIDER_UNAVAILABLE")
        result = {"items": [], "provider": source.title(),
                  "notice": "This source is temporarily unavailable.",
                  "provider_error_code": error_code,
                  "page": page, "has_more": False, "error": True}
    PROVIDERS.record(source, (time.perf_counter() - started) * 1000,
                     len(result.get("items") or []), bool(result.get("error")),
                     bool(result.get("provider_issue")))
    with CACHE_LOCK:
        CACHE[key] = (now, result)
    return result


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format_string: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), format_string % args))

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        origin = self.headers.get("Origin", "")
        allowed_origins = {f"http://127.0.0.1:{self.server.server_port}",
                           f"http://localhost:{self.server.server_port}"}
        if origin not in allowed_origins:
            return self.send_json({"error": "Invalid origin"}, 403)
        if self.path == "/api/catalog/refresh":
            started = CATALOG_MANAGER.request_refresh()
            return self.send_json({"started": started, "catalog_refresh": CATALOG_MANAGER.status()})
        if self.path == "/api/auth/google":
            if not GOOGLE_CLIENT_ID or not GOOGLE_AUTH_AVAILABLE:
                return self.send_json({"error": "Google sign-in is not configured"}, 503)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > 12_000:
                    return self.send_json({"error": "Invalid request size"}, 400)
                credential = str(json.loads(self.rfile.read(length)).get("credential", ""))
                if not credential or len(credential) > 10_000:
                    return self.send_json({"error": "Invalid credential"}, 400)
                claims = google_id_token.verify_oauth2_token(
                    credential, google_cert_request, GOOGLE_CLIENT_ID)
                if claims.get("iss") not in {"accounts.google.com", "https://accounts.google.com"}:
                    raise ValueError("Invalid issuer")
                return self.send_json({"sub": str(claims["sub"]),
                                       "name": str(claims.get("given_name") or claims.get("name") or "Google user")[:80],
                                       "picture": str(claims.get("picture") or "")[:500]})
            except (ValueError, KeyError, TypeError):
                return self.send_json({"error": "Google sign-in could not be verified"}, 401)
            except Exception:
                return self.send_json({"error": "Google verification is temporarily unavailable"}, 503)
        if self.path != "/api/crawl/start":
            return self.send_json({"error": "Not found"}, 404)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 40_000:
                return self.send_json({"error": "Invalid request size"}, 400)
            data = json.loads(self.rfile.read(length))
            query = clean_query(str(data.get("q", "")))
            items = data.get("items", [])
            if not query or not isinstance(items, list):
                return self.send_json({"error": "Query and items required"}, 400)
            return self.send_json({"job_id": CRAWLER.start(query, items)})
        except (ValueError, json.JSONDecodeError, TypeError):
            return self.send_json({"error": "Invalid JSON"}, 400)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/api/health":
            return self.send_json({"catalog_refresh": CATALOG_MANAGER.status(),
                                   "provider_health": PROVIDERS.snapshot(),
                                   "scheduled_refresh": schedule_status()})
        if parsed.path == "/api/status":
            return self.send_json({
                "catalog_count": len(CATALOG_MANAGER.snapshot()),
                "catalog_refresh": CATALOG_MANAGER.status(),
                "guide_count": len(GUIDES),
                "agent_reach": reach_executable() is not None,
                "sources": list(SEARCHERS),
                "background_crawler": True,
                "provider_health": PROVIDERS.snapshot(),
                "scheduled_refresh": schedule_status(),
                "google_client_id": GOOGLE_CLIENT_ID,
                "support_email": SUPPORT_EMAIL,
                "google_signin_available": bool(GOOGLE_CLIENT_ID and GOOGLE_AUTH_AVAILABLE),
            })
        if parsed.path == "/api/video/meta":
            values = urllib.parse.parse_qs(parsed.query).get("ids", [""])[0].split(",")
            if not values or len(values) > 12 or any(
                    not re.fullmatch(r"[A-Za-z0-9_-]{11}", value) for value in values):
                return self.send_json({"error": "Provide up to 12 valid video IDs"}, 400)
            return self.send_json({"items": fetch_youtube_metadata(values)})
        if parsed.path == "/api/catalog":
            params = urllib.parse.parse_qs(parsed.query)
            query = clean_query(params.get("q", [""])[0])
            try:
                offset = max(0, int(params.get("offset", ["0"])[0]))
                limit = min(120, max(1, int(params.get("limit", ["60"])[0])))
            except ValueError:
                return self.send_json({"error": "Invalid pagination"}, 400)
            return self.send_json(catalog_search(query, offset, limit))
        if parsed.path == "/api/live":
            params = urllib.parse.parse_qs(parsed.query)
            query = clean_query(params.get("q", [""])[0])
            source = params.get("source", [""])[0]
            try:
                page = int(params.get("page", ["1"])[0])
            except ValueError:
                return self.send_json({"error": "Invalid page"}, 400)
            if not query or source not in SEARCHERS or page < 1 or page > 500:
                return self.send_json({"error": "Choose a source, query and valid page"}, 400)
            return self.send_json(live_search(source, query, page))
        if parsed.path == "/api/crawl/status":
            job_id = urllib.parse.parse_qs(parsed.query).get("id", [""])[0]
            job = CRAWLER.status(job_id)
            return self.send_json(job or {"error": "Job not found"}, 200 if job else 404)
        if parsed.path == "/":
            self.path = "/index.html"
        elif parsed.path not in {"/index.html", "/styles.css", "/app.js"} and not re.fullmatch(r"/assets/icons/[a-z0-9-]+\.svg", parsed.path):
            return self.send_json({"error": "Not found"}, 404)
        return super().do_GET()


def main() -> None:
    parser = argparse.ArgumentParser(description="Resource Finder local web app")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    os.environ.pop("SSLKEYLOGFILE", None)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    CATALOG_MANAGER.start()
    RECOVERY.start()
    url = f"http://127.0.0.1:{args.port}"
    print(f"Resource Finder running at {url}", flush=True)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        RECOVERY.stop()
        CATALOG_MANAGER.stop()
        server.server_close()


if __name__ == "__main__":
    main()







