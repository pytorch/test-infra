"""Which tests a unit runs: TD's cut at k percent of its tests, a cut at a share of their
test time by expected failures per second, and the exploration slice
(a small share of the budget drawn below the cut, to collect labels)."""

import hashlib
from typing import Mapping, Sequence

import numpy as np


def cut_size(n: int, k: int) -> int:
    """How many tests TD keeps at k percent: get_top_per_tests keeps index < k*n//100 + 1."""
    return min(n, k * n // 100 + 1) if k < 100 else n


def ranked(scores: Mapping[str, float], tests: Sequence[str]) -> list[str]:
    """Tests by score descending, ties by name (TestPrioritizations' order); a test with
    no score counts 0."""
    return sorted(tests, key=lambda t: (-scores.get(t, 0.0), t))


def top_k(scores: Mapping[str, float], tests: Sequence[str], k: int) -> set[str]:
    return set(ranked(scores, tests)[: cut_size(len(tests), k)])


def by_value(
    scores: Mapping[str, float], tests: Sequence[str], seconds: Mapping[str, float]
) -> list[str]:
    """Tests by expected failures caught per second of test time, ties by name."""
    return sorted(tests, key=lambda t: (-scores.get(t, 0.0) / seconds[t], t))


def cheapest(tests: Sequence[str], seconds: Mapping[str, float]) -> list[str]:
    """Tests by test time, cheapest first, ties by name."""
    return sorted(tests, key=lambda t: (seconds[t], t))


def time_select(
    order: Sequence[str], seconds: Mapping[str, float], share: float
) -> list[str]:
    """The prefix of `order` that first reaches `share` of the tests' total time."""
    budget, used, out = share * sum(seconds[t] for t in order), 0.0, []
    for t in order:
        if used >= budget:
            break
        out.append(t)
        used += seconds[t]
    return out


def seed_of(unit_id: str) -> int:
    """A seed every shard of a unit derives alike (from its id, hence its commit)."""
    return int.from_bytes(hashlib.sha256(unit_id.encode()).digest()[:8], "little")


def explore_swap(
    selected: list[str],
    order: Sequence[str],
    scores: Mapping[str, float],
    share: float,
    unit_id: str,
) -> set[str]:
    """The exploration slice on a selection: its last `share` (by order) swapped for as many
    tests drawn from the unselected ones, with probability proportional to their score,
    seeded by the unit, so every shard draws the same tests."""
    n_explore = int(round(share * len(selected)))
    chosen = set(selected)
    rest = [t for t in order if t not in chosen]
    if not n_explore or not rest:
        return chosen
    w = np.array([max(scores.get(t, 0.0), 0.0) for t in rest], dtype=float) + 1e-12
    rng = np.random.default_rng(seed_of(unit_id))
    picked = rng.choice(
        len(rest), size=min(n_explore, len(rest)), replace=False, p=w / w.sum()
    )
    return set(selected[: len(selected) - n_explore]) | {rest[i] for i in picked}


def explore_time(
    order: Sequence[str],
    seconds: Mapping[str, float],
    scores: Mapping[str, float],
    share: float,
    explore: float,
    unit_id: str,
) -> set[str]:
    """A time budget of `share` of the tests' time: its first (1 - explore) spent down
    `order`, the rest on tests drawn from those left, with probability proportional to
    their score, seeded by the unit; a drawn test that would overrun the budget is skipped."""
    total = sum(seconds[t] for t in order)
    head = time_select(order, seconds, share * (1 - explore))
    chosen, left = set(head), share * total - sum(seconds[t] for t in head)
    rest = [t for t in order if t not in chosen]
    if left <= 0 or not rest:
        return chosen
    w = np.array([max(scores.get(t, 0.0), 0.0) for t in rest], dtype=float) + 1e-12
    rng = np.random.default_rng(seed_of(unit_id))
    for i in rng.choice(len(rest), size=len(rest), replace=False, p=w / w.sum()):
        if seconds[rest[i]] <= left:
            chosen.add(rest[i])
            left -= seconds[rest[i]]
    return chosen


def explore_select(
    scores: Mapping[str, float],
    tests: Sequence[str],
    k: int,
    share: float,
    unit_id: str,
) -> set[str]:
    """k percent of the tests by score, with the exploration slice drawn below the cut."""
    order = ranked(scores, tests)
    return explore_swap(order[: cut_size(len(order), k)], order, scores, share, unit_id)
