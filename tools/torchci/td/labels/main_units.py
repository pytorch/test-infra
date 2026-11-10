"""Main units: single-commit pushes to pytorch main (`c:<sha>`). Positives are the test
files that newly broke at the push (the silver rule); every other test of that month's
list is a negative."""

import re
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from torchci.td.labels import queries
from torchci.td.labels.schema import epoch, MAIN, month_of, sql_time, unit_row
from torchci.td.llm import pytorch_repo
from torchci.td.llm.diff import SHA_RE


# A newly failing file must fail again within this many later pushes where its config
# reported; units with more newly failing files are infra-wide breaks, kept but not
# trained on.
SILVER_CONFIRM_PUSHES = 3
SILVER_MAX_TRAIN_FILES = 50
# Pushes read around the window: one before its start for the previous push, and enough
# after its end for the confirming pushes.
PUSHES_BEFORE = timedelta(days=1)
PUSHES_AFTER = timedelta(days=3)
REPORTED = ("success", "failure")
PR_RE = re.compile(r"\(#(\d+)\)\s*$")

Config = tuple[str, str, str]


def config_key(row: dict[str, Any]) -> Config:
    return (row["workflow"], row["build_environment"], row["test_config"])


def reported_configs(jobs: Iterable[dict[str, Any]]) -> dict[str, set[Config]]:
    """Per push, the configs every shard of which finished (success or failure)."""
    shards: dict[tuple[str, Config], set[int]] = defaultdict(set)
    total: dict[tuple[str, Config], int] = defaultdict(int)
    for j in jobs:
        if j["conclusion"] in REPORTED:
            key = (j["push_sha"], config_key(j))
            shards[key].add(int(j["shard"]))
            total[key] = max(total[key], int(j["shards"]))
    out: dict[str, set[Config]] = defaultdict(set)
    for (push, cfg), seen in shards.items():
        n = total[(push, cfg)]
        if n > 0 and seen >= set(range(1, n + 1)):
            out[push].add(cfg)
    return out


def silver(
    order: list[str], jobs: list[dict[str, Any]], fail: list[dict[str, Any]]
) -> dict[str, set[str]]:
    """New failures on main per push, td_failure_ranks' evidence rule: f fails in a failed
    job of config c at push i; at push i-1 every shard of c reported and f failed in no
    job; f fails again in c at the first of the next SILVER_CONFIRM_PUSHES pushes where c
    reported. `order` is the pushes by time; `fail` rows carry push_sha, the config
    and file."""
    reported = reported_configs(jobs)
    fails_any: dict[str, set[str]] = defaultdict(set)
    fails_cfg: dict[tuple[str, Config], set[str]] = defaultdict(set)
    configs: dict[str, set[Config]] = defaultdict(set)
    for r in fail:
        fails_any[r["push_sha"]].add(r["file"])
        fails_cfg[(r["push_sha"], config_key(r))].add(r["file"])
        configs[r["push_sha"]].add(config_key(r))
    out: dict[str, set[str]] = defaultdict(set)
    for i in range(1, len(order)):
        push, prev = order[i], order[i - 1]
        for c in configs.get(push, ()):
            if c not in reported.get(prev, ()):
                continue
            later = [
                q
                for q in order[i + 1 : i + 1 + SILVER_CONFIRM_PUSHES]
                if c in reported.get(q, ())
            ]
            if not later:
                continue
            for f in fails_cfg[(push, c)]:
                if f not in fails_any.get(prev, ()) and f in fails_cfg.get(
                    (later[0], c), ()
                ):
                    out[push].add(f)
    return dict(out)


def pr_number_of(title: str) -> int:
    match = PR_RE.search(title or "")
    return int(match.group(1)) if match else 0


def single_commit(push: dict[str, Any]) -> str:
    """The commit of a push that landed exactly one commit, else ''."""
    shas = list(push["commit_shas"])
    return shas[0] if len(shas) == 1 and SHA_RE.match(shas[0]) else ""


def units(
    pushes: list[dict[str, Any]],
    new_failures: dict[str, set[str]],
    candidates: dict[str, list[str]],
    start: datetime,
    stop: datetime,
) -> list[dict[str, Any]]:
    w0, w1 = epoch(start), epoch(stop)
    out = []
    for p in pushes:
        sha, t = single_commit(p), int(p["pushed_at"])
        if not sha or not w0 <= t < w1:
            continue
        month = month_of(t)
        failed = new_failures.get(p["push_sha"], set())
        out.append(
            unit_row(
                unit_id=f"c:{sha}",
                kind=MAIN,
                time=t,
                sha=sha,
                pr_number=pr_number_of(p["title"]),
                candidates_month=month,
                positives=sorted(failed & set(candidates[month])),
                single=True,
                train_ok=len(failed) <= SILVER_MAX_TRAIN_FILES,
            )
        )
    return out


def candidates_by_month(
    repo: Path, cache: Path, months: list[str]
) -> list[dict[str, Any]]:
    """Each month's test list: TESTS at main's last commit before the month."""
    out = []
    for month in months:
        snap = pytorch_repo.snapshot(repo, cache, month)
        tests = sorted(snap.tests)
        out.append({"month": month, "commit": snap.commit, "tests": tests})
    return out


def fetch_pushes(start: datetime, stop: datetime) -> list[dict[str, Any]]:
    params = {
        "start": sql_time(start - PUSHES_BEFORE),
        "stop": sql_time(stop + PUSHES_AFTER),
    }
    rows = queries.ch("main_pushes", queries.MAIN_PUSHES, params)
    seen: dict[str, dict[str, Any]] = {}
    for r in rows:
        seen.setdefault(r["push_sha"], r)
    return sorted(seen.values(), key=lambda r: (int(r["pushed_at"]), r["push_sha"]))


def fetch_failures(
    push_shas: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Test jobs at the pushes, and the failing files of the failed ones."""
    jobs: dict[int, dict[str, Any]] = {}
    for batch in queries.batched(push_shas):
        for r in queries.ch("main_jobs", queries.MAIN_JOBS, {"shas": batch}):
            jobs.setdefault(int(r["job_id"]), r)
    failed = sorted(j for j, r in jobs.items() if r["conclusion"] == "failure")
    fail = []
    for batch in queries.batched(failed, queries.LARGE_BATCH):
        for r in queries.ch("failed_files", queries.FAILED_FILES, {"job_ids": batch}):
            job = jobs[int(r["job_id"])]
            fail.append({**job, "file": r["file"]})
    return list(jobs.values()), fail


def build(
    start: datetime, stop: datetime, repo: Path, cache: Path
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Main units in [start, stop) and the test lists of their months."""
    pushes = fetch_pushes(start, stop)
    order = [p["push_sha"] for p in pushes]
    jobs, fail = fetch_failures(order)
    new_failures = silver(order, jobs, fail)
    w0, w1 = epoch(start), epoch(stop)
    months = sorted(
        {
            month_of(int(p["pushed_at"]))
            for p in pushes
            if single_commit(p) and w0 <= int(p["pushed_at"]) < w1
        }
    )
    lists = candidates_by_month(repo, cache, months)
    by_month = {c["month"]: c["tests"] for c in lists}
    return units(pushes, new_failures, by_month, start, stop), lists
