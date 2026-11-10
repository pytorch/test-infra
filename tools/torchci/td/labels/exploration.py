"""explored units (`x:<pr>:<head>:<workflow>:<env>:<config>:<call>`): the test files
pytorch's TD exploration drew from what TD skipped, each with its inclusion probability,
from the `td_exploration` metric (one row per run_test.py invocation, from shard 1,
written before tests run; exploration_rows checks them). Outcomes come from the records
of the unit's jobs: a drawn file failed when td_test_failure_stats_v2 reports it as a
failed explored file, passed when it is in the jobs' test reports and failed nowhere."""

from collections import Counter, defaultdict
from datetime import datetime
from typing import Any, Optional

from torchci.td.labels import queries
from torchci.td.labels.exploration_rows import REPLICATES, validate
from torchci.td.labels.schema import epoch, EXPLORED, sql_time, unit_row, unix
from torchci.td.llm.events import E2Event


# Horvitz-Thompson weights are clipped here: a forged or unlucky tiny propensity would
# otherwise dominate the estimates.
MAX_WEIGHT = 100.0
MAX_CALLS = 32


def fetch_head_jobs(jobs: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    """Every test job at the heads of the jobs td_exploration rows name."""
    shas = sorted({str(j["head_sha"]) for j in jobs.values()})
    return [
        r
        for batch in queries.batched(shas)
        for r in queries.ch("unit_jobs", queries.HEAD_JOBS, {"shas": batch})
    ]


def accepted(
    rows: list[dict[str, Any]], jobs: dict[int, dict[str, Any]], dropped: Counter
) -> list[dict[str, Any]]:
    """The rows that pass `check`, without the jobs that wrote more than MAX_CALLS calls."""
    units = []
    for row in rows:
        reason, unit = validate(row, jobs)
        if unit is None:
            dropped[f"explored_row:{reason}"] += 1
        else:
            units.append(unit)
    calls: dict[int, set[str]] = defaultdict(set)
    for u in units:
        calls[u["job_id"]].add(u["call"])
    noisy = {j for j, c in calls.items() if len(c) > MAX_CALLS}
    if noisy:
        dropped["explored_row:too_many_calls"] += sum(
            u["job_id"] in noisy for u in units
        )
    return [u for u in units if u["job_id"] not in noisy]


def select(
    rows: list[dict[str, Any]],
    jobs: dict[int, dict[str, Any]],
    head_jobs: list[dict[str, Any]],
    start: datetime,
    stop: datetime,
    dropped: Counter,
) -> list[dict[str, Any]]:
    """Per (PR, head, workflow, env, config) that started in [start, stop): each call of
    its first attempt read, one row per call. A group starts at its earliest row or its
    config's earliest job at that head, so a late re-run is not a new unit."""
    groups: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for unit in accepted(rows, jobs, dropped):
        groups[unit["group"]].append(unit)
    started: dict[tuple, int] = {}
    for r in head_jobs:
        key = (r["head_sha"], r["workflow"], r["build_environment"], r["test_config"])
        started[key] = min(int(r["created"]), started.get(key, int(r["created"])))
    w0, w1 = epoch(start), epoch(stop)
    out = []
    for group, units in sorted(groups.items()):
        attempts: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
        for u in units:
            attempts[u["attempt"]].append(u)
        first = min(attempts, key=lambda a: (min(u["ts"] for u in attempts[a]), a))
        if len(attempts) > 1:
            dropped["explored_row:later_attempt"] += len(units) - len(attempts[first])
        calls: dict[str, dict[str, Any]] = {}
        for u in sorted(attempts[first], key=lambda u: u["ts"]):
            if u["call"] in calls:
                dropped["explored_row:duplicate"] += 1
            calls.setdefault(u["call"], u)
        begun = [unix(u["ts"]) for u in units]
        begun += [
            started[k]
            for u in units
            for k in [(group[1], group[2]) + u["config"]]
            if k in started
        ]
        if not w0 <= min(begun) < w1:
            dropped["explored_unit:outside_window"] += len(calls)
            continue
        out += [calls[c] for c in sorted(calls)]
    return out


def label_file(
    drawn: list[dict[str, Any]], failed: bool, report_failed: bool, reported: bool
) -> tuple[Optional[bool], str]:
    """(True, '') failed, (False, '') passed, (None, reason) not labelled."""
    if any(d["top_part"] for d in drawn):
        return None, "top_part"
    if len({d["count"] for d in drawn}) > 1:
        return None, "propensity_mismatch"
    if failed:
        return True, ""
    if report_failed:
        return None, "report_failure"
    return (False, "") if reported else (None, "unreported")


def unit_jobs(head_jobs: list[dict[str, Any]]) -> dict[tuple, set[int]]:
    """Per (run, attempt, job-name prefix, config), its test job ids."""
    out: dict[tuple, set[int]] = defaultdict(set)
    for r in head_jobs:
        key = (int(r["run_id"]), int(r["run_attempt"]))
        out[key + (r["build_environment"], r["test_config"])].add(int(r["job_id"]))
    return out


def explored_units(
    units: list[dict[str, Any]],
    head_jobs: list[dict[str, Any]],
    e2: list[E2Event],
    start: datetime,
    stop: datetime,
    dropped: Counter,
) -> list[dict[str, Any]]:
    """Labels the selected units from their jobs' records."""
    jobs_of = unit_jobs(head_jobs)
    jobs = {
        j: (u["attempt"][0], unix(u["ts"]))
        for u in units
        for j in jobs_of.get(u["attempt"] + u["config"], ())
    }
    reports = queries.ran_files(jobs) if jobs else {}
    failed: dict[int, set[str]] = defaultdict(set)
    window = {"start": sql_time(start), "stop": sql_time(stop + queries.LATE_ROWS)}
    for batch in queries.batched(sorted(jobs), queries.LARGE_BATCH):
        params = {**window, "job_ids": batch}
        for r in queries.ch("explored_failures", queries.EXPLORED_FAILURES, params):
            failed[int(r["job_id"])].add(r["test_file"])
    specific = {(e.pr_number, e.test_file) for e in e2}
    out = []
    for u in units:
        ids = jobs_of.get(u["attempt"] + u["config"], set())
        by_file: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for d in u["drawn"]:
            by_file[d["test_file"]].append(d)
        propensity, positives, negatives = {}, set(), set()
        for f, drawn in sorted(by_file.items()):
            label, reason = label_file(
                drawn,
                any(f in failed[j] for j in ids),
                any(f in reports[j][1] for j in ids if j in reports),
                any(f in reports[j][0] for j in ids if j in reports),
            )
            if label and (u["group"][0], f) not in specific:
                label, reason = None, "failed_not_pr_specific"
            if reason:
                dropped[f"explored_file:{reason}"] += 1
            if reason not in ("top_part", "propensity_mismatch"):
                propensity[f] = drawn[0]["count"] / REPLICATES
            if label is not None:
                (positives if label else negatives).add(f)
        pr, sha, workflow, env, cfg = u["group"]
        out.append(
            unit_row(
                unit_id="x:" + ":".join(map(str, u["group"] + (u["call"],))),
                kind=EXPLORED,
                time=unix(u["ts"]),
                sha=sha,
                pr_number=pr,
                candidates=sorted(propensity),
                positives=sorted(positives),
                observed=sorted(positives | negatives),
                single=True,
                workflow=workflow,
                build_environment=env,
                test_config=cfg,
                propensity=propensity,
                train_ok=True,
            )
        )
    return out


def fetch_rows(
    start: datetime, stop: datetime
) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
    """td_exploration rows from LATE_ROWS before to LATE_ROWS after the window, and the
    jobs they name."""
    params = {
        "start": sql_time(start - queries.LATE_ROWS),
        "stop": sql_time(stop + queries.LATE_ROWS),
    }
    rows = queries.ch("exploration_rows", queries.EXPLORATION_ROWS, params)
    jobs: dict[int, dict[str, Any]] = {}
    ids = sorted({int(r["job_id"]) for r in rows})
    for batch in queries.batched(ids, queries.LARGE_BATCH):
        for r in queries.ch(
            "exploration_jobs", queries.EXPLORATION_JOBS, {"job_ids": batch}
        ):
            jobs[int(r["job_id"])] = r
    return rows, jobs


def weight(p: float) -> float:
    return min(1 / p, MAX_WEIGHT)


def estimates(units: list[dict[str, Any]], frames: Counter) -> dict[str, Any]:
    """Horvitz-Thompson estimates over explored units, per file, with 1 / propensity
    clipped at MAX_WEIGHT: how many files the frame skipped, how many of them got a label
    and how many failed PR-specifically. They cover the frame only."""
    ex = [u for u in units if u["kind"] == EXPLORED]
    drawn = sum(len(u["propensity"]) for u in ex)
    labelled = sum(len(u["observed"]) for u in ex)
    skipped_seconds = frames["skipped_seconds"]
    return {
        "explored_units": len(ex),
        "drawn_files": drawn,
        "labelled_files": labelled,
        "positive_files": sum(len(u["positives"]) for u in ex),
        "unlabelled_share": round(1 - labelled / drawn, 4) if drawn else None,
        "clipped_files": sum(
            1 / p > MAX_WEIGHT for u in ex for p in u["propensity"].values()
        ),
        "frame_files": frames["frame"],
        "out_of_frame_files": frames["out_of_frame"],
        "out_of_frame_time_share": (
            round(frames["out_of_frame_seconds"] / skipped_seconds, 4)
            if skipped_seconds
            else None
        ),
        "estimated_skipped_files": round(
            sum(weight(p) for u in ex for p in u["propensity"].values()), 3
        ),
        "estimated_labelled_files": round(
            sum(weight(u["propensity"][f]) for u in ex for f in u["observed"]), 3
        ),
        "estimated_failing_skipped_files": round(
            sum(weight(u["propensity"][f]) for u in ex for f in u["positives"]), 3
        ),
    }
