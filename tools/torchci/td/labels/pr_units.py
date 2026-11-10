"""pr_td_off units (`p:<pr>:<head>:<workflow>:<env>:<config>`): a PR-specific failure
(E2, torchci.td.llm.events: it did not also fail on main within 48 hours) seen in a job
where TD did not cut the tests (macOS, XPU, ONNX). Positives are the unit's failing
files; the files that ran in the config's jobs at that head are what was observed."""

import json
from collections import Counter, defaultdict
from datetime import datetime
from typing import Any, Optional

from torchci.td.labels import queries
from torchci.td.labels.schema import PR_TD_OFF, sql_time, unit_row, unix
from torchci.td.llm import events
from torchci.td.llm.diff import SHA_RE
from torchci.td.llm.events import E2Event, RankRow, test_file_of
from torchci.td.llm.replay import cut_applied


# PR failures that failed in at least this many jobs or heads count as confirmed.
CONFIRMED_MIN = 2

UnitKey = tuple[int, str, str, str, str]


def off_row(e: E2Event, off: list[Any]) -> Optional[RankRow]:
    """The TD-off ranking row of a PR_FAIL_EXTRA match, or None when it does not parse."""
    try:
        scores = json.loads(off[8]) if isinstance(off[8], str) else off[8]
        return RankRow(
            run_id=int(off[0]),
            job_id=int(off[1]),
            workflow=str(off[2]),
            build_environment=str(off[3]),
            test_config=str(off[4]),
            test_file=e.test_file,
            position=int(off[6]),
            max_score=0.0,
            all_scores={str(k): float(v) for k, v in scores.items()},
        )
    except (ValueError, TypeError, AttributeError, OverflowError, RecursionError):
        return None


def td_off_failures(
    e2: list[E2Event], extra_rows: list[dict[str, Any]], dropped: Counter
) -> dict[UnitKey, list[dict[str, Any]]]:
    """E2 failures grouped by the unit of their first TD-off row."""
    extra = {(int(r["pr_number"]), r["test_file"]): r for r in extra_rows}
    groups: dict[UnitKey, list[dict[str, Any]]] = defaultdict(list)
    for e in e2:
        x = extra.get((e.pr_number, e.test_file))
        if not x or not x.get("off") or int(x["off"][1]) <= 0:
            continue
        off = x["off"]
        row = off_row(e, off)
        if row is None:
            dropped["pr_td_off:malformed"] += 1
            continue
        if cut_applied(row):
            dropped["pr_td_off:cut_applied"] += 1
            continue
        if not (isinstance(off[5], str) and SHA_RE.match(off[5])):
            dropped["pr_td_off:no_head"] += 1
            continue
        key = (e.pr_number, off[5], row.workflow, row.build_environment)
        groups[key + (row.test_config,)].append(
            {
                "file": e.test_file,
                "failed_at": events._ts(x["off_failed_at"]),
                "row": row,
                "confirmed": int(x["n_jobs"]) >= CONFIRMED_MIN
                or int(x["n_heads"]) >= CONFIRMED_MIN,
            }
        )
    return groups


def fetch_td_off(
    e2: list[E2Event], start: datetime, stop: datetime, dropped: Counter
) -> dict[UnitKey, list[dict[str, Any]]]:
    window = {"start": sql_time(start), "stop": sql_time(stop)}
    extra = queries.ch("pr_fail_extra", queries.PR_FAIL_EXTRA, window)
    return td_off_failures(e2, extra, dropped)


def run_evidence(times: dict[UnitKey, int]) -> dict[UnitKey, set[str]]:
    """Per unit, given when it failed, the test files that ran in any job of its config
    at its head."""
    by_config: dict[tuple, list[UnitKey]] = defaultdict(list)
    when: dict[tuple, int] = {}
    for k, t in times.items():
        by_config[k[1:]].append(k)
        when[k[1:]] = min(t, when.get(k[1:], t))
    jobs: dict[int, tuple[int, int]] = {}
    config_of: dict[int, tuple] = {}
    for batch in queries.batched(sorted({k[1] for k in times})):
        for r in queries.ch("head_jobs", queries.HEAD_JOBS, {"shas": batch}):
            cfg = (
                r["head_sha"],
                r["workflow"],
                r["build_environment"],
                r["test_config"],
            )
            if cfg in by_config:
                jobs[int(r["job_id"])] = (int(r["run_id"]), when[cfg])
                config_of[int(r["job_id"])] = cfg
    reports = queries.ran_files(jobs) if jobs else {}
    out: dict[UnitKey, set[str]] = defaultdict(set)
    for job in jobs.keys() & reports.keys():
        for key in by_config[config_of[job]]:
            out[key].update(reports[job][0])
    return dict(out)


def td_off_units(groups: dict[UnitKey, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    times = {k: min(unix(g["failed_at"]) for g in grp) for k, grp in groups.items()}
    observed = run_evidence(times) if times else {}
    out = []
    for key, grp in sorted(groups.items()):
        first = min(grp, key=lambda g: (g["failed_at"], g["file"]))
        cand = sorted({test_file_of(k) for k in first["row"].all_scores})
        obs = observed.get(key)
        out.append(
            unit_row(
                unit_id="p:" + ":".join(map(str, key)),
                kind=PR_TD_OFF,
                time=times[key],
                sha=key[1],
                pr_number=key[0],
                candidates=cand,
                positives=sorted({g["file"] for g in grp} & set(cand)),
                observed=sorted(obs) if obs is not None else None,
                single=True,
                confirmed=sorted({g["file"] for g in grp if g["confirmed"]}),
                workflow=key[2],
                build_environment=key[3],
                test_config=key[4],
                train_ok=True,
            )
        )
    return out
