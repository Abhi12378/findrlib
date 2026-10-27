"""Refresh Public APIs independently of the Resource Finder web server."""
from __future__ import annotations

import json
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from update_catalog import refresh_catalog

ROOT = Path(__file__).resolve().parent
STATUS = ROOT / "data" / "catalog_status.json"


def write_status(data: dict) -> None:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=STATUS.parent,
                                     prefix="catalog-status-", suffix=".tmp", delete=False) as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
        temporary = Path(file.name)
    temporary.replace(STATUS)


def main() -> int:
    try:
        status = json.loads(STATUS.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        status = {}
    status["last_attempt"] = datetime.now().astimezone().isoformat()
    try:
        records, added = refresh_catalog()
        status.update({"last_success": datetime.now().astimezone().isoformat(),
                       "new_entries": added, "last_error": None})
        print(f"Refreshed {len(records)} APIs; {added} new.")
        code = 0
    except Exception as error:
        status["last_error"] = str(error)[:180]
        print(f"Catalog refresh failed: {error}", file=sys.stderr)
        code = 1
    write_status(status)
    return code


if __name__ == "__main__":
    raise SystemExit(main())

