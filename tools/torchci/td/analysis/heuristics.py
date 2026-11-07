"""TD's heuristics that need no rating file, and TD's sum as served (Before).

Filepath, the docs-only rule, the test-file mapping and TESTS come from a pytorch
snapshot (an archive of pytorch's tools/ and test/), imported as pytorch runs them. Only
those pure helpers are called: the heuristic classes run git and the GitHub API.
"""

import re
import sys
from functools import lru_cache
from typing import Any, Iterable, Mapping

from torchci.td.analysis.ratings import normalize, sums


PUBLIC_BINDINGS = "test_public_bindings"
PUBLIC_BINDINGS_FILES = ("test/allowlist_for_publicAPI.json",)


@lru_cache(maxsize=1)
def pytorch(snapshot: str) -> Any:
    """pytorch's TD helper modules from the snapshot directory (appended to sys.path, so
    pytorch's `test` package never shadows the standard library's)."""
    if snapshot not in sys.path:
        sys.path.append(snapshot)
    from tools.testing.target_determination.heuristics import (
        edited_by_pr,
        filepath,
        utils,
    )

    return edited_by_pr, filepath, utils


def edited(snapshot: str, changed: list[str], tests: Iterable[str]) -> set[str]:
    """EditedByPR: test files the change edits, plus the run_test.py mappings."""
    ebp, _, utils = pytorch(snapshot)
    out = utils.python_test_file_to_test_name(set(changed))
    for test, regexes in ebp.ADDITIONAL_MAPPINGS.items():
        if any(re.search(r, f) for r in regexes for f in changed):
            out.add(test)
    return out & set(tests)


def filepath_raw(
    snapshot: str, changed: list[str], tests: list[str]
) -> dict[str, float]:
    _, fp, _ = pytorch(snapshot)
    return {
        t: float(v)
        for t, v in fp.get_freq_dict(tests, changed).items()
        if v > 0 and t in tests
    }


def docs_only(snapshot: str, changed: list[str]) -> bool:
    _, _, utils = pytorch(snapshot)
    return bool(utils.is_docs_only_change(changed))


def public_bindings(changed: list[str], tests: Iterable[str]) -> bool:
    return PUBLIC_BINDINGS in set(tests) and any(
        f.startswith("torch/") or f in PUBLIC_BINDINGS_FILES for f in changed
    )


def td_sum(
    snapshot: str,
    changed: list[str],
    tests: list[str],
    fail: Mapping[str, Mapping[str, float]],
    coedit: Mapping[str, Mapping[str, float]],
    profiling: Mapping[str, Mapping[str, float]],
    mentioned: Iterable[str],
    prev_failed: Iterable[str],
) -> dict[str, float]:
    """TD's aggregated score per test, as pytorch's AggregatedHeuristics sums today's
    non-trial heuristics; the LLM heuristic is 0 (its artifact was never uploaded)."""
    total = dict.fromkeys(tests, 0.0)
    tset = set(tests)

    def add(part: Mapping[str, float]) -> None:
        for t, v in part.items():
            if t in total:
                total[t] += v

    add(dict.fromkeys(set(prev_failed) & tset, 1.0))
    add(dict.fromkeys(edited(snapshot, changed, tests), 1.0))
    add(dict.fromkeys(set(mentioned) & tset, 1.0))
    add(normalize(sums(fail, changed, tests)))
    add(normalize(sums(coedit, changed, tests)))
    add(normalize(sums(profiling, changed, tests)))
    if docs_only(snapshot, changed):
        add({t: -1.0 for t in tests})
    else:
        add(normalize(filepath_raw(snapshot, changed, tests), 0.25, 0.125))
    if public_bindings(changed, tests):
        add({PUBLIC_BINDINGS: 1.0})
    return total


def rank(scores: Mapping[str, float]) -> list[str]:
    """TD's order: score descending, then name (TestPrioritizations' traversal)."""
    return sorted(scores, key=lambda t: (-scores[t], t))
