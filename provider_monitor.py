"""In-process provider health metrics without storing user search queries."""
from __future__ import annotations

import statistics
import threading
from collections import deque
from datetime import datetime


class ProviderMonitor:
    def __init__(self, sources: list[str]):
        self.started = datetime.now().astimezone().isoformat()
        self.lock = threading.Lock()
        self.events = {source: deque(maxlen=30) for source in sources}
        self.last_checked = {source: None for source in sources}

    def record(self, source: str, elapsed_ms: float, count: int, error: bool,
               warning: bool = False, probe: bool = False) -> None:
        stamp = datetime.now().astimezone().isoformat()
        event = {"duration_ms": round(elapsed_ms), "count": count,
                 "error": bool(error), "warning": bool(warning), "probe": bool(probe)}
        with self.lock:
            self.events[source].append(event)
            self.last_checked[source] = stamp

    def snapshot(self) -> dict:
        with self.lock:
            data = {source: (list(events), self.last_checked[source])
                    for source, events in self.events.items()}
        providers = {}
        for source, (events, checked) in data.items():
            recent = events[-5:]
            failed = sum(bool(event["error"]) for event in recent)
            warned = sum(bool(event["warning"]) for event in recent)
            durations = sorted(event["duration_ms"] for event in recent)
            p95 = durations[max(0, int((len(durations) - 1) * .95))] if durations else None
            latency_limit = 15000 if source == "videos" else 8000
            last = recent[-1] if recent else None
            trailing_good = 0
            for event in reversed(recent):
                if event["error"] or event["warning"] or event["duration_ms"] > latency_limit:
                    break
                trailing_good += 1
            trailing_errors = 0
            for event in reversed(recent):
                if not event["error"]:
                    break
                trailing_errors += 1
            # Two fresh successes supersede old failures. A fallback never counts as a success.
            slow = bool(last and last["duration_ms"] > latency_limit)
            if not recent:
                state = "unobserved"
            elif trailing_errors >= 3:
                state = "down"
            elif last["error"] or last["warning"] or slow:
                state = "degraded"
            elif trailing_good >= 2 or len(events) == 1 or not any(
                    event["error"] or event["warning"] for event in recent):
                state = "healthy"
            else:
                state = "degraded"
            reason = ("Automatic check pending" if not recent else
                      "Recent requests failed" if state == "down" else
                      "Search provider unavailable; fallback shown" if last["warning"] else
                      "A recent request failed" if last["error"] else
                      "Recent search or check was slow" if slow else
                      "Recovery observed; confirming" if state == "degraded" else
                      ("Recovered in background" if any(
                          event["error"] or event["warning"] for event in recent[:-1]
                      ) else "Checked in background") if last["probe"] else "Responding")
            providers[source] = {
                "status": state, "reason": reason, "last_checked": checked, "requests": len(events),
                "recent_errors": failed, "recent_warnings": warned,
                "last_result_count": last["count"] if last else None,
                "last_check_type": "recovery" if last and last["probe"] else "search" if last else None,
                "median_ms": round(statistics.median(durations)) if durations else None,
                "p95_ms": p95,
            }
        return {"started": self.started, "providers": providers}
