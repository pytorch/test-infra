"""Labels step: the evaluation and training units and what failed in them.

- main units: landed commits (`c:<sha>`); candidates are that month's TESTS plus the C++
  tests logged that month; positives are silver new failures (single-commit pushes only).
- gold: reverted trunk breakages, mapped to the commits of their stack.
- PR units (`p:<pr>:<head>:<env>:<config>`): PR-specific failures, from the first TD-off
  row (`pr_off`, every test of the config could run) or the first row when TD was on
  (`pr_on`, used only for what a smaller cut would lose).
"""

import logging
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from torchci.td.analysis import config
from torchci.td.analysis.schema import load, save, write_manifest
from torchci.td.llm.events import test_file_of


logger = logging.getLogger(__name__)

DAY = 86400
REPORTED = ("success", "failure")


def unix(value: str) -> int:
    return int(
        datetime.fromisoformat(str(value)[:19]).replace(tzinfo=timezone.utc).timestamp()
    )


def month_of(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m")


def config_key(row: Any) -> tuple[str, str, str]:
    return (row.workflow, row.build_environment, row.test_config)


def reported_configs(jobs: pd.DataFrame) -> dict[str, set[tuple[str, str, str]]]:
    """Per push, the configs every shard of which finished (success or failure)."""
    out: dict[str, set[tuple[str, str, str]]] = defaultdict(set)
    done = jobs[jobs["conclusion"].isin(REPORTED)]
    for (push, wf, env, cfg), grp in done.groupby(
        ["push_sha", "workflow", "build_environment", "test_config"]
    ):
        shards = int(grp["shards"].max())
        if shards > 0 and set(grp["shard"].astype(int)) >= set(range(1, shards + 1)):
            out[push].add((wf, env, cfg))
    return out


def silver(
    pushes: pd.DataFrame, jobs: pd.DataFrame, fail: pd.DataFrame
) -> pd.DataFrame:
    """New failures on main, td_failure_ranks' evidence rule: f fails in a failed job of
    config c at push i; at push i-1 every shard of c reported and f failed in no job; f
    fails again in c at the first of the next SILVER_CONFIRM_PUSHES pushes where c reported."""
    order = pushes.sort_values("pushed_at")["push_sha"].tolist()
    reported = reported_configs(jobs)
    fails_any: dict[str, set[str]] = defaultdict(set)
    fails_cfg: dict[tuple[str, tuple[str, str, str]], set[str]] = defaultdict(set)
    configs: dict[str, set[tuple[str, str, str]]] = defaultdict(set)
    for r in fail.itertuples():
        fails_any[r.push_sha].add(r.file)
        fails_cfg[(r.push_sha, config_key(r))].add(r.file)
        configs[r.push_sha].add(config_key(r))
    rows = []
    for i in range(1, len(order)):
        push, prev = order[i], order[i - 1]
        for c in configs.get(push, ()):
            if c not in reported.get(prev, ()):
                continue
            later = [
                q
                for q in order[i + 1 : i + 1 + config.SILVER_CONFIRM_PUSHES]
                if c in reported.get(q, ())
            ]
            if not later:
                continue
            for f in fails_cfg[(push, c)]:
                if f not in fails_any.get(prev, ()) and f in fails_cfg.get(
                    (later[0], c), ()
                ):
                    rows.append({"push_sha": push, "file": f, "config": "/".join(c)})
    df = pd.DataFrame(rows, columns=["push_sha", "file", "config"])
    return df.drop_duplicates(["push_sha", "file"])


def make_fail_share(fail: pd.DataFrame, pushes: pd.DataFrame) -> Any:
    """share(at, tests): per test, the share of main pushes in the FAIL_SHARE_DAYS before
    `at` where it failed, counting a failure only once its job completed before `at`."""
    times = np.sort(pushes["pushed_at"].to_numpy())
    by_file: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for r in fail[["file", "completed_at", "push_sha"]].itertuples(index=False):
        by_file[r.file].append((int(r.completed_at), r.push_sha))

    def share(at: int, tests: list[str]) -> dict[str, float]:
        lo = at - config.FAIL_SHARE_DAYS * DAY
        n = np.searchsorted(times, at) - np.searchsorted(times, lo)
        if not n:
            return {}
        return {
            t: len({p for c, p in by_file[t] if lo <= c < at}) / n
            for t in tests
            if t in by_file
        }

    return share


def candidates_by_month(
    universe: pd.DataFrame, pr_fail: pd.DataFrame
) -> dict[str, list[str]]:
    cpp: dict[str, set[str]] = defaultdict(set)
    for r in pr_fail.itertuples():
        cpp[str(r.failed_at)[:7]].update(
            test_file_of(k) for k in r.all_scores if k.startswith("cpp/")
        )
    return {
        r.month: sorted(set(r.tests) | cpp.get(r.month, set()))
        for r in universe.itertuples()
    }


def run(cache: Path) -> None:
    pushes, commits = load(cache, "fetch", "pushes"), load(cache, "fetch", "commits")
    jobs, fail = load(cache, "fetch", "main_jobs"), load(cache, "fetch", "main_fail")
    gold, pr_fail = load(cache, "fetch", "gold"), load(cache, "fetch", "pr_fail")
    pr_ran, universe = load(cache, "fetch", "pr_ran"), load(cache, "fetch", "universe")
    cands = candidates_by_month(universe, pr_fail)
    w0, w1 = (
        int(config.MAIN_START.replace(tzinfo=timezone.utc).timestamp()),
        int(config.WINDOW_STOP.replace(tzinfo=timezone.utc).timestamp()),
    )

    sil = silver(pushes, jobs, fail)
    single = commits[(commits["push_size"] == 1) & commits["diff_ok"]].set_index(
        "push_sha"
    )
    sil = sil[sil["push_sha"].isin(single.index)].copy()
    sil["sha"] = sil["push_sha"].map(single["sha"])
    sil["pushed_at"] = sil["push_sha"].map(single["pushed_at"]).astype(int)
    sil = sil[(sil["pushed_at"] >= w0) & (sil["pushed_at"] < w1)]
    per_unit = sil.groupby("sha")["file"].transform("count")
    sil["train_ok"] = per_unit <= config.SILVER_MAX_TRAIN_FILES
    share = make_fail_share(fail, pushes)
    sil["fail_share"] = [
        share(int(t), [f]).get(f, 0.0) for t, f in zip(sil["pushed_at"], sil["file"])
    ]

    units = []
    pos_by_sha = sil.groupby("sha")["file"].apply(list).to_dict()
    gold_shas = {s for shas in gold["commit_shas"] for s in shas}
    in_window = commits[
        (commits["pushed_at"] >= w0) & (commits["pushed_at"] < w1) & commits["diff_ok"]
    ]
    for c in in_window.itertuples():
        if c.push_size != 1 and c.sha not in gold_shas:
            continue
        cand = cands[month_of(int(c.pushed_at))]
        units.append(
            {
                "unit_id": f"c:{c.sha}",
                "kind": "main",
                "time": int(c.pushed_at),
                "sha": c.sha,
                "pr_number": int(c.pr_number),
                "candidates": cand,
                "positives": sorted(set(pos_by_sha.get(c.sha, [])) & set(cand)),
                "observed": None,
                "logged": None,
                "single": c.push_size == 1,
            }
        )
    ran = {
        (r.pr_number, r.head_sha, r.build_environment, r.test_config): set(r.ran)
        for r in pr_ran.itertuples()
    }
    for kind, sel in (
        ("pr_off", pr_fail["kind"] == "first_off"),
        ("pr_on", (pr_fail["kind"] == "first") & ~pr_fail["td_off"]),
    ):
        for key, grp in pr_fail[sel].groupby(
            ["pr_number", "head_sha", "build_environment", "test_config"]
        ):
            first = grp.iloc[0]
            cand = sorted({test_file_of(k) for k in first["all_scores"]})
            obs = ran.get(key)
            units.append(
                {
                    "unit_id": f"p:{key[0]}:{key[1]}:{key[2]}:{key[3]}",
                    "kind": kind,
                    "time": unix(grp["failed_at"].min()),
                    "sha": key[1],
                    "pr_number": int(key[0]),
                    "candidates": cand,
                    "positives": sorted(set(grp["file"]) & set(cand)),
                    "observed": sorted(obs) if obs is not None else None,
                    "logged": first["all_scores"],
                    "single": True,
                    "confirmed": sorted(
                        set(
                            grp.loc[
                                (grp["n_jobs"] >= config.CONFIRMED_MIN)
                                | (grp["n_heads"] >= config.CONFIRMED_MIN),
                                "file",
                            ]
                        )
                    ),
                }
            )
    units_df = pd.DataFrame(units)
    logger.info("units by kind: %s", units_df["kind"].value_counts().to_dict())
    tables = {"silver": sil, "units": units_df, "gold": gold}
    save(cache, "labels", "silver", sil)
    save(cache, "labels", "units", units_df)
    save(cache, "labels", "gold", gold)
    write_manifest(cache, "labels", tables)
