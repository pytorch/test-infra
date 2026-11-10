"""TD's heuristics as pytorch serves them, for training rows: the replicas of the
heuristics that need no rating file, the failure ratings rebuilt for a day with
test-infra's own generator functions, TD's normalisations, and the per-unit change
stats of spec.py.

Filepath, the docs-only rule and the test-file mapping are pytorch's own helpers,
imported from an archive of the clone's tools/ (the heuristic classes themselves run git
and the GitHub API, so only their pure helpers are called)."""

import importlib
import io
import math
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional

from torchci.td.historical_file_failure_correlation import filter_tests
from torchci.td.labels.schema import DAY
from torchci.td.llm import pytorch_repo
from torchci.td.llm.cache import ensure_dir
from torchci.td.scorer import gitdata, spec
from torchci.td.scorer.gitdata import significant
from torchci.td.scorer.history import HISTORY_DAYS
from torchci.td.utils import (
    calculate_generic_test_ratings,
    HALF_LIFE_DAYS,
    positive_rounded,
)


PUBLIC_BINDINGS = "test_public_bindings"
PUBLIC_BINDINGS_FILES = ("test/allowlist_for_publicAPI.json",)
# normalize_ratings' (max_value, min_value) per heuristic, and the score every test gets
# from Filepath on a docs-only change.
RATING_TOP = 0.25
FILEPATH_RANGE = (0.25, 0.125)
DOCS_ONLY_SCORE = -1.0
HELPER_PATHS = ("tools/__init__.py", "tools/stats", "tools/testing")
HEURISTICS_PACKAGE = "tools.testing.target_determination.heuristics"

Ratings = Mapping[str, Mapping[str, float]]


@dataclass(frozen=True)
class Helpers:
    """pytorch's pure TD helpers the replicas call."""

    python_test_file_to_test_name: Callable[[set[str]], set[str]]
    additional_mappings: Mapping[str, list[str]]
    get_freq_dict: Callable[[list[str], list[str]], Mapping[str, int]]
    is_docs_only_change: Callable[[list[str]], bool]


def extract_tools(repo: Path, commit: str, root: Path) -> None:
    """pytorch's tools/ helpers at `commit`, extracted read-only into `root`."""
    tmp = Path(tempfile.mkdtemp(dir=ensure_dir(root.parent), prefix=".extract-"))
    try:
        archive = subprocess.run(
            ["git", "-C", str(repo), "archive", commit, *HELPER_PATHS],
            capture_output=True,
            check=True,
            timeout=pytorch_repo.GIT_SLOW_TIMEOUT_SECONDS,
        ).stdout
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(tmp, filter="data")
        os.replace(tmp, root)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def load_helpers(repo: Path, cache: Path) -> Helpers:
    """pytorch's helpers as of the clone's main (gitdata.MAIN_REFS: the code TD
    serves), imported from an extracted copy put first on sys.path; the copy holds only
    `tools/`, so nothing else is shadowed. A process imports one copy: a `tools`
    package already loaded from elsewhere is an error."""
    commit = gitdata.main_ref(repo)
    if commit is None:
        raise RuntimeError(f"no main branch in {repo}")
    root = cache / "pytorch-tools" / commit
    if not (root / "tools").exists():
        extract_tools(repo, commit, root)
    loaded = sys.modules.get("tools")
    if loaded is not None and Path(str(loaded.__file__)).parent != root / "tools":
        raise RuntimeError(f"a different `tools` package is loaded: {loaded.__file__}")
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    edited_by_pr = importlib.import_module(f"{HEURISTICS_PACKAGE}.edited_by_pr")
    filepath = importlib.import_module(f"{HEURISTICS_PACKAGE}.filepath")
    utils = importlib.import_module(f"{HEURISTICS_PACKAGE}.utils")
    return Helpers(
        python_test_file_to_test_name=utils.python_test_file_to_test_name,
        additional_mappings=edited_by_pr.ADDITIONAL_MAPPINGS,
        get_freq_dict=filepath.get_freq_dict,
        is_docs_only_change=utils.is_docs_only_change,
    )


def edited(h: Helpers, changed: list[str], tests: Iterable[str]) -> set[str]:
    """EditedByPR: the test files the change edits, plus run_test.py's mappings."""
    out = set(h.python_test_file_to_test_name(set(changed)))
    for test, regexes in h.additional_mappings.items():
        if any(re.search(r, f) is not None for r in regexes for f in changed):
            out.add(test)
    return out & set(tests)


def public_bindings(changed: list[str], tests: Iterable[str]) -> set[str]:
    """PublicBindings: test_public_bindings when the change touches torch/ or the
    public API allowlist."""
    touched = any(f.startswith("torch/") or f in PUBLIC_BINDINGS_FILES for f in changed)
    return {PUBLIC_BINDINGS} & set(tests) if touched else set()


def docs_only(h: Helpers, changed: list[str]) -> bool:
    return bool(h.is_docs_only_change(changed))


def sums(
    ratings: Ratings, changed: list[str], tests: Iterable[str]
) -> dict[str, float]:
    """get_ratings_for_tests: per test, the ratings summed over the changed files in
    their order, kept for the given tests."""
    out: dict[str, float] = {}
    for f in changed:
        for t, v in ratings.get(f, {}).items():
            out[t] = out.get(t, 0.0) + v
    keep = set(tests)
    return {t: v for t, v in out.items() if t in keep}


def normalize(
    scores: Mapping[str, float], top: float, bottom: float = 0.0
) -> dict[str, float]:
    """normalize_ratings: the largest score maps to `top`, 0 to `bottom`. A score <= 0
    makes pytorch's version raise, which leaves the heuristic at 0 for every test."""
    if not scores or min(scores.values()) <= 0:
        return {}
    mx = max(scores.values())
    return {t: v / mx * (top - bottom) + bottom for t, v in scores.items()}


def rating_served(
    ratings: Ratings, changed: list[str], tests: list[str]
) -> dict[str, float]:
    """A rating-file heuristic's score (CorrelatedWithHistoricalFailures,
    HistorialEditedFiles, Profiling), normalised over `tests`."""
    return normalize(sums(ratings, changed, tests), RATING_TOP)


def filepath_served(
    h: Helpers, changed: list[str], tests: list[str]
) -> dict[str, float]:
    """Filepath's score over `tests`: DOCS_ONLY_SCORE for every test on a docs-only
    change, else the keyword frequency normalised into FILEPATH_RANGE."""
    if docs_only(h, changed):
        return dict.fromkeys(tests, DOCS_ONLY_SCORE)
    keep = set(tests)
    raw = {t: float(v) for t, v in h.get_freq_dict(tests, changed).items() if t in keep}
    return normalize(raw, *FILEPATH_RANGE)


def rebuild_fail(
    history: list[dict[str, Any]],
    merge_bases: Mapping[str, Mapping[str, Any]],
    day: int,
    exclude: Optional[str] = None,
) -> Ratings:
    """file_test_rating.json as the generator writes it on `day` (unix seconds): the
    failures of the HISTORY_DAYS before it, minus those also failing on their merge
    base, decayed with HALF_LIFE_DAYS to `day`. `exclude` leaves out a head's own
    failures: TD ranks a head before any of its jobs fail."""
    rows = [
        r
        for r in history
        if day - HISTORY_DAYS * DAY <= r["ts"] < day
        and r["head_sha"] in merge_bases
        and r["head_sha"] != exclude
    ]
    kept = filter_tests(rows, merge_bases)
    ratings = calculate_generic_test_ratings(
        kept, merge_bases, lambda x: x["failure"], HALF_LIFE_DAYS, now=day
    )
    return positive_rounded(ratings)


def unit_stats(h: Helpers, changed: list[str]) -> dict[str, float]:
    """spec.UNIT_STATS of a change's files."""
    out = {
        "n_files": float(len(changed)),
        "n_src_files": float(sum(significant(f) for f in changed)),
        "n_test_files": float(sum(f.startswith("test/") for f in changed)),
        "docs_only": float(docs_only(h, changed)),
    }
    for area, prefixes in spec.AREAS.items():
        out[f"area_{area}"] = float(any(f.startswith(prefixes) for f in changed))
    return out


def risk_inputs(
    stats: Mapping[str, float], sig_added: float, sig_deleted: float
) -> dict[str, float]:
    """spec.RISK_INPUTS of a unit from its stats and significant line counts (NaN when
    the diff was not read)."""
    derived = {
        "log_files": math.log1p(stats["n_files"]),
        "log_src_files": math.log1p(stats["n_src_files"]),
        "log_sig_added": math.log1p(sig_added),
        "log_sig_deleted": math.log1p(sig_deleted),
    }
    return {f: float(derived.get(f, stats.get(f, math.nan))) for f in spec.RISK_INPUTS}
