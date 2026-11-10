"""The failure history behind a unit's rows, from HUD ClickHouse (read-only): the rows
the failure ratings are rebuilt from and the merge bases they need, the PR's earlier
failures PreviouslyFailedInPR reads, when each run at a PR head started, and the main
failures that tell whether a main positive was fresh."""

from bisect import bisect_left
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from torchci.td.labels import main_units, queries as label_queries
from torchci.td.labels.schema import DAY, sql_time
from torchci.td.scorer import queries


# The rating generator reads this many days of failures.
HISTORY_DAYS = 90
CHUNK = timedelta(days=7)
# A main positive is fresh when its file failed on main in none of the pushes this long
# before the unit's push.
FRESH_DAYS = 14
# A source covers a unit this long after its first row: 30 days of the 7-day half-life
# hold ~95% of the failure ratings' decayed weight. An uncovered feature is NaN, not 0.
COVERAGE_DAYS = 30
# The PR's earlier failures are read this long before the window, so they cover its
# units, whose cutoffs (run starts) can precede it by days.
PREV_FAILED_DAYS = COVERAGE_DAYS + 7
# The build environments whose failing test jobs upload the pytest cache that
# PreviouslyFailedInPR reads: pytorch's _win-test.yml and _tpu-test.yml. _linux-test.yml
# uploads only after its benchmark-results AWS credentials step succeeds, which PR runs
# do not get (their caches in s3://gha-artifacts/pytest_cache hold no Linux upload);
# macOS, ROCm and XPU jobs upload none.
CACHED_ENVS = ["win-", "tpu"]
BATCH = 2000

# (unix seconds, workflow, file) per PR.
PrFailures = dict[int, list[tuple[int, str, str]]]


def covered(first: Optional[int], t: int) -> bool:
    """Whether a source whose first row is at `first` covers time t."""
    return first is not None and t >= first + COVERAGE_DAYS * DAY


def chunks(start: datetime, stop: datetime) -> list[tuple[datetime, datetime]]:
    out = []
    while start < stop:
        out.append((start, min(start + CHUNK, stop)))
        start = out[-1][1]
    return out


def fetch_history(start: datetime, stop: datetime) -> list[dict[str, Any]]:
    """The generator's failure rows from HISTORY_DAYS before `start` to `stop`: the
    earliest failure (unix seconds) per (head sha, file)."""
    first: dict[tuple[str, str], int] = {}
    for lo, hi in chunks(start - timedelta(days=HISTORY_DAYS), stop):
        params = {"start": sql_time(lo), "stop": sql_time(hi)}
        for r in label_queries.ch("fail_history", queries.FAIL_HISTORY, params):
            key, ts = (r["head_sha"], r["failure"]), int(r["ts"])
            first[key] = min(ts, first.get(key, ts))
    return [
        {"head_sha": s, "failure": f, "ts": ts} for (s, f), ts in sorted(first.items())
    ]


def fetch_merge_bases(shas: Iterable[str]) -> dict[str, dict[str, Any]]:
    out = {}
    for batch in label_queries.batched(sorted(set(shas)), BATCH):
        for r in label_queries.ch("merge_bases", queries.MERGE_BASES, {"shas": batch}):
            out[r["sha"]] = {
                "merge_base": r["merge_base"],
                "changed_files": list(r["changed_files"]),
            }
    return out


def run_starts(shas: list[str]) -> dict[tuple[str, str], list[int]]:
    """Per (head sha, workflow), when each of its runs started (unix seconds, sorted)."""
    out: dict[tuple[str, str], list[int]] = defaultdict(list)
    for batch in label_queries.batched(sorted(set(shas))):
        for r in label_queries.ch("head_runs", queries.HEAD_RUNS, {"shas": batch}):
            out[(r["head_sha"], r["workflow"])].append(int(r["started"]))
    return {k: sorted(v) for k, v in out.items()}


def pr_cutoff(u: dict[str, Any], starts: dict[tuple[str, str], list[int]]) -> int:
    """When TD ranked the PR unit's tests: the start of the last run of its workflow at
    its head that started by the unit's time (the unit's time when none is known)."""
    t = int(u["time"])
    before = [s for s in starts.get((u["sha"], u["workflow"]), []) if s <= t]
    return before[-1] if before else t


def pr_failures(start: datetime, stop: datetime) -> PrFailures:
    """Per PR, every first failure per (workflow, head, file) of a job that uploads the
    pytest cache, from PREV_FAILED_DAYS before `start` to `stop`."""
    first: dict[tuple[int, str, str, str], int] = {}
    for lo, hi in chunks(start - timedelta(days=PREV_FAILED_DAYS), stop):
        params = {
            "start": sql_time(lo),
            "stop": sql_time(hi),
            "cached": CACHED_ENVS,
        }
        for r in label_queries.ch("pr_failures", queries.PR_FAILURES, params):
            key = (int(r["pr"]), r["workflow"], r["head_sha"], r["test_file"])
            first[key] = min(int(r["ts"]), first.get(key, int(r["ts"])))
    out: dict[int, list[tuple[int, str, str]]] = defaultdict(list)
    for (pr, workflow, _, f), ts in sorted(first.items()):
        out[pr].append((ts, workflow, f))
    return dict(out)


def prev_failed(
    failures: list[tuple[int, str, str]], workflow: Optional[str], cutoff: int
) -> list[str]:
    """PreviouslyFailedInPR: the files that failed in the PR's runs of `workflow` (any
    workflow when None) before cutoff."""
    return sorted(
        {f for ts, wf, f in failures if ts < cutoff and workflow in (None, wf)}
    )


def naive(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, timezone.utc).replace(tzinfo=None)


def merged(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for lo, hi in sorted(intervals):
        if out and lo <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], hi))
        else:
            out.append((lo, hi))
    return out


def main_failure_times(times: list[int]) -> dict[str, list[int]]:
    """Per test file, the push times (sorted) at which it failed in a failed main test
    job (the labels' MAIN_JOBS and FAILED_FILES), over FRESH_DAYS before each time."""
    out: dict[str, set[int]] = defaultdict(set)
    for lo, hi in merged([(t - FRESH_DAYS * DAY, t) for t in times]):
        pushes = main_units.fetch_pushes(naive(lo), naive(hi))
        pushed_at = {p["push_sha"]: int(p["pushed_at"]) for p in pushes}
        _, fail = main_units.fetch_failures([p["push_sha"] for p in pushes])
        for r in fail:
            out[r["file"]].add(pushed_at[r["push_sha"]])
    return {f: sorted(ts) for f, ts in out.items()}


def fresh(positives: Iterable[str], t: int, fails: dict[str, list[int]]) -> list[str]:
    """The positives that failed at no main push in the FRESH_DAYS before t."""
    out = []
    for f in positives:
        ts = fails.get(f, [])
        i = bisect_left(ts, t - FRESH_DAYS * DAY)
        if i == len(ts) or ts[i] >= t:
            out.append(f)
    return sorted(out)
