"""New, confirmed test failures on main after merging, with the main push's own TD log.

A failure is a (landing, config, test file) of a pytorch/pytorch push to main, where the
config is `workflow / job base name / test config` of a TD-scope test job (osdc jobs,
`... / test-osdc (...)`, included) and the file failed in default.failed_test_runs. It is
new when, at the push's `before`, every shard of that config completed (success, or
failure with failing tests) and the file failed in no TD-scope config; and confirmed when
it fails again at the first of the next three main heads where the config completed, or
in two run attempts at the landing.

Only single-commit pushes are kept: the main push's TD log ranks HEAD^..HEAD, which for
them is the landed PR's own diff. Each landing is mapped to the mergebot command that
landed it (the default.merges row of its title's PR whose merge_commit_sha is the
landing). Excluded, and counted by reason (each landing or failure under the first reason
that drops it): multi-commit pushes, pushes whose head commit title names no PR, landings
without a merges row, `-f` merges, configs the command waived (as in trunk.waived_configs),
landings without a main TD log, and failures whose file has no outcome row in that config
at the landing. Main failures are evaluation data only.

These are not the main failures of a day shard (rows_sql.MAIN_FAILURES_SQL, Unit.main_broken):
those are every real failure on main that day in a TD-scope config, whatever its cause,
used to keep PR failures that main shares out of the training labels. These are the
failures a landing introduced, attributed to it.

This is the rule of the saved td_failure_ranks query
(torchci/clickhouse_queries/td_failure_ranks), with four differences: failures are every
failed test file in default.failed_test_runs, not the files td_test_failure_stats_v2 ranked;
there is no 90-day window cap; every failure is kept, not the best one per landing; and
test-osdc job names count (td_failure_ranks matches only ` / test (`).
"""

import json
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Sequence

from torchci.td.llm.bundle import atomic_file
from torchci.td.llm.events import _ch_time, chunks
from torchci.td.scorer.logs import TDLog
from torchci.td.scorer.main_failures_sql import MAIN_RUNS_SQL, NEW_FAILURES_SQL
from torchci.td.scorer.rows_sql import units_sql
from torchci.td.scorer.shards import MAX_FAILING_FILES, query, Run, Unit
from torchci.td.scorer.trunk import (
    fetch_head_logs,
    MERGES_SQL,
    split_config,
    waived_configs,
)


CHUNK_DAYS = 31
NEUTRALISED = "PreviouslyFailedInPR"
# Subtracting a heuristic from TD's float sum can leave a residue near 0 that would rank
# the file ahead of the unscored files, which TD orders by name.
ZERO_SCORE = 1e-9
CACHE_VERSION = 2


@dataclass(frozen=True)
class MainUnit:
    build_env: str
    test_config: str
    ran: tuple[str, ...]
    failed: tuple[str, ...]


@dataclass(frozen=True)
class MainLanding:
    landing_sha: str
    pr: int
    day: str
    log: TDLog
    units: tuple[MainUnit, ...]


def fetch_new_failures(start: datetime, stop: datetime) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for lo, hi in chunks(start, stop, CHUNK_DAYS):
        params = {"start": _ch_time(lo), "stop": _ch_time(hi)}
        rows += query("td_scorer_main_new_failures", NEW_FAILURES_SQL, params)
    return rows


def _ran_files(shas: list[str]) -> dict[tuple[str, str, str], set[str]]:
    """(landing sha, build env, test config) -> files with an outcome row there, over the
    sha's main-push TD-scope runs."""
    runs = query("td_scorer_main_runs", MAIN_RUNS_SQL, {"shas": shas})
    sha_of = {int(r["run_id"]): r["head_sha"] for r in runs}
    if not sha_of:
        return {}
    params = {"runs": sorted(sha_of), "shas": shas, "max_failing": MAX_FAILING_FILES}
    out: dict[tuple[str, str, str], set[str]] = {}
    for row in query("td_scorer_main_units", units_sql(), params):
        key = (sha_of[int(row["run_id"])], row["build_env"], row["test_config"])
        out.setdefault(key, set()).update(row["ran"])
    return out


def _add(counts: dict[str, int], key: str, n: int = 1) -> None:
    counts[key] = counts.get(key, 0) + n


def fetch_main_landings(
    start: datetime, stop: datetime
) -> tuple[list[MainLanding], dict[str, int]]:
    """Landings pushed in [start, stop) with new, confirmed failures, and the counts:
    `*_found` before any exclusion, one key per exclusion reason, and what is kept."""
    by_sha: dict[str, list[dict[str, Any]]] = {}
    for row in fetch_new_failures(start, stop):
        by_sha.setdefault(row["landing_sha"], []).append(row)
    counts = {
        "landings_found": len(by_sha),
        "failures_found": sum(len(v) for v in by_sha.values()),
    }

    def drop(reason: str, rows: list[dict[str, Any]]) -> None:
        _add(counts, f"landings_{reason}")
        _add(counts, f"failures_{reason}", len(rows))

    candidates = {}
    for sha, rows in by_sha.items():
        if int(rows[0]["n_commits"]) != 1:
            drop("multi_commit", rows)
        elif int(rows[0]["pr"]) <= 0:
            drop("no_pr", rows)
        else:
            candidates[sha] = rows
    merges = (
        query(
            "td_scorer_main_merges",
            MERGES_SQL,
            {
                "prs": sorted({int(r[0]["pr"]) for r in candidates.values()}),
                "shas": sorted(candidates),
            },
        )
        if candidates
        else []
    )
    commands = {(int(m["pr_num"]), m["merge_commit_sha"]): m for m in merges}
    pairs: dict[str, dict[tuple[str, str], set[str]]] = {}
    for sha, rows in candidates.items():
        command = commands.get((int(rows[0]["pr"]), sha))
        if command is None:
            drop("no_merge", rows)
            continue
        if command["skip_mandatory_checks"]:
            drop("force", rows)
            continue
        waived = waived_configs([command], bool(command["ignore_current"]))
        for row in rows:
            split = split_config(row["config"])
            if split is None:
                _add(counts, "failures_out_of_scope")
            elif row["config"] in waived:
                _add(counts, "failures_waived")
            else:
                pairs.setdefault(sha, {}).setdefault(split, set()).add(row["test_file"])
        if sha not in pairs:
            _add(counts, "landings_all_waived")
    logs = fetch_head_logs(sorted(pairs))
    for sha in [s for s in pairs if s not in logs]:
        drop("no_td_log", [f for files in pairs.pop(sha).values() for f in files])
    ran = _ran_files(sorted(pairs)) if pairs else {}
    landings = []
    for sha in sorted(pairs, key=lambda s: (str(candidates[s][0]["landed_at"]), s)):
        units = []
        for (env, config), files in sorted(pairs[sha].items()):
            seen = ran.get((sha, env, config), set())
            _add(counts, "failures_not_ran", len(files - seen))
            if files & seen:
                units.append(
                    MainUnit(
                        env, config, tuple(sorted(seen)), tuple(sorted(files & seen))
                    )
                )
        if not units:
            _add(counts, "landings_none_ran")
            continue
        first = candidates[sha][0]
        landings.append(
            MainLanding(
                sha,
                int(first["pr"]),
                str(first["landed_at"])[:10],
                logs[sha],
                tuple(units),
            )
        )
    counts["landings"] = len(landings)
    counts["units"] = sum(len(x.units) for x in landings)
    counts["failures"] = sum(len(u.failed) for x in landings for u in x.units)
    return landings, counts


def main_run_unit(landing: MainLanding, unit: MainUnit) -> tuple[Run, Unit]:
    """The landing's unit as a shard run and unit, with PreviouslyFailedInPR neutralised:
    on a main push it reads main's pytest cache, not the PR's earlier failures. It counts
    as raised, and its scores are subtracted from TD's aggregated scores, a plain sum over
    the non-trial heuristics; files left at 0 are dropped, as unscored files rank as 0.
    The log keeps a file's max over its class-level runs, per heuristic and aggregated,
    so for a file with class-level runs the subtraction is approximate."""
    log = landing.log
    neutralised = log.scores.get(NEUTRALISED, {})
    aggregated = {
        f: v
        for f, v in (
            (f, s - neutralised.get(f, 0.0)) for f, s in log.aggregated.items()
        )
        if abs(v) > ZERO_SCORE
    }
    run = Run(
        run_id=0,
        pr=landing.pr,
        head_sha=landing.landing_sha,
        created_at=landing.day,
        heuristics=list(log.heuristics),
        raised=sorted(set(log.raised) | {NEUTRALISED}),
        scores=log.scores,
        changed_files=list(log.changed_files)
        if log.changed_files is not None
        else None,
        aggregated=aggregated,
    )
    return run, Unit(
        run_id=0,
        build_env=unit.build_env,
        test_config=unit.test_config,
        ran=list(unit.ran),
        excluded=[],
        failed=list(unit.failed),
        neither=[],
        main_broken=[],
    )


def landings_caught(
    landings: Sequence[MainLanding],
    select: Callable[[Run, Unit], Sequence[set[str]]],
) -> list[tuple[MainLanding, list[int], int]]:
    """Per landing: for each cut `select` returns (one set of files per cut, the same
    number of cuts on every call), its failures inside that cut; and its failures."""
    rows: list[tuple[MainLanding, list[int], int]] = []
    cuts: Optional[int] = None
    for landing in landings:
        caught: list[int] = []
        total = 0
        for main_unit in landing.units:
            run, unit = main_run_unit(landing, main_unit)
            selections = select(run, unit)
            if cuts is None:
                cuts = len(selections)
            if len(selections) != cuts:
                raise ValueError(f"select returned {len(selections)} cuts, not {cuts}")
            failed = set(unit.failed)
            hits = [len(failed & chosen) for chosen in selections]
            caught = [a + b for a, b in zip(caught, hits)] if caught else hits
            total += len(failed)
        rows.append((landing, caught, total))
    return [(x, c or [0] * (cuts or 0), n) for x, c, n in rows]


def _log_json(log: TDLog) -> dict[str, Any]:
    return {
        "scores": log.scores,
        "heuristics": list(log.heuristics),
        "raised": list(log.raised),
        "changed_files": (
            list(log.changed_files) if log.changed_files is not None else None
        ),
        "aggregated": log.aggregated,
    }


def _log_of(data: dict[str, Any]) -> TDLog:
    changed: Optional[list[str]] = data["changed_files"]
    return TDLog(
        scores={h: dict(v) for h, v in data["scores"].items()},
        heuristics=tuple(data["heuristics"]),
        raised=tuple(data["raised"]),
        changed_files=tuple(changed) if changed is not None else None,
        aggregated=dict(data["aggregated"]),
    )


def _day(value: date) -> str:
    if isinstance(value, datetime):
        raise TypeError(f"a cache range is dates, not the datetime {value}")
    return value.isoformat()


def dump_landings(
    landings: Sequence[MainLanding], start: date, stop: date, counts: Mapping[str, int]
) -> str:
    return json.dumps(
        {
            "version": CACHE_VERSION,
            "start": _day(start),
            "stop": _day(stop),
            "counts": dict(counts),
            "landings": [
                {
                    "landing_sha": x.landing_sha,
                    "pr": x.pr,
                    "day": x.day,
                    "log": _log_json(x.log),
                    "units": [
                        [u.build_env, u.test_config, list(u.ran), list(u.failed)]
                        for u in x.units
                    ],
                }
                for x in landings
            ],
        }
    )


def save_landings(
    path: Path,
    landings: Sequence[MainLanding],
    start: date,
    stop: date,
    counts: Mapping[str, int],
) -> None:
    """Writes the cache to a temporary file in path's directory, then replaces path."""
    with atomic_file(path, "w") as f:
        f.write(dump_landings(landings, start, stop, counts))


def load_landings(text: str) -> tuple[list[MainLanding], dict[str, Any]]:
    """The landings, and meta: {"start": date, "stop": date, "counts": {reason: n}}."""
    data = json.loads(text)
    if not isinstance(data, dict) or data.get("version") != CACHE_VERSION:
        raise ValueError(f"not a version {CACHE_VERSION} main landings cache")
    meta = {
        "start": date.fromisoformat(data["start"]),
        "stop": date.fromisoformat(data["stop"]),
        "counts": {k: int(v) for k, v in data["counts"].items()},
    }
    landings = [
        MainLanding(
            x["landing_sha"],
            int(x["pr"]),
            x["day"],
            _log_of(x["log"]),
            tuple(MainUnit(e, c, tuple(r), tuple(f)) for e, c, r, f in x["units"]),
        )
        for x in data["landings"]
    ]
    return landings, meta
