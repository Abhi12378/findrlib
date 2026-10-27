"""Nightly API catalog refresh while the local app is running."""
from __future__ import annotations

import json
import threading
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from update_catalog import refresh_catalog


class CatalogManager:
    def __init__(self, root: Path):
        self.catalog_path = root / "data" / "catalog.json"
        self.status_path = root / "data" / "catalog_status.json"
        self.catalog = json.loads(self.catalog_path.read_text(encoding="utf-8-sig"))
        try:
            self.info = json.loads(self.status_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            self.info = {}
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.running = False

    def snapshot(self) -> list[dict]:
        with self.lock:
            return self.catalog

    def status(self) -> dict:
        with self.lock:
            info = dict(self.info)
            running = self.running
            count = len(self.catalog)
        now = datetime.now().astimezone()
        last_success = info.get("last_success")
        if last_success and last_success[:10] == now.date().isoformat():
            next_run = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), now.tzinfo)
        else:
            next_run = now
        return {"catalog_count": count, "last_success": last_success,
                "last_attempt": info.get("last_attempt"), "new_entries": info.get("new_entries", 0),
                "last_error": info.get("last_error"), "running": running,
                "next_refresh": next_run.isoformat(), "timezone": str(now.tzinfo)}

    def due(self) -> bool:
        now = datetime.now().astimezone()
        with self.lock:
            if self.running or str(self.info.get("last_success", ""))[:10] == now.date().isoformat():
                return False
            last_attempt = self.info.get("last_attempt")
        if not last_attempt:
            return True
        try:
            elapsed = (now - datetime.fromisoformat(last_attempt)).total_seconds()
            return elapsed >= 3600
        except ValueError:
            return True

    def request_refresh(self) -> bool:
        with self.lock:
            if self.running:
                return False
            self.running = True
            self.info["last_attempt"] = datetime.now().astimezone().isoformat()
        threading.Thread(target=self._refresh, daemon=True, name="catalog-refresh").start()
        return True

    def _refresh(self) -> None:
        try:
            records, added = refresh_catalog()
            with self.lock:
                self.catalog = records
                self.info.update({"last_success": datetime.now().astimezone().isoformat(),
                                  "new_entries": added, "last_error": None})
        except Exception as error:
            with self.lock:
                self.info["last_error"] = str(error)[:180]
        finally:
            with self.lock:
                self.running = False
                status = dict(self.info)
            try:
                with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.status_path.parent,
                                                 prefix="catalog-status-", suffix=".tmp", delete=False) as file:
                    json.dump(status, file, ensure_ascii=False, indent=2)
                    temporary = Path(file.name)
                temporary.replace(self.status_path)
            except OSError:
                pass

    def start(self) -> None:
        threading.Thread(target=self._loop, daemon=True, name="nightly-catalog-check").start()

    def _loop(self) -> None:
        while not self.stop_event.is_set():
            if self.due():
                self.request_refresh()
            now = datetime.now().astimezone()
            midnight = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), now.tzinfo)
            self.stop_event.wait(max(1, min(3600, (midnight - now).total_seconds())))

    def stop(self) -> None:
        self.stop_event.set()
