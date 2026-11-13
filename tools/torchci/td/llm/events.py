"""Event snapshot from HUD ClickHouse (written once: the TD metric keeps 90 days)."""

import json
import logging
import os
import re
import traceback
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from torchci.td.llm.bundle import atomic_file
from torchci.td.llm.cache import ensure_dir
from torchci.td.llm.diff import SHA_RE
from torchci.td.llm.events_sql import E1_RANKINGS_SQL, E2_SQL, RETENTION_DAYS


logger = logging.getLogger(__name__)

SAVED_QUERY = "td_trunk_breakages"
MAIN_WINDOW_SECONDS = 48 * 60 * 60
E1_RANKING_LAG_DAYS = 7
BASE_SOURCES = ("pr_base_sha", "head_pr_base_sha", "merge_base")
E1_FILE, E2_FILE = "e1_events.jsonl", "e2_events.jsonl"
TEST_TIMES_FILE, META_FILE = "test_times.json", "meta.json"
# Appended after the saved query's own SETTINGS: a later setting wins, so these replace
# the HUD page's time limit.
OFFLINE_SETTINGS = "readonly = 2, max_execution_time = 600"


@dataclass(frozen=True)
class RankRow:
    run_id: int
    job_id: int
    workflow: str
    build_environment: str
    test_config: str
    test_file: str
    position: int
    max_score: float
    all_scores: dict[str, float] = field(compare=False)
    # When the metric row was emitted ("YYYY-MM-DD HH:MM:SS"); "" when unknown.
    logged_at: str = ""


@dataclass(frozen=True)
class E1Event:
    landing_sha: str
    landed_at: str
    stack_size: int
    outcome: str
    test_files: list[str]
    test_configs: list[str]
    rows: list[RankRow] = field(default_factory=list, compare=False)


@dataclass(frozen=True)
class E2Event:
    pr_number: int
    test_file: str
    failed_at: str
    head_sha: str
    base_sha: str
    base_source: str
    pr_source: str
    n: int
    row: RankRow = field(compare=False)


def test_file_of(key: str) -> str:
    """TD test file of an `all_scores` key: `test_nn`, `test_nn, TestFoo`, `test_nn::TestFoo`."""
    return key.split("::", 1)[0].split(", ", 1)[0]


def with_offline_settings(sql: str) -> str:
    """Appends OFFLINE_SETTINGS to the saved query's one SETTINGS line, its last line."""
    lines = sql.rstrip().split("\n")
    idx = [i for i, ln in enumerate(lines) if ln.lstrip().startswith("SETTINGS ")]
    if len(idx) != 1 or idx[0] != len(lines) - 1:
        raise ValueError(f"expected one SETTINGS line, last: found {len(idx)}")
    lines[-1] = lines[-1].rstrip() + ", " + OFFLINE_SETTINGS
    return "\n".join(lines) + "\n"


def chunks(
    start: datetime, stop: datetime, days: int = RETENTION_DAYS
) -> list[tuple[datetime, datetime]]:
    out = []
    while start < stop:
        end = min(start + timedelta(days=days), stop)
        out.append((start, end))
        start = end
    return out


def _ts(value: str) -> str:
    return str(value).replace("T", " ")[:19]


def parse_rank_row(row: dict[str, Any]) -> RankRow:
    scores = row["all_scores"]
    if isinstance(scores, str):
        scores = json.loads(scores) if scores else {}
    return RankRow(
        run_id=int(row["run_id"]),
        job_id=int(row["job_id"]),
        workflow=row["workflow"],
        build_environment=row["build_environment"],
        test_config=row["test_config"],
        test_file=row["test_file"],
        position=int(row["position"]),
        max_score=float(row["max_score"]),
        all_scores={str(k): float(v) for k, v in scores.items()},
        logged_at=_ts(
            row.get("timestamp") or row.get("logged_at") or row.get("failed_at") or ""
        ),
    )


def parse_e1(rows: Iterable[dict[str, Any]]) -> list[E1Event]:
    events: dict[str, E1Event] = {}
    for row in rows:
        sha = row["landing_sha"]
        if row.get("grain") != "event" or sha in events or not SHA_RE.match(sha):
            continue
        events[row["landing_sha"]] = E1Event(
            landing_sha=row["landing_sha"],
            landed_at=_ts(row["landed_at"]),
            stack_size=int(row["stack_size"]),
            outcome=row["outcome"],
            test_files=sorted(set(row["test_files"])),
            test_configs=sorted(set(row["test_configs"])),
        )
    return sorted(events.values(), key=lambda e: (e.landed_at, e.landing_sha))


def parse_e1_rankings(rows: Iterable[dict[str, Any]]) -> dict[str, list[RankRow]]:
    """Ranking rows by landing sha, one per (job, test file): the first emitted."""
    seen: set[tuple[str, int, str]] = set()
    out: dict[str, list[RankRow]] = {}
    for row in rows:
        key = (row["landing_sha"], int(row["job_id"]), row["test_file"])
        if key in seen:
            continue
        seen.add(key)
        out.setdefault(row["landing_sha"], []).append(parse_rank_row(row))
    return out


def is_pr_specific(row: dict[str, Any]) -> bool:
    """No failure of the file on main within the window; other non-PR runs do not count."""
    return "main" not in row.get("nonpr_branches", [])


def base_of(row: dict[str, Any]) -> tuple[str, str]:
    """The run's own PR base; for a ciflow tag run, the base of a pull_request run at
    the same head (a ghstack PR's own base); else `default.merge_bases` (main)."""
    for source in BASE_SOURCES:
        sha = row.get(source) or ""
        if SHA_RE.match(sha):
            return sha, source
    return "", ""


def parse_e2(rows: Iterable[dict[str, Any]]) -> list[E2Event]:
    events: dict[tuple[int, str], E2Event] = {}
    for row in sorted(rows, key=lambda r: _ts(r["failed_at"])):
        key = (int(row["pr_number"]), row["test_file"])
        valid = SHA_RE.match(row["head_sha"] or "")
        if key in events or not valid or not is_pr_specific(row):
            continue
        base_sha, base_source = base_of(row)
        events[key] = E2Event(
            pr_number=key[0],
            test_file=key[1],
            failed_at=_ts(row["failed_at"]),
            head_sha=row["head_sha"],
            base_sha=base_sha,
            base_source=base_source,
            pr_source=row["pr_source"],
            n=int(row["n"]),
            row=parse_rank_row(row),
        )
    return list(events.values())


def _query(name: str, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    from torchci.clickhouse import query_clickhouse

    try:
        return query_clickhouse(sql, params)  # type: ignore[no-any-return]
    except Exception as e:
        trace = "".join(traceback.format_exception(e))
        host = re.sub(
            r"^https?://|:\d+$", "", os.environ.get("CLICKHOUSE_ENDPOINT", "")
        )
        for secret, label in (
            (host, "<host>"),
            (os.environ.get("CLICKHOUSE_USERNAME"), "<user>"),
        ):
            trace = trace.replace(secret, label) if secret else trace
        logger.error("%s query failed:\n%s", name, trace)
        code = re.search(r"(?:Code:|error code) (\d+)", str(e))
        short = type(e).__name__ + (f" (code {code.group(1)})" if code else "")
        raise RuntimeError(f"{name} query failed: {short}") from None


def _ch_time(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S.000")


def saved_breakages_query() -> tuple[str, dict[str, Any]]:
    from torchci.utils import REPO_ROOT

    path = REPO_ROOT / "torchci" / "clickhouse_queries" / SAVED_QUERY
    params = json.loads((path / "params.json").read_text())
    return with_offline_settings((path / "query.sql").read_text()), params


def fetch_e1(
    start: datetime,
    stop: datetime,
    query: Callable[[str, str, dict[str, Any]], list[dict[str, Any]]] = _query,
) -> list[dict[str, Any]]:
    sql, params = saved_breakages_query()
    rows: list[dict[str, Any]] = []
    for lo, hi in chunks(start, stop):
        values = dict(params.get("defaults", {}), startTime=_ch_time(lo))
        values["stopTime"] = _ch_time(hi)
        if set(values) != set(params["params"]):
            raise ValueError(
                f"{SAVED_QUERY} params changed: {sorted(params['params'])}"
            )
        rows += query(SAVED_QUERY, sql, values)
    return rows


def fetch_e1_rankings(events: list[E1Event], now: datetime) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for lo, hi in chunks(min(datetime.fromisoformat(e.landed_at) for e in events), now):
        batch = [e for e in events if lo <= datetime.fromisoformat(e.landed_at) < hi]
        pairs = [(e.landing_sha, f) for e in batch for f in e.test_files]
        if not pairs:
            continue
        params = {
            "shas": [p[0] for p in pairs],
            "files": [p[1] for p in pairs],
            "start": _ch_time(lo),
            "stop": _ch_time(min(hi + timedelta(days=E1_RANKING_LAG_DAYS), now)),
        }
        rows += _query("e1_rankings", E1_RANKINGS_SQL, params)
    return rows


def write_text(path: Path, text: str) -> None:
    with atomic_file(path, "w") as f:
        f.write(text)


def _jsonl(items: Iterable[Any]) -> str:
    return "".join(json.dumps(asdict(i), sort_keys=True) + "\n" for i in items)


def fetch(start: datetime, stop: datetime, out_dir: Path) -> dict[str, Any]:
    from torchci.td.utils import download_test_times

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    ensure_dir(out_dir)
    e1 = parse_e1(fetch_e1(start, stop))
    rankings = parse_e1_rankings(fetch_e1_rankings(e1, now)) if e1 else {}
    e1 = [replace(e, rows=rankings.get(e.landing_sha, [])) for e in e1]
    window = {"start": _ch_time(start), "stop": _ch_time(stop)}
    e2_rows = _query("e2", E2_SQL, {**window, "main_window": MAIN_WINDOW_SECONDS})
    e2 = parse_e2(e2_rows)
    write_text(out_dir / E1_FILE, _jsonl(e1))
    write_text(out_dir / E2_FILE, _jsonl(e2))
    write_text(out_dir / TEST_TIMES_FILE, json.dumps(download_test_times()))
    meta = {
        "start": start.strftime("%Y-%m-%d"),
        "stop": stop.strftime("%Y-%m-%d"),
        "fetched_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "e1_events": len(e1),
        "e1_events_with_rankings": sum(1 for e in e1 if e.rows),
        "e1_ranking_rows": sum(len(e.rows) for e in e1),
        "e2_candidates": len(e2_rows),
        "e2_dropped_main": sum(1 for r in e2_rows if not is_pr_specific(r)),
        "e2_events": len(e2),
        "e2_prs": len({e.pr_number for e in e2}),
    }
    write_text(out_dir / META_FILE, json.dumps(meta, indent=2, sort_keys=True))
    return meta


@dataclass(frozen=True)
class Snapshot:
    e1: list[E1Event]
    e2: list[E2Event]
    test_times: dict[str, Any]
    meta: dict[str, Any]


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def load(out_dir: Path) -> Snapshot:
    e1 = [
        E1Event(**{**d, "rows": [parse_rank_row(r) for r in d["rows"]]})
        for d in _read_jsonl(out_dir / E1_FILE)
    ]
    e2 = [
        E2Event(**{**d, "row": parse_rank_row(d["row"])})
        for d in _read_jsonl(out_dir / E2_FILE)
    ]
    return Snapshot(
        e1=e1,
        e2=e2,
        test_times=json.loads((out_dir / TEST_TIMES_FILE).read_text()),
        meta=json.loads((out_dir / META_FILE).read_text()),
    )
