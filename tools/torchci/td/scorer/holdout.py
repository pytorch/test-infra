"""The TD-off holdout: PR runs of td-holdout-unstable, which ran every test file with TD
off, and the TD scorer's and TD's own catches on their PR-specific failures.

The holdout set is built once: one `unit` per (run, build env, test config) with the
files that ran and the failed files, under the same rules as training (shards.py),
except that the job's conclusion is not required to be `failure`: the holdout workflow's
test jobs conclude `success` whatever their tests do. One `run` per run with the TD log
of a TD job at the same head sha, which ran but whose cut the holdout ignored. A unit
whose head has no TD log is skipped. It is sound when no fetch failed, at most
MAX_MISSING_LOGS of the heads with a successful TD job lack its log, and it has at least MIN_HOLDOUT_EVENTS
PR-specific failures; it is stored as a shard file, write-once, only when sound.

At TD's cost per job (TD's include list rebuilt from the log's aggregated scores, as
gate.py does), each PR-specific failure is counted once per (PR, build env, test config,
file), at its first failing run, for TD when its include list holds the file and for the
scorer when its cut does.
"""

from datetime import date, timedelta
from typing import Any, Mapping, Optional

from torchci.td.scorer.gate import Evaluator, HoldoutReport
from torchci.td.scorer.logs import fetch_td_log
from torchci.td.scorer.rows import JobTimes, unit_labels
from torchci.td.scorer.rows_sql import MAIN_FAILURES_SQL, PR_OF_RUN, SETTINGS, units_sql
from torchci.td.scorer.shards import (
    ch_day,
    DayShard,
    fetch_all,
    MAX_FAILING_FILES,
    MAX_MISSING_LOGS,
    query,
    Run,
    td_platform,
    Unit,
)
from torchci.td.scorer.store import dump_shard, load_shard, ShardStore
from torchci.td.scorer.trunk import TD_JOBS_SQL


HOLDOUT_WORKFLOW = "td-holdout-unstable"
HOLDOUT_START = date(2026, 8, 30)
HOLDOUT_STOP = date(2026, 9, 19)
HOLDOUT_PREFIX = "td_scorer/holdout/"
HOLDOUT_KEY = "v2"
MIN_HOLDOUT_EVENTS = 40

RUNS_SQL = f"""
WITH
    hj AS (
        SELECT run_id, min(created_at) AS created_at
        FROM (
            SELECT id, run_id, created_at, workflow_name, dynamoKey
            FROM default.workflow_job
            PREWHERE id IN (
                SELECT id FROM materialized_views.workflow_job_by_created_at
                WHERE created_at >= {{start: DateTime64(3)}}
                    AND created_at < {{stop: DateTime64(3)}}
            )
            WHERE workflow_name = {{workflow: String}}
                AND startsWith(dynamoKey, 'pytorch/pytorch/')
            LIMIT 1 BY id
        )
        GROUP BY run_id
    ),
    r AS (
        SELECT id, head_sha, head_branch, pull_requests, event
        FROM default.workflow_run
        WHERE id IN (SELECT run_id FROM hj) AND repository.full_name = 'pytorch/pytorch'
        ORDER BY run_attempt DESC
        LIMIT 1 BY id
    ),
    s AS (
        SELECT head_sha, max(number) AS number FROM materialized_views.pr_by_sha
        WHERE head_sha IN (SELECT head_sha FROM r) GROUP BY head_sha
    )
SELECT h.run_id AS run_id, h.created_at AS created_at, r.head_sha AS head_sha,
    {PR_OF_RUN} AS pr
FROM hj AS h
INNER JOIN r ON r.id = h.run_id
LEFT JOIN s ON s.head_sha = r.head_sha
WHERE pr > 0
ORDER BY run_id
{SETTINGS}
"""

UNITS_SQL = units_sql(job_failed="true")


def first_events(shard: DayShard) -> list[tuple[Run, Unit, list[str]]]:
    """Each unit, oldest first, with its PR-specific failures not seen earlier for the
    same (PR, build env, test config, file)."""
    runs = {r.run_id: r for r in shard.runs}
    seen: set[tuple[int, str, str, str]] = set()
    out = []
    units = sorted(
        shard.units,
        key=lambda u: (runs[u.run_id].created_at, u.run_id, u.build_env, u.test_config),
    )
    for unit in units:
        run = runs[unit.run_id]
        new = []
        for f in unit_labels(unit)[0]:
            event = (run.pr, unit.build_env, unit.test_config, f)
            if event not in seen:
                seen.add(event)
                new.append(f)
        out.append((run, unit, new))
    return out


def holdout_ok(shard: DayShard) -> bool:
    """No fetch failed, at most MAX_MISSING_LOGS of the heads with a successful TD job
    lack its log, and it has at least MIN_HOLDOUT_EVENTS events."""
    meta = shard.meta
    if "heads_with_td_job" not in meta or "heads_with_log" not in meta:
        return False
    return (
        meta.get("errors", 0) == 0
        and meta["heads_with_log"] >= (1 - MAX_MISSING_LOGS) * meta["heads_with_td_job"]
        and sum(len(new) for _, _, new in first_events(shard)) >= MIN_HOLDOUT_EVENTS
    )


def build_holdout() -> DayShard:
    window = {
        "start": ch_day(HOLDOUT_START)["start"],
        "stop": ch_day(HOLDOUT_STOP)["start"],
        "workflow": HOLDOUT_WORKFLOW,
    }
    runs = {int(r["run_id"]): r for r in query("td_holdout_runs", RUNS_SQL, window)}
    shas = sorted({r["head_sha"] for r in runs.values()})
    shard = DayShard(day=f"holdout-{HOLDOUT_KEY}")
    if not runs:
        shard.meta = {"runs": 0, "errors": 0}
        return shard
    jobs = query("td_holdout_td_jobs", TD_JOBS_SQL, {"shas": shas})
    logs, errors = fetch_all(lambda j: fetch_td_log(int(j["td_job_id"])), jobs)
    by_sha = {j["head_sha"]: log for j, log in zip(jobs, logs) if log is not None}
    params = {"runs": sorted(runs), "shas": shas, "max_failing": MAX_FAILING_FILES}
    unit_rows = query("td_holdout_units", UNITS_SQL, params)
    main_failed: dict[tuple[str, str, str], set[str]] = {}
    day = HOLDOUT_START
    while day < HOLDOUT_STOP:
        for row in query("td_holdout_main", MAIN_FAILURES_SQL, ch_day(day)):
            key = (day.isoformat(), row["build_env"], row["test_config"])
            main_failed.setdefault(key, set()).add(row["test_file"])
        day += timedelta(days=1)
    for row in unit_rows:
        run = runs[int(row["run_id"])]
        env, config = row["build_env"], row["test_config"]
        if run["head_sha"] not in by_sha or not td_platform(env):
            continue
        failed = sorted(row["failed"])
        broken = main_failed.get((str(run["created_at"])[:10], env, config), set())
        shard.units.append(
            Unit(
                run_id=int(row["run_id"]),
                build_env=env,
                test_config=config,
                ran=sorted(row["ran"]),
                excluded=[],
                failed=failed,
                neither=sorted(row["neither"]),
                main_broken=sorted(set(failed) & broken),
            )
        )
    for run_id in sorted({u.run_id for u in shard.units}):
        run, log = runs[run_id], by_sha[runs[run_id]["head_sha"]]
        shard.runs.append(
            Run(
                run_id=run_id,
                pr=int(run["pr"]),
                head_sha=run["head_sha"],
                created_at=str(run["created_at"])[:19],
                heuristics=list(log.heuristics),
                raised=list(log.raised),
                scores=log.scores,
                changed_files=(
                    list(log.changed_files) if log.changed_files is not None else None
                ),
                aggregated=log.aggregated,
            )
        )
    shard.meta = {
        "runs": len(runs),
        "heads": len(shas),
        "heads_with_td_job": len(jobs),
        "heads_with_log": len(by_sha),
        "errors": errors,
        "units_seen": len(unit_rows),
        "units": len(shard.units),
    }
    return shard


def load_or_build(store: Optional[ShardStore]) -> DayShard:
    """The stored holdout set, else a new one, stored when `store` is given and it is
    sound."""
    data = store.get(HOLDOUT_KEY) if store is not None else None
    if data is not None:
        return load_shard(data)
    shard = build_holdout()
    if store is not None and holdout_ok(shard):
        store.put_if_absent(HOLDOUT_KEY, dump_shard(shard))
    return shard


def evaluate_holdout(
    model: Mapping[str, Any], shard: DayShard, times: JobTimes
) -> HoldoutReport:
    ev = Evaluator(model, times)
    report = HoldoutReport(healthy=holdout_ok(shard))
    prs: set[int] = set()
    for run, unit, new in first_events(shard):
        if not new:
            continue
        selected, include = ev.cut(run, unit)
        prs.add(run.pr)
        report.jobs += 1
        report.td_files += len(include)
        report.scorer_files += len(selected)
        report.events += len(new)
        report.td_caught += sum(f in include for f in new)
        report.scorer_caught += sum(f in selected for f in new)
    report.prs = len(prs)
    return report
