"""Features step: one row per (unit, candidate test) with its label, TD's score as served
(Before), and the After system's signals; plus one row of PR stats per unit.

Every signal for a unit uses only data from before the unit's time: rating versions
live then (Before), ratings rebuilt for the unit's day from history before that day
(After), failures of the same PR before it, main failures by job completion time.
"""

import json
import logging
import multiprocessing as mp
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from torchci.td.analysis import config, gitdata, heuristics, labels, ratings
from torchci.td.analysis.ratings import normalize, sums
from torchci.td.analysis.schema import load, save, write_manifest
from torchci.td.llm.events import test_file_of
from torchci.td.llm.replay import FileTimes


logger = logging.getLogger(__name__)

DAY = 86400
SIGNALS = (
    "fail", "fail_n", "coedit", "coedit_n", "profiling_n", "edited", "mentioned", "prev_failed",
    "filepath", "filepath_n", "public_bindings", "fail_share", "test_seconds",
)
UNIT_STATS = (
    "n_files", "n_src_files", "n_test_files", "sig_added", "sig_deleted", "added", "deleted",
    "docs_only", *[f"area_{a}" for a in config.AREAS],
)

# Shared with forked workers.
CTX: dict[str, Any] = {}


def area_flags(files: list[str]) -> dict[str, int]:
    return {f"area_{a}": int(any(f.startswith(p) or f == p for f in files for p in prefixes)) for a, prefixes in config.AREAS.items()}


def unit_stats(u: dict[str, Any]) -> dict[str, Any]:
    files = u["changed"]
    src = [f for f in files if gitdata.significant(f)]
    return {
        "unit_id": u["unit_id"], "n_files": len(files), "n_src_files": len(src),
        "n_test_files": sum(f.startswith("test/") for f in files),
        "sig_added": u["sig_added"], "sig_deleted": u["sig_deleted"], "added": u["added"], "deleted": u["deleted"],
        "docs_only": int(heuristics.docs_only(CTX["snapshot"], files)), **area_flags(files),
    }


def day_of(ts: int) -> int:
    return ts - ts % DAY


@lru_cache(maxsize=4)
def version(kind: str, sha: str) -> Any:
    return CTX["versions"][kind].load(sha)


def unit_rows(u: dict[str, Any], fail_new: Any, coedit_new: Any) -> pd.DataFrame:
    snap, tests, changed, t = CTX["snapshot"], u["candidates"], u["changed"], u["time"]
    v = CTX["versions"]
    fail_old, coedit_old = version("fail", v["fail"].live(t)), version("coedit", v["coedit"].live(t))
    before = heuristics.td_sum(snap, changed, tests, fail_old, coedit_old, CTX["profiling"], u["mentioned"], u["prev_failed"])
    f_raw, c_raw = sums(fail_new, changed, tests), sums(coedit_new, changed, tests)
    fp_raw = heuristics.filepath_raw(snap, changed, tests)
    prof = normalize(sums(CTX["profiling"], changed, tests))
    edited = heuristics.edited(snap, changed, tests)
    pb = heuristics.public_bindings(changed, tests)
    share = CTX["fail_share"](t, tests)
    df = pd.DataFrame({"test": tests})
    df["unit_id"] = u["unit_id"]
    df["before_replay"] = df["test"].map(before)
    df["before_score"] = df["test"].map(u["logged"]) if u["logged"] is not None else df["before_replay"]
    for name, part in (("fail", f_raw), ("coedit", c_raw), ("filepath", fp_raw)):
        df[name] = df["test"].map(part).fillna(0.0)
        df[f"{name}_n"] = df["test"].map(normalize(part)).fillna(0.0)
    df["profiling_n"] = df["test"].map(prof).fillna(0.0)
    df["edited"] = df["test"].isin(edited).astype(np.int8)
    df["mentioned"] = df["test"].isin(set(u["mentioned"])).astype(np.int8)
    df["prev_failed"] = df["test"].isin(set(u["prev_failed"])).astype(np.int8)
    df["public_bindings"] = ((df["test"] == heuristics.PUBLIC_BINDINGS) & pb).astype(np.int8)
    df["fail_share"] = df["test"].map(share).fillna(0.0)
    df["test_seconds"] = df["test"].map(CTX["seconds"]).fillna(0.0)
    pos, obs = set(u["positives"]), u["observed"]
    if u["kind"] == "main":
        df["y"] = df["test"].isin(pos).astype(float)
    else:
        y = np.where(df["test"].isin(pos), 1.0, np.nan)
        if u["kind"] == "pr_off" and obs is not None:
            y = np.where(np.isnan(y) & df["test"].isin(set(obs)), 0.0, y)
        df["y"] = y
    float_cols = [c for c in df.columns if c not in ("test", "unit_id", "y") and df[c].dtype == np.float64]
    df[float_cols] = df[float_cols].astype(np.float32)
    return df


def run_day(day: int) -> list[pd.DataFrame]:
    units = CTX["by_day"][day]
    fail_new = ratings.rebuild_fail(CTX["history"], CTX["merge_bases"], day)
    coedit_new = ratings.rebuild_coedit(CTX["commit_files"], CTX["all_tests"], day)
    out = [unit_rows(u, fail_new, coedit_new) for u in units]
    logger.info("day %s: %d units", datetime.fromtimestamp(day, timezone.utc).date(), len(units))
    return out


def unit_inputs(cache: Path) -> list[dict[str, Any]]:
    units = load(cache, "labels", "units")
    commits = load(cache, "fetch", "commits").set_index("sha")
    pr_fail, pr_meta = load(cache, "fetch", "pr_fail"), load(cache, "fetch", "pr_meta").set_index("pr_number")
    mb = load(cache, "fetch", "merge_bases").set_index("sha")
    diffs = CTX.get("pr_paths", {})
    earlier = pr_fail.assign(ts=pr_fail["failed_at"].map(lambda s: int(datetime.fromisoformat(str(s)[:19]).replace(tzinfo=timezone.utc).timestamp())))
    by_pr = {pr: list(zip(g["ts"], g["file"], g["head_sha"])) for pr, g in earlier.groupby("pr_number")}
    out = []
    for u in units.to_dict("records"):
        pr = int(u["pr_number"])
        # PreviouslyFailedInPR reads the cache of the PR's earlier pushes: failures at the
        # unit's own head (other jobs of the same push) were not there yet.
        prev = sorted({f for ts, f, head in by_pr.get(pr, []) if ts < u["time"] and head != u["sha"]})
        if u["kind"] == "main":
            c = commits.loc[u["sha"]]
            u.update(changed=list(c["files"]), mentioned=list(c["mentioned"]), added=int(c["added"]), deleted=int(c["deleted"]),
                     sig_added=int(c["sig_added"]), sig_deleted=int(c["sig_deleted"]))
        else:
            changed = diffs.get(u["unit_id"]) or (list(mb.loc[u["sha"], "changed_files"]) if u["sha"] in mb.index else [])
            meta = pr_meta.loc[pr] if pr in pr_meta.index else None
            u.update(changed=changed, mentioned=list(meta["mentioned"]) if meta is not None else [],
                     added=np.nan, deleted=np.nan, sig_added=np.nan, sig_deleted=np.nan)
            u["logged"] = {test_file_of(k): max(v, u["logged"].get(test_file_of(k), -9)) for k, v in u["logged"].items()} if u["logged"] else None
        u["prev_failed"] = prev
        out.append(u)
    return out


def run(cache: Path, repo: Path) -> None:
    gs = cache.parent / "gs" if (cache.parent / "gs").exists() else cache / "gs"
    CTX["snapshot"] = str(cache.parent / "pytorch-src")
    CTX["versions"] = {k: ratings.Versions(gs, k) for k in ("fail", "coedit")}
    prof = ratings.Versions(gs, "profiling")
    CTX["profiling"] = prof.load(prof.pairs[-1][1])
    times = ratings.Versions(gs, "times")
    CTX["seconds"] = FileTimes(times.load(times.live(int(config.WINDOW_START.replace(tzinfo=timezone.utc).timestamp())))).fallback
    hist = load(cache, "fetch", "fail_history")
    CTX["history"] = [{"head_sha": s, "failure": f, "ts": int(t)} for s, f, t in hist[["head_sha", "file", "ts"]].itertuples(index=False)]
    mb = load(cache, "fetch", "merge_bases")
    CTX["merge_bases"] = {s: {"merge_base": m, "changed_files": list(c)} for s, m, c in mb.itertuples(index=False)}
    universe = load(cache, "fetch", "universe")
    CTX["all_tests"] = set().union(*map(set, universe["tests"]))
    CTX["commit_files"] = ratings.main_commit_files(repo, "2025-07-01")
    CTX["fail_share"] = labels.make_fail_share(load(cache, "fetch", "main_fail"), load(cache, "fetch", "pushes"))
    pr_paths_file = cache / "llm" / "pr_paths.json"
    if pr_paths_file.exists():
        CTX["pr_paths"] = json.loads(pr_paths_file.read_text())
    units = unit_inputs(cache)
    by_day: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for u in units:
        by_day[day_of(int(u["time"]))].append(u)
    CTX["by_day"] = by_day
    with mp.get_context("fork").Pool(config.N_JOBS) as pool:
        parts = [df for dfs in pool.imap_unordered(run_day, sorted(by_day)) for df in dfs]
    rows = pd.concat(parts, ignore_index=True)
    stats = pd.DataFrame([unit_stats(u) for u in units])
    save(cache, "features", "rows", rows)
    save(cache, "features", "unit_stats", stats)
    write_manifest(cache, "features", {"rows": rows, "unit_stats": stats})
