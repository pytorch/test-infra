"""The tables the steps hand each other, how they are stored, and the results JSON.

Each step writes its tables as pandas pickles under `<cache>/<step>/`, then a
`manifest.json` naming them with their row counts. A step reads only tables whose step
manifest says `ok`; the pickles are the pipeline's own output, never downloaded.
"""

import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# step -> table -> required columns. A unit is a landed main commit (`c:<sha>`) or a PR
# config at a head (`p:<pr>:<head sha>:<build env>:<test config>`); times are unix seconds.
TABLES: dict[str, dict[str, tuple[str, ...]]] = {
    "fetch": {
        "pushes": ("push_sha", "before_sha", "pushed_at", "commit_shas"),
        # Every landed main commit in the window, diffed against its parent.
        "commits": (
            "sha",
            "parent",
            "push_sha",
            "pushed_at",
            "push_size",
            "pr_number",
            "is_revert",
            "author_key",
            "files",
            "added",
            "deleted",
            "sig_added",
            "sig_deleted",
            "mentioned",
            "diff_ok",
        ),
        # Failing test files of failed pull/trunk jobs on main pushes.
        "main_fail": (
            "push_sha",
            "workflow",
            "build_environment",
            "test_config",
            "file",
            "completed_at",
        ),
        # Every pull/trunk test job on main pushes: which shards reported and how.
        "main_jobs": (
            "push_sha",
            "workflow",
            "build_environment",
            "test_config",
            "shard",
            "shards",
            "conclusion",
            "completed_at",
            "job_id",
        ),
        # td_trunk_breakages events, with the landed commits of each event's stack.
        "gold": (
            "landing_sha",
            "landed_at",
            "stack_size",
            "outcome",
            "test_files",
            "window_closed",
            "commit_shas",
            "test_file_list",
            "test_outcomes",
        ),
        # PR-specific failures: per (PR, file) the first row overall (kind "first") and
        # the first TD-off row (kind "first_off"), each with its logged ranking.
        "pr_fail": (
            "kind",
            "pr_number",
            "head_sha",
            "base_sha",
            "file",
            "failed_at",
            "td_off",
            "run_id",
            "job_id",
            "workflow",
            "build_environment",
            "test_config",
            "position",
            "n",
            "all_scores",
            "n_jobs",
            "n_heads",
        ),
        # Test files that ran in the jobs of a PR config at a head (run evidence).
        "pr_ran": ("pr_number", "head_sha", "build_environment", "test_config", "ran"),
        # Per PR: hashed author and the test names its body and linked issues mention.
        "pr_meta": ("pr_number", "author_key", "mentioned"),
        # Failure history for the rating rebuild: earliest failure per (sha, file) in
        # failed jobs of every workflow.
        "fail_history": ("head_sha", "file", "ts"),
        # Changed files and merge base of every sha the history and the units name.
        "merge_bases": ("sha", "merge_base", "changed_files"),
        # TESTS per month (that month's snapshot) plus the C++ tests logged that month.
        "universe": ("month", "commit", "tests"),
    },
    "labels": {
        "silver": ("sha", "push_sha", "pushed_at", "file", "fail_share", "train_ok"),
        "units": (
            "unit_id",
            "kind",
            "time",
            "sha",
            "pr_number",
            "candidates",
            "positives",
            "observed",
            "logged",
        ),
        "gold": (
            "landing_sha",
            "landed_at",
            "outcome",
            "test_files",
            "window_closed",
            "commit_shas",
        ),
    },
    "rankings": {
        # Test lists of the configs that failed at a silver or gold landing's main push.
        "main_ranks": (
            "push_sha",
            "workflow",
            "build_environment",
            "test_config",
            "file",
            "candidates",
        ),
    },
    "llm": {
        "scores": ("unit_id", "test", "llm_raw", "llm_tq"),
    },
    "features": {
        # One row per (unit, candidate test). `y` is 1, 0, or NaN where the test did not run.
        "rows": ("unit_id", "test", "y", "before_score", "before_replay"),
        "unit_stats": ("unit_id",),
    },
    "train": {
        "preds": ("unit_id", "test", "p_raw", "p", "week"),
        "risk": ("unit_id", "risk", "week"),
        "importance": ("feature", "mean", "lo", "hi"),
    },
}

RESULTS_FILE = "results.json"
MANIFEST = "manifest.json"


def step_dir(cache: Path, step: str) -> Path:
    path = cache / step
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def code_commit() -> str:
    out = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=Path(__file__).parent,
        capture_output=True,
        text=True,
        check=False,
    )
    return out.stdout.strip() or "unknown"


def write_atomic(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def save(cache: Path, step: str, name: str, df: Any) -> None:
    missing = [c for c in TABLES[step][name] if c not in df.columns]
    if missing:
        raise ValueError(f"{step}/{name} lacks columns {missing}")
    path = step_dir(cache, step) / f"{name}.pkl"
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{name}.")
    os.close(fd)
    df.to_pickle(tmp)
    os.replace(tmp, path)


def load(cache: Path, step: str, name: str) -> Any:
    import pandas as pd

    manifest = read_manifest(cache, step)
    if name not in manifest["tables"]:
        raise RuntimeError(f"{step} manifest has no table {name}")
    df = pd.read_pickle(cache / step / f"{name}.pkl")
    if len(df) != manifest["tables"][name]:
        raise RuntimeError(
            f"{step}/{name} has {len(df)} rows, manifest says {manifest['tables'][name]}"
        )
    return df


def write_manifest(cache: Path, step: str, tables: dict[str, Any], **info: Any) -> None:
    manifest = {
        "status": "ok",
        "step": step,
        "written_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "code_commit": code_commit(),
        "tables": {name: len(df) for name, df in tables.items()},
        **info,
    }
    path = step_dir(cache, step) / MANIFEST
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".manifest.")
    with os.fdopen(fd, "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


def read_manifest(cache: Path, step: str) -> dict[str, Any]:
    path = cache / step / MANIFEST
    if not path.exists():
        raise RuntimeError(f"step {step} has not run: no {path.name}")
    manifest = json.loads(path.read_text())
    if manifest.get("status") != "ok":
        raise RuntimeError(
            f"step {step} did not finish: status {manifest.get('status')}"
        )
    return manifest
