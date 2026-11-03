"""A slow, plain Python statement of what test_cost_mv computes, for tests to
compare the view against. It shares no code with the view: every step is
written from the definitions in fortesting/000004-test-cost-table.sql, and the
occupancy is a brute force (cut time at every span endpoint, split each piece
evenly among the spans covering it), not the view's sweep.

Input is the harness's Job and Run rows; output is the rows test_cost would get,
as dicts with the same columns (computed_at left out).
"""

import re
from collections import defaultdict
from datetime import timedelta
from typing import Dict, List, Optional, Sequence

from test_cost_harness import BASE, Job, Run


TEST_JOB_NAME = re.compile(r"(?:^|/ )test \(")


def _day(seconds: float) -> str:
    return (BASE + timedelta(seconds=seconds)).strftime("%Y-%m-%d")


def _seconds_of_day(day: str) -> float:
    """Seconds after BASE at 00:00 UTC of day."""
    from datetime import datetime, timezone

    return (
        datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc) - BASE
    ).total_seconds()


def _ms(seconds: float) -> int:
    # The harness writes run times with millisecond precision.
    return round(seconds * 1000)


def counted_jobs(
    jobs: Sequence[Job], day_from: str, day_to: str, retention_floor: str = "1970-01-01"
) -> List[Job]:
    """The jobs the cost page counts: started in [day_from, day_to) and not
    before retention_floor (the first day ci.runs holds in full), the newest
    version of each id, completed and not skipped, on a runner, not a rerun
    with a stale start, and at most a day long. workflow_job keeps whole
    seconds."""
    lo = max(_seconds_of_day(day_from), _seconds_of_day(retention_floor))
    hi = _seconds_of_day(day_to)
    newest: Dict[int, Job] = {}
    for job in jobs:
        in_window = lo <= round(job.start) < hi
        if in_window and (job.id not in newest or job.version > newest[job.id].version):
            newest[job.id] = job
    out = []
    for job in newest.values():
        start, end = round(job.start), round(job.end)
        created = start if job.created is None else round(job.created)
        if (
            job.status == "completed"
            and job.conclusion not in ("skipped", "")
            and job.runner != ""
            and start >= created
            and 0 <= end - start <= 86400
        ):
            out.append(job)
    return out


def held_by_brute_force(spans: List[tuple]) -> List[float]:
    """Each span's share of the time, in ms: every piece between consecutive
    endpoints split evenly among the spans covering it."""
    cuts = sorted({t for s, e in spans for t in (s, e)})
    held = [0.0] * len(spans)
    for a, b in zip(cuts, cuts[1:]):
        covering = [i for i, (s, e) in enumerate(spans) if s <= a and b <= e]
        for i in covering:
            held[i] += (b - a) / len(covering)
    return held


def expected_rows(
    jobs: Sequence[Job],
    runs: Sequence[Run] = (),
    owners: Optional[Dict[str, List[str]]] = None,
    day_from: str = "2026-11-01",
    day_to: str = "2026-11-02",
    retention_floor: str = "1970-01-01",
) -> List[dict]:
    owners = owners or {}
    included = counted_jobs(jobs, day_from, day_to, retention_floor)
    by_id = {job.id: job for job in included}
    run_lo, run_hi = _seconds_of_day(day_from), _seconds_of_day(day_to) + 86400

    # Runs of included jobs that started on a day in [day_from, day_to],
    # grouped by job, report and file, then by module (the gtest suite for
    # C++ tests).
    groups: Dict[int, Dict[tuple, Dict[str, list]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(list))
    )
    for run in runs:
        if run.job in by_id and run_lo <= run.start < run_hi:
            module = run.suite if run.language == "cpp" else ""
            groups[run.job][(run.report, run.file)][module].append(run)

    totals: Dict[tuple, Dict[str, float]] = defaultdict(lambda: defaultdict(float))

    def add(job: Job, file: str, module: str, env: int, **seconds: float) -> None:
        key = (
            _day(round(job.start)),
            job.repo,
            job.workflow.lower(),
            file,
            module,
            env,
            ",".join(sorted(job.labels)),
        )
        for column, value in seconds.items():
            totals[key][column] += value

    for job in included:
        job_start, job_end = round(job.start) * 1000, round(job.end) * 1000
        wall = (job_end - job_start) / 1000

        # One span per report and file: first run start to last run end,
        # skipped runs included, clipped to the job; empty spans dropped.
        spans, span_modules, span_env = [], [], []
        for (_report, file), modules in groups.get(job.id, {}).items():
            all_runs = [r for rs in modules.values() for r in rs]
            start = max(min(_ms(r.start) for r in all_runs), job_start)
            end = min(max(_ms(r.end) for r in all_runs), job_end)
            if end <= start:
                continue
            per_module = []
            for module, rs in modules.items():
                executed = (
                    sum(
                        max(0, _ms(r.end) - _ms(r.start))
                        for r in rs
                        if r.outcome != "skipped"
                    )
                    / 1000
                )
                skipped = (
                    sum(
                        max(0, _ms(r.end) - _ms(r.start))
                        for r in rs
                        if r.outcome == "skipped"
                    )
                    / 1000
                )
                per_module.append((file, module, executed, skipped))
            spans.append((start, end))
            span_modules.append(per_module)
            span_env.append(all_runs[0].env)

        if not spans:
            if TEST_JOB_NAME.search(job.name):
                add(
                    job,
                    "",
                    "",
                    0,
                    executed_test_seconds=0.0,
                    skipped_test_seconds=0.0,
                    held_seconds=0.0,
                    occupancy_runner_seconds=wall,
                    test_ratio_runner_seconds=wall,
                )
            continue

        held = [h / 1000 for h in held_by_brute_force(spans)]
        busy = sum(held)
        # The test-time ratio splits by test time, executed and skipped runs both.
        job_test = sum(m[2] + m[3] for modules in span_modules for m in modules)
        for span_held, modules, env in zip(held, span_modules, span_env):
            run_time = sum(executed + skipped for _, _, executed, skipped in modules)
            for file, module, executed, skipped in modules:
                share = (
                    (executed + skipped) / run_time
                    if run_time > 0
                    else 1 / len(modules)
                )
                row_held = span_held * share
                occupancy = wall * row_held / busy
                ratio = (
                    wall * (executed + skipped) / job_test
                    if job_test > 0
                    else occupancy
                )
                add(
                    job,
                    file,
                    module,
                    env,
                    executed_test_seconds=executed,
                    skipped_test_seconds=skipped,
                    held_seconds=row_held,
                    occupancy_runner_seconds=occupancy,
                    test_ratio_runner_seconds=ratio,
                )

    rows = []
    for (day, repo, workflow, file, module, env, labels), values in sorted(
        totals.items()
    ):
        file_owners = owners.get(file, []) if repo == "pytorch/pytorch" else []
        rows.append(
            {
                "day": day,
                "repo": repo,
                "workflow_name": workflow,
                "test_file": file,
                "test_module": module,
                "environments_id": env,
                "runner_labels": labels,
                "owners_snapshot": list(file_owners),
                **{
                    column: values[column]
                    for column in (
                        "executed_test_seconds",
                        "skipped_test_seconds",
                        "held_seconds",
                        "occupancy_runner_seconds",
                        "test_ratio_runner_seconds",
                    )
                },
            }
        )
    return rows
