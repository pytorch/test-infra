"""The rating files TD reads: the versions that were live (Before), and the time-decayed /
PMI ratings (test-infra#9325) rebuilt for a day from the history before it (After), with test-infra's own generator
functions (time decay on failures, shrunk positive PMI on co-edits)."""

import json
import subprocess
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Mapping

from torchci.td.historical_file_failure_correlation import filter_tests
from torchci.td.td_heuristic_historical_edited_files import positive_pmi
from torchci.td.utils import calculate_generic_test_ratings, HALF_LIFE_DAYS, positive_rounded


Ratings = Mapping[str, Mapping[str, float]]
DAY = 86400
FAIL_DAYS = 90
COEDIT_DAYS = 365
STATS = {
    "fail": "stats/file_test_rating.json",
    "coedit": "stats/td_heuristic_historical_edited_files.json",
    "profiling": "stats/td_heuristic_profiling.json",
    "times": "stats/test-times.json",
}


def gs_git(gs: Path, *args: str) -> str:
    return subprocess.run(["git", "--no-optional-locks", "-C", str(gs), *args], capture_output=True, text=True, check=True, timeout=900).stdout


class Versions:
    """The commits of one generated-stats file, by commit time (unix)."""

    def __init__(self, gs: Path, kind: str) -> None:
        self.gs, self.path = gs, STATS[kind]
        pairs = []
        for line in gs_git(gs, "log", "--format=%ct %H", "--", self.path).splitlines():
            ts, sha = line.split()
            pairs.append((int(ts), sha))
        self.pairs = sorted(pairs)
        self.times = [t for t, _ in self.pairs]

    def live(self, at: int) -> str:
        """The version TD downloaded at `at`: the last one committed before it (the
        published file is served with a 5-minute cache, ignored here)."""
        i = bisect_right(self.times, at) - 1
        if i < 0:
            raise LookupError(f"no {self.path} version before {at}")
        return self.pairs[i][1]

    def load(self, sha: str) -> Ratings:
        return json.loads(gs_git(self.gs, "show", f"{sha}:{self.path}"))


def sums(ratings: Ratings, changed: Iterable[str], tests: Iterable[str]) -> dict[str, float]:
    """pytorch's get_ratings_for_tests: per test, the sum over changed files, kept for
    the job's tests."""
    out: dict[str, float] = defaultdict(float)
    for f in changed:
        for t, v in ratings.get(f, {}).items():
            out[t] += v
    keep = set(tests)
    return {t: v for t, v in out.items() if t in keep and v > 0}


def normalize(scores: Mapping[str, float], top: float = 0.25, bottom: float = 0.0) -> dict[str, float]:
    """pytorch's normalize_ratings: the largest score maps to `top`, 0 to `bottom`."""
    if not scores:
        return {}
    mx = max(scores.values())
    return {t: v / mx * (top - bottom) + bottom for t, v in scores.items()}


def rebuild_fail(history: list[dict], merge_bases: Mapping[str, dict], day: int) -> Ratings:
    """file_test_rating.json as the generator writes it on `day`: failures of the 90
    days before, minus those also failing on their merge base, decayed with a 7-day
    half-life to `day`."""
    rows = [r for r in history if day - FAIL_DAYS * DAY <= r["ts"] < day and r["head_sha"] in merge_bases]
    kept = filter_tests(rows, merge_bases)
    ratings = calculate_generic_test_ratings(kept, merge_bases, lambda x: x["failure"], HALF_LIFE_DAYS, now=day)
    return positive_rounded(ratings)


def rebuild_coedit(commits: list[tuple[int, list[str]]], tests: set[str], day: int) -> Ratings:
    """td_heuristic_historical_edited_files.json as the generator writes it on `day`:
    shrunk positive PMI over the main commits of the year before."""
    commit_files = []
    for ts, files in commits:
        if day - COEDIT_DAYS * DAY <= ts < day:
            commit_files.append((files, [x[5:-3] for x in files if x[5:-3] in tests]))
    return positive_rounded(positive_pmi(commit_files))


def main_commit_files(repo: Path, since: str) -> list[tuple[int, list[str]]]:
    """Every first-parent main commit since `since`, with its changed files (read-only)."""
    out = subprocess.run(
        ["git", "--no-optional-locks", "-C", str(repo), "log", "--first-parent", "--no-renames",
         f"--since={since}", "--name-only", "--format=%x00%ct", "main"],
        capture_output=True, text=True, check=True, timeout=900,
    ).stdout
    commits = []
    for block in out.split("\x00")[1:]:
        head, _, rest = block.partition("\n")
        commits.append((int(head.strip()), [x for x in rest.splitlines() if x.strip()]))
    return sorted(commits)
