"""TD's label dataset: (unit, test file) -> failed, from HUD ClickHouse (read-only) and
a pytorch clone (read-only git), for main pushes. See README.md."""

import gzip
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from torchci.td.labels import main_units
from torchci.td.labels.schema import KINDS
from torchci.td.llm.bundle import atomic_file
from torchci.td.llm.cache import ensure_dir


logger = logging.getLogger(__name__)

UNITS_FILE = "units.jsonl.gz"
CANDIDATES_FILE = "candidates.jsonl.gz"
MANIFEST_FILE = "manifest.json"


def write_jsonl_gz(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    with atomic_file(path, "wb") as f, gzip.GzipFile(
        fileobj=f, mode="wb", mtime=0
    ) as z:
        for row in rows:
            z.write((json.dumps(row, sort_keys=True) + "\n").encode())


def build(
    start: datetime,
    stop: datetime,
    repo: Path,
    out: Path,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """Writes the units, the monthly test lists and the manifest to `out`; returns the
    manifest."""
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    ensure_dir(out)
    units, lists = main_units.build(start, stop, repo, out / "cache")
    manifest = {
        "start": start.strftime("%Y-%m-%d"),
        "stop": stop.strftime("%Y-%m-%d"),
        "built_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "units": {k: sum(u["kind"] == k for u in units) for k in KINDS},
        "positives": {
            k: sum(len(u["positives"]) for u in units if u["kind"] == k) for k in KINDS
        },
        "months": [c["month"] for c in lists],
    }
    write_jsonl_gz(out / UNITS_FILE, units)
    write_jsonl_gz(out / CANDIDATES_FILE, lists)
    with atomic_file(out / MANIFEST_FILE, "w") as f:
        f.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    logger.info("units by kind: %s", manifest["units"])
    return manifest
