"""The policies every unit is evaluated under, and recall over failure events.

Policies: TD's cut at k% of a unit's tests (`before@k`); and the After system, which
ranks by the ensemble's expected failures per second and stops at a test-time budget the
risk model scales per change, with exploration: at T% of test time on average
(`adaptive_time@T`), and at the test time TD spends on the same unit at 25% and at 20%
(`adaptive_time@td25`, `adaptive_time@td20`).
"""

from statistics import median
from typing import Any

import numpy as np
from torchci.greenlight_replay.compare_stats import wilson
from torchci.td.analysis import config, policies
from torchci.td.llm.metrics import mcnemar_exact


MIN_SECONDS = 0.1
TIME_TARGETS = {"td25": 25, "td20": 20}
POLICIES = (
    [f"before@{k}" for k in config.CUTOFFS]
    + [f"adaptive_time@{k}" for k in config.CUTOFFS]
    + [f"adaptive_time@{n}" for n in TIME_TARGETS]
)
AFTER_NAME = "After with a time budget"
NAMES = {
    "before": "TD, {k}% of test files",
    "adaptive_time": AFTER_NAME + ", {k}",
}
TIME_TARGET_NAMES = {
    "td25": "TD's test time today",
    "td20": "the test time of TD at 20%",
}


def name(policy: str) -> str:
    kind, k = policy.split("@")
    if kind == "adaptive_time" and k not in TIME_TARGET_NAMES:
        return NAMES[kind].format(k=f"{k}% of test time, scaled per change")
    return NAMES[kind].format(k=TIME_TARGET_NAMES.get(k, k))


def rate(caught: int, n: int) -> dict[str, Any]:
    lo, hi = wilson(caught / n, n) if n else (0.0, 0.0)
    return {
        "caught": caught,
        "n": n,
        "rate": caught / n if n else None,
        "lo": lo,
        "hi": hi,
    }


def unit_seconds(tests: list[str], raw: dict[str, float]) -> dict[str, float]:
    """Each test's cost in seconds: its test time (a test without one takes the unit's
    median known time) plus the per-file overhead."""
    known = [s for s in raw.values() if s > 0]
    fill = median(known) if known else 1.0
    return {
        t: max(raw.get(t, 0.0) or fill, MIN_SECONDS) + config.FILE_OVERHEAD_SECONDS
        for t in tests
    }


def time_budget(
    order: list[str],
    seconds: dict[str, float],
    scores: dict[str, float],
    share: float,
    scale: float,
    uid: str,
) -> set[str]:
    """The After system's selection: `share` of the tests' time times the unit's risk
    multiplier `scale` (at most all of it), spent down `order` with exploration."""
    return policies.explore_time(
        order, seconds, scores, min(1.0, share * scale), config.EXPLORE_SHARE, uid
    )


class Unit:
    """One unit's tests, its two score maps and its selection under every policy."""

    def __init__(
        self,
        uid: str,
        tests: list[str],
        before: dict[str, float],
        after: dict[str, float],
        seconds: dict[str, float],
    ) -> None:
        self.uid, self.tests, self.before, self.after, self.seconds = (
            uid,
            tests,
            before,
            after,
            seconds,
        )
        self.sel: dict[str, set[str]] = {}
        self.scale = 1.0
        b_order = policies.ranked(before, tests)
        self.value_order = policies.by_value(after, tests, seconds)
        for k in config.CUTOFFS:
            self.sel[f"before@{k}"] = set(b_order[: policies.cut_size(len(tests), k)])

    def add_adaptive(self, scale: float) -> None:
        """The After system, given the unit's risk multiplier `scale` (its risk cutoff over
        its population's mean cutoff): a test-time budget of T% times `scale`, and of the
        time TD spends on this unit at 25% (and 20%) of its files times `scale`, each
        spent down the per-second ranking with exploration."""
        self.scale = scale
        for k in config.CUTOFFS:
            self.sel[f"adaptive_time@{k}"] = self.explore(k / 100)
        for target, k in TIME_TARGETS.items():
            self.sel[f"adaptive_time@{target}"] = self.explore(
                self.share(f"before@{k}")[1]
            )

    def explore(self, share: float) -> set[str]:
        return time_budget(
            self.value_order, self.seconds, self.after, share, self.scale, self.uid
        )

    def share(self, policy: str) -> tuple[float, float]:
        """(share of tests, share of test time) the policy runs."""
        s = self.sel[policy]
        return len(s) / len(self.tests), sum(self.seconds[t] for t in s) / sum(
            self.seconds.values()
        )


def recall(
    units: dict[str, Unit], events: list[tuple[list[str], dict[str, list[str]]]]
) -> dict[str, Any]:
    """events: (unit ids, unit id -> failing files); an event is caught under a policy
    when one of its units selects one of its failing files. Each policy also gets the
    mean shares of tests and test time over the events' units."""
    out = {}
    uids = sorted({u for us, _ in events for u in us if u in units})
    for p in POLICIES:
        hit = [
            any(set(files.get(u, [])) & units[u].sel[p] for u in us if u in units)
            for us, files in events
        ]
        shares = (
            np.array([units[u].share(p) for u in uids]) if uids else np.zeros((0, 2))
        )
        out[p] = {
            **rate(sum(hit), len(hit)),
            "hits": hit,
            "test_share": float(shares[:, 0].mean()) if uids else None,
            "time_share": float(shares[:, 1].mean()) if uids else None,
        }
    return out


def strip(rec: dict[str, Any]) -> dict[str, Any]:
    return {p: {k: v for k, v in r.items() if k != "hits"} for p, r in rec.items()}


def paired(rec: dict[str, Any], a: str, b: str) -> dict[str, Any]:
    gained = sum(1 for x, y in zip(rec[a]["hits"], rec[b]["hits"]) if y and not x)
    lost = sum(1 for x, y in zip(rec[a]["hits"], rec[b]["hits"]) if x and not y)
    return {
        "from": a,
        "to": b,
        "gained": gained,
        "lost": lost,
        "p": mcnemar_exact(gained, lost),
    }
