from datetime import date, datetime as dt, timedelta, timezone
from typing import Dict, Iterator, List, Optional, Set, Tuple

COLUMNS = ["commit_sha", "commit_url", "commit_time", "regressions", "flaky_signals"]

TIME_FMT = "%Y-%m-%d %H:%M:%S"


def endpoint_from_env(raw: str) -> str:
    endpoint = raw
    if endpoint.startswith("https://"):
        endpoint = endpoint[len("https://") :]
    if endpoint.endswith(":8443"):
        endpoint = endpoint[: -len(":8443")]
    return endpoint


def is_test_signal(key: str) -> bool:
    return bool(key) and "::" in key


def annotate_regression(
    key: str, verdict: Optional[str], confidence: Optional[float]
) -> str:
    if not verdict:
        return key
    if confidence is None:
        return f"{key} ({verdict})"
    return f"{key} ({verdict}, {confidence:.2f})"


def day_bounds(day: date) -> Tuple[dt, dt]:
    start = dt(day.year, day.month, day.day)
    nxt = day + timedelta(days=1)
    return start, dt(nxt.year, nxt.month, nxt.day)


def iter_time_chunks(
    start_date: date, end_date: date, chunk_hours: int
) -> Iterator[Tuple[dt, dt]]:
    range_start, _ = day_bounds(start_date)
    _, range_end = day_bounds(end_date)
    step = timedelta(hours=chunk_hours)
    chunk_start = range_start
    while chunk_start < range_end:
        chunk_end = min(chunk_start + step, range_end)
        yield chunk_start, chunk_end
        chunk_start = chunk_end


def _naive_utc(value: dt) -> dt:
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def build_rows(
    regressions: Dict[str, Set[str]],
    flaky: Dict[str, Set[str]],
    commit_times: Dict[str, dt],
    verdicts: Dict[Tuple[str, str], Tuple[Optional[str], Optional[float]]],
    start_date: date,
    end_date: date,
    repo: str,
) -> List[Dict[str, str]]:
    window_start, _ = day_bounds(start_date)
    _, window_end = day_bounds(end_date)

    rows: List[Dict[str, str]] = []
    for sha in set(regressions) | set(flaky):
        landed = commit_times.get(sha)
        if landed is None:
            continue
        landed = _naive_utc(landed)
        if not (window_start <= landed < window_end):
            continue

        reg_keys = sorted(regressions.get(sha, set()))
        flaky_keys = sorted(flaky.get(sha, set()))
        if not reg_keys and not flaky_keys:
            continue

        reg_cell = "; ".join(
            annotate_regression(k, *verdicts.get((sha, k), (None, None)))
            for k in reg_keys
        )
        rows.append(
            {
                "commit_sha": sha,
                "commit_url": f"https://github.com/{repo}/commit/{sha}",
                "commit_time": landed.strftime(TIME_FMT),
                "regressions": reg_cell,
                "flaky_signals": "; ".join(flaky_keys),
            }
        )

    rows.sort(key=lambda r: (r["commit_time"], r["commit_sha"]))
    return rows
