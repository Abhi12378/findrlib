"""Polite, on-demand background page inspection for Resource Finder."""
from __future__ import annotations

import hashlib
import html
import ipaddress
import json
import os
import re
import socket
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from collections import deque
from contextlib import contextmanager
from html.parser import HTMLParser
from pathlib import Path
from secrets import token_urlsafe

from quality import stale_http_error

USER_AGENT = "ResourceFinderBot/1.0 (local research; respects robots.txt)"
MAX_BYTES = 384_000
CACHE_AGE = 86_400


@contextmanager
def connect_db(path: Path):
    db = sqlite3.connect(path)
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def public_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return False
        if parsed.port and parsed.port not in {80, 443}:
            return False
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
        return bool(addresses) and all(ipaddress.ip_address(address[4][0]).is_global for address in addresses)
    except (ValueError, OSError):
        return False


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        if not public_url(newurl):
            raise urllib.error.URLError("Unsafe redirect")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


os.environ.pop("SSLKEYLOGFILE", None)
OPENER = urllib.request.build_opener(SafeRedirect)


def open_public(url: str, timeout: int = 8):
    if not public_url(url):
        raise ValueError("Private or invalid URL")
    return OPENER.open(urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,*/*;q=0.5"}), timeout=timeout)


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.description = ""
        self.text: list[str] = []
        self.main_text: list[str] = []
        self.main_depth = 0
        self.links: list[tuple[str, str]] = []
        self.skip = 0
        self.in_title = False
        self.href = ""
        self.anchor = ""

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag in {"script", "style", "noscript", "svg", "nav", "header", "footer", "aside"}:
            self.skip += 1
        if tag in {"main", "article"}:
            self.main_depth += 1
        if tag == "title":
            self.in_title = True
        if tag == "meta" and values.get("name", "").lower() in {"description", "og:description"}:
            self.description = self.description or values.get("content", "")
        if tag == "meta" and values.get("property", "").lower() == "og:description":
            self.description = self.description or values.get("content", "")
        if tag == "a":
            self.href = values.get("href", "")
            self.anchor = ""

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript", "svg", "nav", "header", "footer", "aside"}:
            self.skip = max(0, self.skip - 1)
        if tag in {"main", "article"}:
            self.main_depth = max(0, self.main_depth - 1)
        if tag == "title":
            self.in_title = False
        if tag == "a" and self.href:
            self.links.append((self.href, self.anchor.strip()))
            self.href = ""
            self.anchor = ""

    def handle_data(self, data):
        if self.skip:
            return
        value = re.sub(r"\s+", " ", data).strip()
        if not value:
            return
        if self.in_title:
            self.title += value + " "
        if self.href:
            self.anchor += value + " "
        if len(self.text) < 500:
            self.text.append(value)
        if self.main_depth and len(self.main_text) < 500:
            self.main_text.append(value)


def relevant(text: str, query: str) -> bool:
    stop = {"a", "an", "the", "for", "free", "best", "find", "resource", "resources", "api", "apis", "and", "of", "to", "in"}
    words = [word for word in re.findall(r"[\w+#.-]+", query.lower()) if word not in stop and len(word) > 1]
    haystack = text.lower()
    return bool(words) and all(word in haystack for word in words)


class CrawlManager:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.jobs: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.host_lock = threading.Lock()
        self.host_last: dict[str, float] = {}
        self.robots: dict[str, tuple[float, urllib.robotparser.RobotFileParser | None]] = {}
        with connect_db(self.db_path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS pages (url TEXT PRIMARY KEY, fetched_at REAL, title TEXT, description TEXT, links TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS link_health (url TEXT PRIMARY KEY, status TEXT, checked_at REAL)")
            columns = {column[1] for column in db.execute("PRAGMA table_info(pages)")}
            if "links" not in columns:
                db.execute("ALTER TABLE pages ADD COLUMN links TEXT")

    def stale_urls(self) -> set[str]:
        with connect_db(self.db_path) as db:
            rows = db.execute("SELECT url FROM link_health WHERE status='stale' AND checked_at>?",
                              (time.time() - CACHE_AGE,)).fetchall()
        return {row[0] for row in rows}

    def start(self, query: str, items: list[dict]) -> str:
        candidates = []
        seen = set()
        for item in items:
            url = item.get("url", "") if isinstance(item, dict) else ""
            kind = item.get("type", "") if isinstance(item, dict) else ""
            if kind not in {"website", "documentation", "platform", "api", "library"} or url in seen:
                continue
            if not url.startswith(("https://", "http://")):
                continue
            seen.add(url)
            candidates.append({"url": url, "title": str(item.get("title", ""))[:180]})
            if len(candidates) >= 24:
                break
        job_id = token_urlsafe(12)
        job = {"id": job_id, "query": query, "state": "running", "queued": len(candidates), "checked": 0,
               "updates": {}, "discovered": [], "started": time.time(), "notice": "Checking public pages in the background"}
        with self.lock:
            expired = [key for key, value in self.jobs.items() if time.time() - value["started"] > 3600]
            for key in expired:
                self.jobs.pop(key, None)
            if len(self.jobs) >= 20:
                oldest = min(self.jobs, key=lambda key: self.jobs[key]["started"])
                self.jobs.pop(oldest, None)
            self.jobs[job_id] = job
        threading.Thread(target=self._run, args=(job_id, candidates), daemon=True).start()
        return job_id

    def status(self, job_id: str) -> dict | None:
        with self.lock:
            job = self.jobs.get(job_id)
            return json.loads(json.dumps(job)) if job else None

    def _allowed(self, url: str) -> bool:
        parts = urllib.parse.urlsplit(url)
        root = f"{parts.scheme}://{parts.netloc}"
        with self.host_lock:
            cached = self.robots.get(root)
        if cached and time.time() - cached[0] < 3600:
            parser = cached[1]
        else:
            parser = urllib.robotparser.RobotFileParser()
            try:
                with open_public(root + "/robots.txt") as response:
                    if response.status == 200:
                        parser.parse(response.read(100_000).decode("utf-8", "replace").splitlines())
                    else:
                        parser = None
            except urllib.error.HTTPError as error:
                parser = None if error.code == 404 else urllib.robotparser.RobotFileParser()
            except Exception:
                parser = urllib.robotparser.RobotFileParser()
            with self.host_lock:
                self.robots[root] = (time.time(), parser)
        return parser is None or parser.can_fetch(USER_AGENT, url)

    def _wait_host(self, url: str):
        host = urllib.parse.urlsplit(url).hostname or ""
        with self.host_lock:
            delay = max(0.0, self.host_last.get(host, 0) + 1.0 - time.time())
            self.host_last[host] = time.time() + delay
        if delay:
            time.sleep(delay)

    def _inspect(self, url: str) -> tuple[dict, list[tuple[str, str]]]:
        if not public_url(url):
            return {"status": "skipped", "reason": "Private or invalid URL"}, []
        with connect_db(self.db_path) as db:
            cached = db.execute("SELECT fetched_at,title,description,links FROM pages WHERE url=?", (url,)).fetchone()
            stale = db.execute("SELECT checked_at FROM link_health WHERE url=? AND status='stale'",
                               (url,)).fetchone()
        if stale and time.time() - stale[0] < CACHE_AGE:
            return {"status": "stale", "reason": "HTTP 404/410 on recent check",
                    "checked_at": stale[0], "cached": True}, []
        if cached and cached[3] is not None and time.time() - cached[0] < CACHE_AGE:
            return {"status": "checked", "title": cached[1], "description": cached[2], "checked_at": cached[0], "cached": True}, json.loads(cached[3])
        if not self._allowed(url):
            return {"status": "skipped", "reason": "robots.txt or robots request prevented crawling"}, []
        self._wait_host(url)
        try:
            with open_public(url) as response:
                content_type = response.headers.get("Content-Type", "")
                if "text/html" not in content_type:
                    return {"status": "skipped", "reason": "Non-HTML page"}, []
                raw = response.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raw = raw[:MAX_BYTES]
                encoding = response.headers.get_content_charset() or "utf-8"
                final_url = response.geturl()
            parser = PageParser()
            parser.feed(raw.decode(encoding, "replace"))
            title = html.unescape(parser.title.strip())[:180]
            description = html.unescape(parser.description.strip() or " ".join(parser.main_text or parser.text)[:320])[:320]
            checked_at = time.time()
            links = [(urllib.parse.urljoin(final_url, href), label) for href, label in parser.links[:150]]
            with connect_db(self.db_path) as db:
                db.execute("INSERT OR REPLACE INTO pages VALUES (?,?,?,?,?)",
                           (url, checked_at, title, description, json.dumps(links)))
                db.execute("DELETE FROM link_health WHERE url=?", (url,))
            return {"status": "checked", "title": title, "description": description, "checked_at": checked_at}, links
        except urllib.error.HTTPError as error:
            if stale_http_error(error):
                checked_at = time.time()
                with connect_db(self.db_path) as db:
                    db.execute("INSERT OR REPLACE INTO link_health VALUES (?,?,?)",
                               (url, "stale", checked_at))
                return {"status": "stale", "reason": f"HTTP {error.code}", "checked_at": checked_at}, []
            return {"status": "unavailable", "reason": f"HTTP {error.code}", "checked_at": time.time()}, []
        except Exception as error:
            return {"status": "unavailable", "reason": str(error)[:100], "checked_at": time.time()}, []

    def _run(self, job_id: str, candidates: list[dict]):
        query = self.jobs[job_id]["query"]
        queue = deque((item["url"], item["title"], 0, None) for item in candidates)
        visited = set()
        found = set(item["url"] for item in candidates)
        try:
            while queue and len(visited) < 34:
                url, title, depth, found_on = queue.popleft()
                if url in visited:
                    continue
                visited.add(url)
                result, links = self._inspect(url)
                with self.lock:
                    job = self.jobs.get(job_id)
                    if not job:
                        return
                    job["checked"] += 1
                    job["updates"][url] = result
                on_topic = result["status"] == "checked" and relevant(
                    title + " " + result.get("title", "") + " " + result.get("description", ""), query)
                if depth and on_topic:
                    item = {"id": "crawl-" + hashlib.sha256(url.encode()).hexdigest()[:16],
                            "title": result.get("title") or title, "description": result.get("description") or "Checked page",
                            "url": url, "type": "website", "source": "Crawled page", "category": "Discovered link",
                            "free": None, "open_source": None, "key_required": None, "language": None,
                            "found_on": found_on, "crawl_status": "checked", "checked_at": result.get("checked_at")}
                    with self.lock:
                        job = self.jobs.get(job_id)
                        if not job:
                            return
                        job["discovered"].append(item)
                if not on_topic or depth:
                    continue
                host = urllib.parse.urlsplit(url).hostname
                added = 0
                for link, label in links:
                    parts = urllib.parse.urlsplit(link)
                    if parts.hostname != host or parts.scheme not in {"http", "https"} or link in found:
                        continue
                    if len(link) > 500 or re.search(r"\.(?:jpg|png|gif|css|js|zip|exe|mp4|pdf)(?:[?#]|$)", parts.path, re.I):
                        continue
                    if not relevant(label + " " + parts.path.replace("/", " "), query):
                        continue
                    clean = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))
                    found.add(clean)
                    with self.lock:
                        job = self.jobs.get(job_id)
                        if not job:
                            return
                        job["queued"] += 1
                    queue.append((clean, label, 1, url))
                    added += 1
                    if added >= 2 or len(found) >= 34:
                        break
            with self.lock:
                if job_id in self.jobs:
                    self.jobs[job_id]["state"] = "done"
                    self.jobs[job_id]["notice"] = "Page checks finished. Reachability and topic matching do not verify factual accuracy."
        except Exception as error:
            with self.lock:
                if job_id in self.jobs:
                    self.jobs[job_id]["state"] = "error"
                    self.jobs[job_id]["notice"] = str(error)[:180]
