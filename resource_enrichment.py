"""Conservative metadata extraction for indexed videos, files, and product pages."""
from __future__ import annotations

import re
import urllib.parse
from datetime import date

FILE_FORMATS = {
    ".pdf": "PDF", ".doc": "Word", ".docx": "Word",
    ".ppt": "PowerPoint", ".pptx": "PowerPoint",
    ".pps": "PowerPoint", ".ppsx": "PowerPoint",
}
PAID_ACCESS = re.compile(
    r"\b(?:purchase required|subscription required|paid access|pay to download|"
    r"buy (?:this|the) (?:document|file|presentation)|"
    r"(?:price|cost)\s*[:\-]\s*(?:[$€£₹]|usd\s))",
    re.IGNORECASE,
)
VIEWS = re.compile(r"\b(?:Views?|View count)\s*:\s*([0-9][0-9,.]*(?:\s*[KMB])?)\b", re.IGNORECASE)
POSTED = re.compile(
    r"\b(?:Published|Uploaded|Posted)(?: on)?\s*:\s*(\d{4}-\d{2}-\d{2})",
    re.IGNORECASE,
)


def video_metadata(item: dict, *, direct: bool = False) -> dict:
    raw = item.get("raw") or {}
    text = str(item.get("text") or "")
    count = raw.get("view_count") or raw.get("views")
    if isinstance(count, (int, float)) and count >= 0:
        views = f"{count:,}"
    elif isinstance(count, str) and re.fullmatch(r"[0-9][0-9,.]*\s*[KMB]?", count.strip(), re.I):
        views = count.strip()
    else:
        match = VIEWS.search(text)
        views = match.group(1).strip() if match else None
    upload = raw.get("upload_date") or raw.get("release_date")
    if isinstance(upload, str) and re.fullmatch(r"\d{8}", upload):
        upload = f"{upload[:4]}-{upload[4:6]}-{upload[6:]}"
    if not upload:
        match = POSTED.search(text)
        upload = match.group(1) if match else None
    if not upload and direct:
        upload = item.get("published_at")
    try:
        posted = date.fromisoformat(str(upload)[:10]).isoformat() if upload else None
    except ValueError:
        posted = None
    return {"video_views": views, "video_published_at": posted, "video_published_relative": raw.get("published_relative")}


def document_format(url: str) -> str | None:
    try:
        path = urllib.parse.unquote(urllib.parse.urlsplit(url).path).lower()
    except (ValueError, TypeError):
        return None
    return next((name for suffix, name in FILE_FORMATS.items() if path.endswith(suffix)), None)


def document_access(item: dict, file_format: str | None) -> tuple[str, str]:
    text = " ".join(str(item.get(key) or "") for key in ("title", "text"))
    if PAID_ACCESS.search(text):
        return "paid", "The indexed source explicitly says payment is required; confirm the current price there."
    # Search indexes can extract file contents only when the file was publicly readable.
    # This establishes access when indexed, not current availability or reuse rights.
    if file_format and len(str(item.get("text") or "").strip()) >= 120:
        return "free", "The public index read this file without sign-in. Availability may change; reuse rights are separate."
    return "unverified", "The search result does not establish current free or paid access."


def plausible_product(item: dict) -> bool:
    title = str(item.get("title") or "").casefold()
    url = str(item.get("url") or "")
    try:
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or "").casefold().removeprefix("www.")
    except ValueError:
        return False
    if not host or document_format(url):
        return False
    blocked_hosts = ("youtube.com", "youtu.be", "github.com", "wikipedia.org",
                     "reddit.com", "quora.com", "medium.com", "x.com", "twitter.com",
                     "gizmodo.com", "cnet.com", "techradar.com", "pcmag.com",
                     "zdnet.com", "tomsguide.com", "howtogeek.com", "makeuseof.com",
                     "softonic.com", "filehippo.com")
    if any(host == blocked or host.endswith("." + blocked) for blocked in blocked_hosts):
        return False
    if re.search(
        r"\b(?:directory|directories|\d+\s+(?:best|top)|best\s+\d+|"
        r"alternatives|reviews?|reviewed|compared|comparison|list of|roundup|"
        r"article|discover|curated|extends|introducing|what is|advertise|"
        r"tutorial|guide|log ?in|sign ?in|sign ?up|create account|register)\b", title,
    ):
        return False
    if host.startswith(("help.", "support.")):
        return False
    path = parts.path.casefold()
    if re.search(r"/(?:blog|news|articles?|index|think|learn|docs?|help|support|"
                 r"community|forum|express|press|reviews?|alternatives?|comparison|"
                 r"compare|login|signin|signup|sign-up|register|account|auth)(?:/|$)", path):
        return False
    product_path = re.search(r"/(?:products?|apps?|tools?|platform|software|downloads?)(?:/|$)", path)
    product_title = re.search(r"\b(?:app|apps|platform|tool|tools|software|product|service)\b", title)
    return bool(product_path or product_title or path in {"", "/"})
