"""The policies every unit is evaluated under, and recall over failure events.

Policies: TD's cut at k% of a unit's tests by each ranking (`before@k`, `after@k`); a cut
at T% of test time by the ensemble's expected failures per second (`time@T`); a reference
with no model that runs the cheapest test files first up to T% of test time (`cheap@T`);
the project's After as planned, the risk-driven cutoff by share of tests with
exploration, at a mean of 20% and 25% (`adaptive@20`, `adaptive@25`); that system with a
test-time budget, at the test time TD spends today at 25% and at 20%
(`adaptive_time@td25`, `adaptive_time@td20`); and cheapest-first at those budgets
(`cheap_time@td25`, `cheap_time@td20`).
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
    [f"before@{k}" for k in config.CUTOFFS] + [f"after@{k}" for k in config.CUTOFFS] + [f"time@{k}" for k in config.CUTOFFS]
    + [f"cheap@{k}" for k in config.CUTOFFS] + [f"adaptive@{t}" for t in config.BUDGET_TARGETS] + [f"adaptive_time@{n}" for n in TIME_TARGETS]
    + [f"cheap_time@{n}" for n in TIME_TARGETS]
)
NAMES = {
    "before": "TD today, {k}% of test files", "after": "Ensemble ranking, {k}% of test files",
    "time": "Ensemble per second, {k}% of test time", "cheap": "Cheapest files first, {k}% of test time",
    "adaptive": "After as planned: risk-driven cutoff, mean {k}% of files",
    "adaptive_time": "After with a time budget: {k}", "cheap_time": "Cheapest files first, no model: {k}",
}
TIME_TARGET_NAMES = {"td25": "TD's test time today", "td20": "the test time of TD at 20%"}


def name(policy: str) -> str:
    kind, k = policy.split("@")
    return NAMES[kind].format(k=TIME_TARGET_NAMES.get(k, k))


def rate(caught: int, n: int) -> dict[str, Any]:
    lo, hi = wilson(caught / n, n) if n else (0.0, 0.0)
    return {"caught": caught, "n": n, "rate": caught / n if n else None, "lo": lo, "hi": hi}


def unit_seconds(tests: list[str], raw: dict[str, float]) -> dict[str, float]:
    """Each test's cost in seconds: its test time (a test without one takes the unit's
    median known time) plus the per-file overhead."""
    known = [s for s in raw.values() if s > 0]
    fill = median(known) if known else 1.0
    return {t: max(raw.get(t, 0.0) or fill, MIN_SECONDS) + config.FILE_OVERHEAD_SECONDS for t in tests}


class Unit:
    """One unit's tests, its two score maps and its selection under every policy."""

    def __init__(self, uid: str, tests: list[str], before: dict[str, float], after: dict[str, float], seconds: dict[str, float]) -> None:
        self.uid, self.tests, self.before, self.after, self.seconds = uid, tests, before, after, seconds
        self.sel: dict[str, set[str]] = {}
        b_order, a_order = policies.ranked(before, tests), policies.ranked(after, tests)
        self.value_order = policies.by_value(after, tests, seconds)
        cheap_order = sorted(tests, key=lambda t: (seconds[t], t))
        for k in config.CUTOFFS:
            n = policies.cut_size(len(tests), k)
            self.sel[f"before@{k}"], self.sel[f"after@{k}"] = set(b_order[:n]), set(a_order[:n])
            self.sel[f"time@{k}"] = set(policies.time_select(self.value_order, seconds, k / 100))
            self.sel[f"cheap@{k}"] = set(policies.time_select(cheap_order, seconds, k / 100))

    def add_adaptive(self, budget: dict[int, int], time_targets: dict[str, float]) -> None:
        for t in config.BUDGET_TARGETS:
            self.sel[f"adaptive@{t}"] = policies.explore_select(self.after, self.tests, budget[t], config.EXPLORE_SHARE, self.uid)
        base = config.BUDGET_TARGETS[0]
        cheap_order = sorted(self.tests, key=lambda t: (self.seconds[t], t))
        for target, share in time_targets.items():
            self.sel[f"adaptive_time@{target}"] = policies.explore_time(
                self.value_order, self.seconds, self.after, min(1.0, share * budget[base] / base), config.EXPLORE_SHARE, self.uid)
            self.sel[f"cheap_time@{target}"] = set(policies.time_select(cheap_order, self.seconds, share))

    def share(self, policy: str) -> tuple[float, float]:
        """(share of tests, share of test time) the policy runs."""
        s = self.sel[policy]
        return len(s) / len(self.tests), sum(self.seconds[t] for t in s) / sum(self.seconds.values())


def recall(units: dict[str, Unit], events: list[tuple[list[str], dict[str, list[str]]]]) -> dict[str, Any]:
    """events: (unit ids, unit id -> failing files); an event is caught under a policy
    when one of its units selects one of its failing files. Each policy also gets the
    mean shares of tests and test time over the events' units."""
    out = {}
    uids = sorted({u for us, _ in events for u in us if u in units})
    for p in POLICIES:
        hit = [any(set(files.get(u, [])) & units[u].sel[p] for u in us if u in units) for us, files in events]
        shares = np.array([units[u].share(p) for u in uids]) if uids else np.zeros((0, 2))
        out[p] = {**rate(sum(hit), len(hit)), "hits": hit,
                  "test_share": float(shares[:, 0].mean()) if uids else None, "time_share": float(shares[:, 1].mean()) if uids else None}
    return out


def strip(rec: dict[str, Any]) -> dict[str, Any]:
    return {p: {k: v for k, v in r.items() if k != "hits"} for p, r in rec.items()}


def paired(rec: dict[str, Any], a: str, b: str) -> dict[str, Any]:
    gained = sum(1 for x, y in zip(rec[a]["hits"], rec[b]["hits"]) if y and not x)
    lost = sum(1 for x, y in zip(rec[a]["hits"], rec[b]["hits"]) if x and not y)
    return {"from": a, "to": b, "gained": gained, "lost": lost, "p": mcnemar_exact(gained, lost)}
