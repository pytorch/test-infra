from datetime import date, datetime as dt, timedelta, timezone
from typing import Dict, Iterator, List, Optional, Set, Tuple

COLUMNS = [
    "commit_sha",
    "commit_url",
    "commit_time",
    "category",
    "workflow",
    "signal_key",
    "advisor_verdict",
    "advisor_confidence",
]

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
    single_workflow_by_signal: Dict[Tuple[str, str], Optional[str]],
    flaky: Dict[str, Set[Tuple[str, str]]],
    commit_times: Dict[str, dt],
    verdicts: Dict[Tuple[str, str], Tuple[Optional[str], Optional[float], Optional[str]]],
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
        commit_time = landed.strftime(TIME_FMT)
        commit_url = f"https://github.com/{repo}/commit/{sha}"

        for signal_key in regressions.get(sha, set()):
            verdict, confidence, adv_workflow = verdicts.get(
                (sha, signal_key), (None, None, None)
            )
            workflow = (
                adv_workflow
                or single_workflow_by_signal.get((sha, signal_key))
                or "unknown"
            )
            rows.append(
                {
                    "commit_sha": sha,
                    "commit_url": commit_url,
                    "commit_time": commit_time,
                    "category": "regression",
                    "workflow": workflow,
                    "signal_key": signal_key,
                    "advisor_verdict": verdict or "",
                    "advisor_confidence": (
                        f"{confidence:.2f}"
                        if verdict and confidence is not None
                        else ""
                    ),
                }
            )

        for workflow, signal_key in flaky.get(sha, set()):
            rows.append(
                {
                    "commit_sha": sha,
                    "commit_url": commit_url,
                    "commit_time": commit_time,
                    "category": "flaky",
                    "workflow": workflow,
                    "signal_key": signal_key,
                    "advisor_verdict": "",
                    "advisor_confidence": "",
                }
            )

    rows.sort(
        key=lambda r: (
            r["commit_time"],
            r["category"],
            r["workflow"],
            r["signal_key"],
            r["commit_sha"],
        )
    )
    return rows
