"""TD's label dataset: (unit, test file) -> failed, from HUD ClickHouse (read-only) and
a pytorch clone (read-only git), for main pushes, TD-off PR jobs and TD's exploration
draws. See README.md."""

import gzip
import json
import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from torchci.td.labels import exploration, main_units, pr_units, queries
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
    manifest. PR kinds are skipped for a window that starts before E2's look-back, whose
    PR-specific rule would see only part of it."""
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    ensure_dir(out)
    dropped: Counter = Counter()
    pr_kinds = start >= now - timedelta(days=queries.PR_LOOK_BACK_DAYS)
    e2: list = []
    td_off: dict = {}
    selected: list = []
    if pr_kinds:
        e2 = queries.fetch_e2(start, stop)
        td_off = pr_units.fetch_td_off(e2, start, stop, dropped)
    else:
        logger.warning(
            "window starts more than %d days ago: pr_td_off and explored skipped",
            queries.PR_LOOK_BACK_DAYS,
        )
    rankings = [(e.failed_at, e.row.all_scores) for e in e2]
    rankings += [
        (g["failed_at"], g["row"].all_scores) for v in td_off.values() for g in v
    ]
    main, lists = main_units.build(
        start, stop, repo, out / "cache", main_units.cpp_tests(rankings)
    )
    units = main + pr_units.td_off_units(td_off)
    if pr_kinds:
        rows, jobs = exploration.fetch_rows(start, stop)
        head_jobs = exploration.fetch_head_jobs(jobs) if rows else []
        selected = exploration.select(rows, jobs, head_jobs, start, stop, dropped)
        units += exploration.explored_units(
            selected, head_jobs, e2, start, stop, dropped
        )
    manifest = {
        "start": start.strftime("%Y-%m-%d"),
        "stop": stop.strftime("%Y-%m-%d"),
        "built_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "pr_kinds_skipped": not pr_kinds,
        "units": {k: sum(u["kind"] == k for u in units) for k in KINDS},
        "positives": {
            k: sum(len(u["positives"]) for u in units if u["kind"] == k) for k in KINDS
        },
        "months": [c["month"] for c in lists],
        "dropped": dict(sorted(dropped.items())),
        "estimates": exploration.estimates(
            units, sum((u["frame"] for u in selected), Counter())
        ),
    }
    write_jsonl_gz(out / UNITS_FILE, units)
    write_jsonl_gz(out / CANDIDATES_FILE, lists)
    with atomic_file(out / MANIFEST_FILE, "w") as f:
        f.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    logger.info("units by kind: %s", manifest["units"])
    return manifest
