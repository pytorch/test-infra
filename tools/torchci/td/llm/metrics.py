"""Standalone ranking metrics, paired bootstrap and exact McNemar for the harness."""

import math
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Collection, Hashable, Iterable, Mapping, Optional, TypeVar

import numpy as np
from torchci.td.llm.scoring import TD_CUT_FRACTION


RECALL_CUT = TD_CUT_FRACTION
SELECTION_LAST_DAY = "2026-09-30"
CONFIRMATION_FIRST_DAY = "2026-10-01"
GEMMA2_RELEASE_DAY = "2026-09-14"
SLICES = ("selection", "confirmation", "post_gemma2")
BOOTSTRAP_ITERS = 10000
CONFIDENCE = 0.95
BOOTSTRAP_BLOCK = 1000

K = TypeVar("K", bound=Hashable)


def rank_pcts(
    scores: Mapping[str, float], targets: Iterable[str], candidates: Collection[str]
) -> list[float]:
    """Per target: the share of candidates scored strictly higher plus half the ties.

    A target without a finite score, or outside the candidates, ranks last.
    """
    names = list(candidates)
    if not names:
        raise ValueError("no candidates to rank against")
    members = set(names)
    values = np.array([scores.get(c, -np.inf) for c in names], dtype=np.float64)
    out = []
    for target in targets:
        score = scores.get(target)
        if score is None or target not in members or not math.isfinite(score):
            out.append(len(members - {target}) / len(names))
            continue
        higher = int(np.count_nonzero(values > score))
        ties = int(np.count_nonzero(values == score)) - 1
        out.append((higher + 0.5 * ties) / len(names))
    return out


def rank_pct(
    scores: Mapping[str, float], target: str, candidates: Collection[str]
) -> float:
    return rank_pcts(scores, [target], candidates)[0]


def best_rank_pct(
    scores: Mapping[str, float], targets: Collection[str], candidates: Collection[str]
) -> Optional[float]:
    return min(rank_pcts(scores, targets, candidates)) if targets else None


def caught(pct: float, cut: float = RECALL_CUT) -> bool:
    return pct < cut


def group_mean(pairs: Iterable[tuple[K, float]]) -> dict[K, float]:
    groups: dict[K, list[float]] = defaultdict(list)
    for key, value in pairs:
        groups[key].append(value)
    return {key: sum(v) / len(v) for key, v in groups.items()}


def per_pr_recall(
    pcts: Mapping[tuple[int, str], float], cut: float = RECALL_CUT
) -> dict[int, float]:
    """Per PR, the share of its failing files ranked inside the cut."""
    return group_mean((pr, float(caught(p, cut))) for (pr, _), p in pcts.items())


def per_pr_rank(pcts: Mapping[tuple[int, str], float]) -> dict[int, float]:
    return group_mean((pr, p) for (pr, _), p in pcts.items())


def macro(values: Mapping[K, float]) -> float:
    return sum(values.values()) / len(values) if values else math.nan


@dataclass(frozen=True)
class Interval:
    diff: float
    lo: float
    hi: float
    n: int

    @property
    def width(self) -> float:
        return self.hi - self.lo


def paired_bootstrap(
    a: Mapping[K, float],
    b: Mapping[K, float],
    iters: int = BOOTSTRAP_ITERS,
    seed: int = 0,
) -> Interval:
    """Mean of a - b over the shared keys, with a percentile interval from resampling keys."""
    keys = sorted(set(a) & set(b), key=repr)
    if not keys:
        return Interval(math.nan, math.nan, math.nan, 0)
    d = np.array([a[k] - b[k] for k in keys], dtype=np.float64)
    rng = np.random.default_rng(seed)
    means = np.empty(iters, dtype=np.float64)
    for start in range(0, iters, BOOTSTRAP_BLOCK):
        size = min(BOOTSTRAP_BLOCK, iters - start)
        idx = rng.integers(0, len(d), size=(size, len(d)))
        means[start : start + size] = d[idx].mean(axis=1)
    tail = (1 - CONFIDENCE) / 2
    lo, hi = np.quantile(means, [tail, 1 - tail])
    return Interval(float(d.mean()), float(lo), float(hi), len(keys))


def mcnemar_exact(gained: int, lost: int) -> float:
    """Two-sided exact McNemar p-value from the discordant pair counts."""
    n = gained + lost
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, k) for k in range(min(gained, lost) + 1)) / 2**n
    return min(1.0, 2 * tail)


def in_slice(day: str, name: str) -> bool:
    if name == "selection":
        return day <= SELECTION_LAST_DAY
    if name == "confirmation":
        return day >= CONFIRMATION_FIRST_DAY
    if name == "post_gemma2":
        return day > GEMMA2_RELEASE_DAY
    raise ValueError(f"unknown slice {name}")


def slice_events(
    events: Mapping[str, Mapping[str, Mapping[str, Any]]], name: str
) -> tuple[dict[str, Mapping[str, Any]], dict[str, Mapping[str, Any]]]:
    """The E1 and E2 event metadata (`date`, ...) of a slice, by event key."""
    e1, e2 = (
        {k: v for k, v in events[kind].items() if in_slice(v["date"], name)}
        for kind in ("e1", "e2")
    )
    return e1, e2


@dataclass(frozen=True)
class Standalone:
    e1: dict[str, bool]
    e1_single: dict[str, bool]
    primary: dict[int, float]
    e2_recall: dict[int, float]
    e2_rank: dict[int, float]

    def row(self) -> dict[str, Any]:
        return {
            "e1_caught": sum(self.e1.values()),
            "e1_events": len(self.e1),
            "e1_single_caught": sum(self.e1_single.values()),
            "e1_single_events": len(self.e1_single),
            "e2_prs": len(self.e2_recall),
            "e2_recall": macro(self.e2_recall),
            "e2_rank": macro(self.e2_rank),
            "primary_prs": len(self.primary),
            "primary": macro(self.primary),
        }


def standalone_for(
    result: Mapping[str, Mapping[str, float]],
    events: Mapping[str, Mapping[str, Mapping[str, Any]]],
    name: str,
) -> Standalone:
    """One configuration's stored percentiles (E1: best per landing; E2: per
    `<pr>:<file>`), sliced; the primary metric is per-PR recall on the files the PR's
    diff does not edit."""
    e1_meta, e2_meta = slice_events(events, name)
    e1 = {k: caught(p) for k, p in result["e1"].items() if k in e1_meta}
    e2 = {(e2_meta[k]["pr"], k): p for k, p in result["e2"].items() if k in e2_meta}
    not_edited = {k: p for k, p in e2.items() if not e2_meta[k[1]]["edited"]}
    return Standalone(
        e1=e1,
        e1_single={k: v for k, v in e1.items() if e1_meta[k]["stack_size"] == 1},
        primary=per_pr_recall(not_edited),
        e2_recall=per_pr_recall(e2),
        e2_rank=per_pr_rank(e2),
    )
