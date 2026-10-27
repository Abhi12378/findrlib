"""Low-rate public checks for unseen and degraded providers, without user queries."""
from __future__ import annotations

import threading
import time
from typing import Callable

from provider_monitor import ProviderMonitor


PROBE_QUERIES = {
    "github": "python open source",
    "videos": "Python tutorial",
    "web": "developer documentation",
    "books": "Python programming",
    "papers": "Python programming",
    "documents": "Python programming PDF guide",
    "tools": "Python developer tools",
}
STOP_CODES = {"RATE_LIMITED", "PLATFORM_BLOCKED", "NEED_LOGIN", "BUSY"}
PROBE_ORDER = ("tools", "github", "videos", "books", "papers", "documents", "web")


class ProviderRecovery:
    def __init__(self, monitor: ProviderMonitor, searchers: dict[str, Callable],
                 clock: Callable[[], float] = time.monotonic):
        self.monitor = monitor
        self.searchers = searchers
        self.clock = clock
        self.next_probe = {source: 0.0 for source in searchers}
        self.suspended = set()
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.lock = threading.Lock()

    def check_once(self) -> list[str]:
        now = self.clock()
        states = self.monitor.snapshot()["providers"]
        checked = []
        for source in sorted(
            self.searchers,
            key=lambda item: (
                states[item]["status"] not in {"degraded", "down"},
                PROBE_ORDER.index(item) if item in PROBE_ORDER else len(PROBE_ORDER),
            ),
        ):
            searcher = self.searchers[source]
            if source not in PROBE_QUERIES:
                continue
            state = states[source]["status"]
            if state == "healthy":
                self.suspended.discard(source)
                continue
            if state not in {"unobserved", "degraded", "down"} or source in self.suspended:
                continue
            with self.lock:
                if now < self.next_probe[source]:
                    continue
                # Schedule before the call so concurrent ticks never start duplicate checks.
                self.next_probe[source] = now + 300
            started = self.clock()
            try:
                result = searcher(PROBE_QUERIES[source], 1)
            except Exception as error:
                result = {"items": [], "error": True,
                          "provider_error_code": "RATE_LIMITED" if getattr(error, "code", None) == 429 else None}
            elapsed = (self.clock() - started) * 1000
            count = len(result.get("items") or [])
            issue = bool(result.get("provider_issue"))
            failed = bool(result.get("error"))
            # Provider health is about a successful response, not whether the
            # relevance filter found an item for this fixed public query.
            self.monitor.record(source, elapsed, count, failed, issue, probe=True)
            code = result.get("provider_error_code")
            if code in STOP_CODES:
                self.suspended.add(source)
            elif not failed and not issue:
                with self.lock:
                    self.next_probe[source] = self.clock() + 45
            checked.append(source)
            break  # One probe per cycle limits background traffic.
        return checked

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, name="provider-recovery", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2)

    def _loop(self) -> None:
        if self.stop_event.wait(2):
            return
        while not self.stop_event.is_set():
            self.check_once()
            if self.stop_event.wait(12):
                return
