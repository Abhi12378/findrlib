"""Conservative search-result cleanup and relevance signals."""
from __future__ import annotations

import html
import re
from urllib.parse import unquote, urlsplit

STOP = {"a", "an", "and", "best", "code", "examples", "find", "for", "free",
        "get", "how", "in", "library", "libraries", "of", "open", "resource",
        "resources", "source", "the", "to", "tool", "tools", "with", "api", "apis"}
SYNONYMS = {
    "weather": ("forecast", "meteorolog", "climate"),
    "hacking": ("security", "penetration", "cyber"),
    "deploy": ("hosting", "deployment"),
    "deployment": ("hosting", "deploy"),
    "cameras": ("camera", "imaging"),
    "camera": ("cameras", "imaging"),
}
BOILERPLATE = (
    "about press copyright contact us creators advertise",
    "how youtube works test new features",
    "terms privacy policy & safety",
)
INTENT = {
    "api": "api", "apis": "api", "sdk": "library", "library": "library",
    "libraries": "library", "package": "library", "repository": "library",
    "deploy": "platform", "deployment": "platform", "hosting": "platform",
    "video": "video", "tutorial": "video", "book": "book", "books": "book",
    "paper": "paper", "research": "paper", "documentation": "documentation",
    "docs": "documentation",
}


def canonical_query(query: str) -> str:
    """Apply narrow, verified aliases without changing the user's displayed query."""
    if re.fullmatch(r"\s*OS\s*", query, flags=re.I):
        return "operating systems"
    return re.sub(r"\bLIC[\s-]+AO\b", "LIC AAO", query, flags=re.I)


def exam_paper_query(query: str) -> bool:
    words = set(re.findall(r"\w+", canonical_query(query).casefold()))
    return bool(words & {"paper", "papers", "pyq", "pyqs"}) and bool(
        words & {"exam", "question", "previous", "past", "model", "sample", "aao"})


def search_variants(query: str, documents: bool = False) -> list[str]:
    primary = canonical_query(query).strip()
    if not exam_paper_query(query):
        return [primary]
    topic = re.sub(r"\b(?:papers?|pyqs?|pdf|question|previous|past|year|years|exam|solved|model|sample)\b",
                   " ", primary, flags=re.I)
    topic = re.sub(r"\s+", " ", topic).strip()
    if not topic:
        return [primary]
    candidates = ([f"{topic} previous year question paper filetype:pdf",
                   f"{topic} question paper PDF", primary] if documents else
                  [f"{topic} previous year question paper", primary,
                   f"{topic} solved previous papers"])
    return list(dict.fromkeys(candidates))


def query_terms(query: str) -> list[str]:
    return [word for word in re.findall(r"[\w+#.-]+", canonical_query(query).casefold())
            if len(word) > 1 and word not in STOP]


def weak_title(title: str) -> bool:
    value = (title or "").strip()
    return (not value or bool(re.match(r"^(?:https?://|www\.)", value, re.I))
            or value.casefold() in {"youtube", "watch video", "untitled", "website", "home"})


def clean_snippet(raw: str, title: str = "", limit: int = 270) -> str:
    text = html.unescape(str(raw or ""))
    text = text.replace("\ufffd", "").replace("\u200b", "")
    text = re.sub(r"\[([^]]+)\]\(https?://[^)]+\)", r"\1", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", text)
    text = text.replace("`", "").replace("**", "")
    text = re.sub(r"\s+", " ", text).strip(" .-–—")
    lower = text.casefold()
    for phrase in BOILERPLATE:
        index = lower.find(phrase)
        if index >= 0:
            text = text[:index].strip(" .-–—")
            lower = text.casefold()
    if title and text.casefold().startswith(title.casefold()):
        text = text[len(title):].lstrip(" :.-–—")
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0].rstrip(".,;:") + "…"
    return text or "Open the original source for details."


def type_intent(query: str) -> str | None:
    if exam_paper_query(query):
        return "documentation"
    for word in re.findall(r"\w+", query.casefold()):
        if word in INTENT:
            return INTENT[word]
    return None


def quality_score(item: dict, query: str) -> float:
    if not query:
        return 8.0 if item.get("source") == "Curated guide" else 0.0
    terms = query_terms(query)
    title = str(item.get("title") or "").casefold()
    description = str(item.get("description") or "").casefold()
    category = str(item.get("category") or "").casefold()
    topics = " ".join(map(str, item.get("topics") or [])).casefold()
    url_text = unquote(str(item.get("url") or "")).casefold()
    score = 0.0
    matched = 0
    for term in terms:
        variants = (term,) + SYNONYMS.get(term, ())
        if any(re.search(r"(?<!\w)" + re.escape(v) + r"\w*(?!\w)", title) for v in variants):
            score += 8
            matched += 1
        elif any(v in category for v in variants):
            score += 5
            matched += 1
        elif any(v in topics for v in variants):
            score += 3
            matched += 1
        elif any(re.search(r"(?<!\w)" + re.escape(v) + r"\w*(?!\w)", url_text) for v in variants):
            score += 3
            matched += 1
        elif any(v in description for v in variants):
            score += 2
            matched += 1
    if terms and matched < len(terms):
        score -= 8 * (len(terms) - matched)
    if terms:
        primary = terms[-1]
        variants = (primary,) + SYNONYMS.get(primary, ())
        if any(v in title for v in variants):
            score += 6
        elif any(v in category or v in topics for v in variants):
            score += 2
        elif any(v in url_text for v in variants):
            score += 2
        elif any(v in description for v in variants):
            position = min(description.find(v) for v in variants if v in description)
            score -= 2 if position < 120 else 5
    if any(term in str(item.get("language") or "").casefold() for term in terms):
        score += 2
    intent = type_intent(query)
    if intent == item.get("type"):
        score += 7
    elif intent == "api" and item.get("type") == "documentation":
        score += 3
    elif intent:
        score -= 6
    if item.get("source") == "Curated guide":
        score += 8
    if item.get("source") in {"GitHub", "Open Library", "OpenAlex"}:
        score += 1
    if (item.get("source") == "GitHub" and
            description in {"", "github repository"} and
            not item.get("stars")):
        score -= 14
    if item.get("free") is True and re.search(r"\bfree\b", query, re.I):
        score += 3
    if item.get("crawl_status") == "checked":
        score += 1
    if item.get("archived"):
        score -= 12
    if weak_title(item.get("title") or ""):
        score -= 18
    if item.get("crawl_status") == "stale":
        score -= 100
    if item.get("source") == "Wikipedia":
        score -= 4
        if intent in {"api", "library", "platform"}:
            score -= 8
    if re.search(r"\b(?:news|case|incident|controversy)\b", title) and not re.search(
            r"\b(?:news|case|incident|controversy)\b", query.casefold()):
        score -= 20
    return round(score, 2)


def stale_http_error(error: Exception) -> bool:
    return getattr(error, "code", None) in {404, 410}

