"""Build a Chrome Trace Event JSON trace (Perfetto, Speedscope) of CI test jobs.

Each job is a process. Its "job" track holds the job and its steps; its
"lane N" tracks hold test processes, one per report_uuid, nested
file > suite > case. A report whose tests overlap (C++ binaries and xdist runs)
is split into one slice per test. Lanes are packed greedily, so a job gets as
many as the most units it ran at once.
"""

from __future__ import annotations

import itertools
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple


OUTCOMES = (
    "passed",
    "failed",
    "error",
    "skipped",
    "xfailed",
    "xpassed",
    "crashed",
    "timed_out",
    "unknown",
)

Row = Dict[str, Any]
Event = Dict[str, Any]
# (start_us, end_us, events parent-first)
Unit = Tuple[int, int, List[Event]]


@dataclass
class JobStats:
    runs: int
    reports: int
    lanes: int
    test_minutes: float  # time some test process was running
    test_step_minutes: Optional[float]


def slice_event(
    start_us: int,
    end_us: int,
    name: str,
    cat: Optional[str] = None,
    args: Optional[Dict[str, Any]] = None,
) -> Event:
    event: Event = {"ph": "X", "ts": start_us, "dur": end_us - start_us, "name": name}
    if cat:
        event["cat"] = cat
    if args:
        event["args"] = args
    return event


class Clock:
    """ci.runs times are whole milliseconds, and Perfetto slices are
    [ts, ts + dur), so a zero-length test at its report's end would fall outside
    it. Spread events tied within a millisecond 1 µs apart, in report order."""

    def __init__(self) -> None:
        self.last = -1

    def __call__(self, ms: int) -> int:
        self.last = max(ms * 1000, self.last + 1)
        return self.last


def case_event(run: Row, start_us: int, end_us: int, args: Dict[str, Any]) -> Event:
    args = {**args, "outcome": run["outcome"], "rerun_number": run["rerun_number"]}
    if run["summary"]:
        args["summary"] = run["summary"]
    return slice_event(start_us, end_us, run["case_name"], run["outcome"], args)


def report_units(report: str, runs: List[Row]) -> List[Unit]:
    """Lane units for one test process: the whole report when its tests ran one
    at a time, else one unit per test."""
    # Tests tied to the millisecond get a fixed order, not ClickHouse's row order.
    runs.sort(
        key=lambda r: (
            r["start_ms"],
            r["end_ms"],
            r["suite"],
            r["case_name"],
            r["rerun_number"],
        )
    )
    sequential = all(a["end_ms"] <= b["start_ms"] for a, b in zip(runs, runs[1:]))
    if not sequential:
        units = []
        for r in runs:
            start = r["start_ms"] * 1000
            end = max(r["end_ms"] * 1000, start + 1)
            args = {
                "file": r["file"],
                "suite": r["suite"],
                "owners": r["owners"],
                "report_uuid": report,
            }
            units.append((start, end, [case_event(r, start, end, args)]))
        return units

    clock = Clock()
    start = clock(runs[0]["start_ms"])
    outcomes = Counter(r["outcome"] for r in runs)
    args = {"report_uuid": report, "owners": runs[0]["owners"], **outcomes}
    report_slice = slice_event(start, start, runs[0]["file"], "report", args)
    events = [report_slice]
    # Consecutive tests of one suite share a suite slice.
    for suite, group_iter in itertools.groupby(runs, key=lambda r: r["suite"]):
        group = list(group_iter)
        suite_slice = None
        if suite:
            suite_slice = slice_event(clock(group[0]["start_ms"]), 0, suite, "suite")
            events.append(suite_slice)
        for r in group:
            case_start = clock(r["start_ms"])
            events.append(case_event(r, case_start, clock(r["end_ms"]), {}))
        if suite_slice:
            suite_slice["dur"] = clock(group[-1]["end_ms"]) - suite_slice["ts"]
    end = clock(runs[-1]["end_ms"])
    report_slice["dur"] = end - start
    return [(start, end, events)]


def pack_lanes(units: List[Unit]) -> List[List[Unit]]:
    """Greedy interval partitioning: as many lanes as the peak overlap."""

    def key(u: Unit) -> Tuple[int, int, str, str]:
        first = u[2][0]  # identical intervals are ordered by name, then report
        return (
            u[0],
            -u[1],
            first["name"],
            first.get("args", {}).get("report_uuid", ""),
        )

    lanes: List[List[Unit]] = []
    for unit in sorted(units, key=key):
        lane = next((ln for ln in lanes if ln[-1][1] <= unit[0]), None)
        if lane is None:
            lanes.append([unit])
        else:
            lane.append(unit)
    return lanes


def job_events(
    pid: int, job_id: int, job_rows: List[Row], runs: List[Row]
) -> Tuple[List[Event], JobStats]:
    job = job_rows[0] if job_rows else {}
    # Perfetto reads tid 0 as the main thread (tid == pid), so each job gets its
    # own block of tids that are neither 0 nor a pid: the job track, then lanes.
    job_tid = pid * 1000

    def meta(tid: int, name: str, args: Dict[str, Any]) -> Event:
        return {"ph": "M", "pid": pid, "tid": tid, "name": name, "args": args}

    events: List[Event] = [
        {
            "ph": "M",
            "pid": pid,
            "name": "process_name",
            "args": {"name": f"{job.get('name', 'unknown job')} ({job_id})"},
        },
        {
            "ph": "M",
            "pid": pid,
            "name": "process_sort_index",
            "args": {"sort_index": pid},
        },
        meta(job_tid, "thread_name", {"name": "job"}),
        meta(job_tid, "thread_sort_index", {"sort_index": 0}),
    ]

    test_step = None
    if job and job["end_ms"] > job["start_ms"]:
        args = {k: job[k] for k in ("url", "conclusion", "runner", "labels")}
        events.append(
            {
                **slice_event(
                    job["start_ms"] * 1000, job["end_ms"] * 1000, "job", "job", args
                ),
                "pid": pid,
                "tid": job_tid,
            }
        )
        for s in job_rows:
            # Clip to the job so steps nest; skipped steps have no duration.
            start = max(s["step_start_ms"], job["start_ms"])
            end = min(s["step_end_ms"], job["end_ms"])
            if s["step"] and end > start:
                step = slice_event(
                    start * 1000,
                    end * 1000,
                    s["step"],
                    "step",
                    {"conclusion": s["step_conclusion"]},
                )
                events.append({**step, "pid": pid, "tid": job_tid})
                if s["step"] == "Test":
                    test_step = (end - start) / 60000

    by_report: Dict[str, List[Row]] = defaultdict(list)
    for r in runs:
        by_report[r["report"]].append({**r, "end_ms": max(r["end_ms"], r["start_ms"])})
    units = [u for report, rs in by_report.items() for u in report_units(report, rs)]

    lanes = pack_lanes(units)
    for i, lane in enumerate(lanes, start=1):
        tid = job_tid + i
        events.append(meta(tid, "thread_name", {"name": f"lane {i}"}))
        events.append(meta(tid, "thread_sort_index", {"sort_index": i}))
        events.extend(
            {**e, "pid": pid, "tid": tid} for _, _, unit in lane for e in unit
        )

    busy, covered = 0, -1
    for start, end, _ in sorted(units, key=lambda u: u[0]):
        busy += max(0, end - max(start, covered))
        covered = max(covered, end)
    stats = JobStats(len(runs), len(by_report), len(lanes), busy / 6e7, test_step)
    return events, stats


def build_trace(
    job_ids: Sequence[int], job_rows: List[Row], run_rows: List[Row]
) -> Tuple[Dict[str, Any], Dict[int, JobStats]]:
    """The trace, one process per job in job_ids order, and per-job stats."""
    jobs: Dict[int, List[Row]] = defaultdict(list)
    runs: Dict[int, List[Row]] = defaultdict(list)
    for row in job_rows:
        jobs[row["job"]].append(row)
    for row in run_rows:
        runs[row["job"]].append(row)

    events: List[Event] = []
    stats: Dict[int, JobStats] = {}
    for pid, job_id in enumerate(job_ids, start=1):
        job_evts, stats[job_id] = job_events(pid, job_id, jobs[job_id], runs[job_id])
        events += job_evts
    return {"displayTimeUnit": "ms", "traceEvents": events}, stats
