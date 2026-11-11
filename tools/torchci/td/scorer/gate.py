"""The publish gate: does the new scorer, at TD's own cost, catch what TD catches?

A model publishes when both hold:
- holdout (holdout.py): on the TD-off holdout's PR-specific failures in files no
  must-run heuristic scored, the scorer's cut catches at least as many as TD's own
  include list, job by job at TD's cost;
- floor: pooled over the walk-forward months (walkforward.py), each scored by a model
  fitted only on the days before it, the scorer scores at least FLOOR_RATIO of TD, over
  at least MIN_FLOOR_PRS PRs with failures.
A window's score (evaluate_window) covers the PRs whose first TD run falls in it; each
failure is taken once at its first failing head per (PR, build env, test config, file),
and left out when a must-run heuristic scored the file in that job (both cuts run it).
Each PR with failures weighs 1, and each side scores its recall on the PR's failures:
the scorer's cut's, and TD's recomputed include list's (1 while the jobs ran TD's own
cut, which ran every failing file; less once they ran the scorer's, whose misses are
then never observed, so from then on the floor favours the scorer). Counted trunk
landings are reported only: the scorer catches one when any of its pairs is in its cut
of the job at the PR's last head; TD caught none by construction.

The cut is pytorch's scorer.select_tests: must-run files first, by name, whatever their
cost; the rest fill what is left of T by p / cost, ties by name, costs summed in integer
milliseconds. T is the cost of TD's own include list, recomputed from the TD log as
run_test.py's get_top_per_tests(25) cuts it: the job's files (ran or excluded) by TD's
aggregated score, then name, the first n * 25 // 100 + 1.
"""

from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Mapping, Optional, Sequence

import numpy as np
from torchci.td.scorer.logs import active
from torchci.td.scorer.model_json import p_files
from torchci.td.scorer.risk import (
    change_features,
    collect_heads,
    evaluate,
    Head,
    labelled,
    risk_r,
)
from torchci.td.scorer.rows import JobTimes, unit_labels
from torchci.td.scorer.shards import DayShard, Run, Unit
from torchci.td.scorer.trunk import TrunkLanding


FLOOR_RATIO = 0.60
MIN_FLOOR_PRS = 30
TD_PERCENT = 25
SAMPLE_ROWS = 500
SAMPLE_JOBS = 30
MUST_RUN_HEURISTICS = ("EditedByPR", "PreviouslyFailedInPR")


def cost_ms(cost_seconds: float) -> int:
    return round(cost_seconds * 1000)


def scorer_cut(
    files: Sequence[str],
    p: np.ndarray,
    costs: np.ndarray,
    budget_ms: int,
    must_run: set[str],
) -> set[str]:
    """Must-run files first, then whole files by p / cost (ties by name), each added
    while the total stays <= budget_ms."""
    ms = [cost_ms(c) for c in costs]
    selected = {f for f in files if f in must_run}
    used = sum(m for f, m in zip(files, ms) if f in selected)
    rest = [i for i, f in enumerate(files) if f not in must_run]
    for i in sorted(rest, key=lambda i: (-p[i] / costs[i], files[i])):
        if used + ms[i] <= budget_ms:
            selected.add(files[i])
            used += ms[i]
    return selected


def td_include(files: Sequence[str], aggregated: Mapping[str, float]) -> list[str]:
    order = sorted(files, key=lambda f: (-aggregated.get(f, 0.0), f))
    return order[: TD_PERCENT * len(order) // 100 + 1]


def must_run_files(run: Run) -> set[str]:
    return {
        f
        for name in MUST_RUN_HEURISTICS
        if name not in run.raised
        for f, score in run.scores.get(name, {}).items()
        if score != 0
    }


@dataclass
class HoldoutReport:
    healthy: bool = False
    events: int = 0
    prs: int = 0
    td_caught: int = 0
    scorer_caught: int = 0
    jobs: int = 0
    td_files: int = 0
    scorer_files: int = 0
    must_run_events: int = 0

    @property
    def scorer_ok(self) -> bool:
        return self.healthy and self.events > 0 and self.scorer_caught >= self.td_caught

    def text(self) -> str:
        jobs = max(self.jobs, 1)
        return (
            f"holdout: {self.events} events in {self.prs} PRs ({self.jobs} jobs),"
            f" TD caught {self.td_caught}, scorer caught {self.scorer_caught};"
            f" mean files per job TD {self.td_files / jobs:.1f}, scorer"
            f" {self.scorer_files / jobs:.1f}; {self.must_run_events} must-run events"
            " left out" + ("" if self.healthy else " (holdout set unsound)")
        )


@dataclass
class WindowReport:
    """The scorer against TD on one window of days (a walk-forward month)."""

    days: list[str]
    prs: int = 0
    units: int = 0
    jobs_evaluated: int = 0
    prs_with_events: int = 0
    pr_recall_sum: float = 0.0
    td_recall_sum: float = 0.0
    pr_events: int = 0
    pr_caught: int = 0
    td_include_caught: int = 0
    must_run_events: int = 0
    trunk_landings: int = 0
    trunk_caught: int = 0
    trunk_pairs_without_job: int = 0
    risk: dict[str, float] = field(default_factory=dict)
    risk_r: list[float] = field(default_factory=list)
    risk_label: list[int] = field(default_factory=list)


@dataclass
class Gate:
    """The publish rule: the holdout check, and the floor over the pooled walk-forward
    months."""

    holdout: HoldoutReport
    prs_with_events: int = 0
    scorer_score: float = 0.0
    td_score: float = 0.0
    floor_ratio: float = FLOOR_RATIO

    @classmethod
    def pooled(
        cls,
        holdout: HoldoutReport,
        windows: Sequence[WindowReport],
        floor_ratio: float = FLOOR_RATIO,
    ) -> "Gate":
        return cls(
            holdout,
            sum(w.prs_with_events for w in windows),
            sum(w.pr_recall_sum for w in windows),
            sum(w.td_recall_sum for w in windows),
            floor_ratio,
        )

    @property
    def floor_ok(self) -> bool:
        return (
            self.prs_with_events >= MIN_FLOOR_PRS
            and self.scorer_score >= self.floor_ratio * self.td_score
        )

    @property
    def passed(self) -> bool:
        return self.holdout.scorer_ok and self.floor_ok

    def text(self) -> str:
        ratio = self.scorer_score / self.td_score if self.td_score else float("nan")
        return "\n".join(
            [
                f"floor (pooled walk-forward): scorer {self.scorer_score:.1f}, TD"
                f" {self.td_score:.1f} = {ratio:.3f} over {self.prs_with_events} PRs"
                f" with events (needs >= {self.floor_ratio} x TD over >="
                f" {MIN_FLOOR_PRS} PRs with events): {'ok' if self.floor_ok else 'FAIL'}",
                self.holdout.text() + " (needs scorer >= TD):"
                f" {'ok' if self.holdout.scorer_ok else 'FAIL'}",
                f"result: {'PASS' if self.passed else 'FAIL'}",
            ]
        )

    def summary(self) -> dict[str, Any]:
        return {
            **asdict(self),
            "floor_ok": self.floor_ok,
            "holdout_ok": self.holdout.scorer_ok,
            "passed": self.passed,
        }


@dataclass
class Sample:
    """Rows check-pytorch replays: p per file, r per head, and whole cuts."""

    p: list[dict[str, Any]] = field(default_factory=list)
    r: list[dict[str, Any]] = field(default_factory=list)
    jobs: list[dict[str, Any]] = field(default_factory=list)

    @property
    def full(self) -> bool:
        return len(self.p) >= SAMPLE_ROWS and len(self.jobs) >= SAMPLE_JOBS


class Evaluator:
    def __init__(self, model: Mapping[str, Any], times: JobTimes) -> None:
        self.model, self.times = model, times
        self.heuristics = set(model["scorer"]["heuristics"])

    def cut(
        self, run: Run, unit: Unit, sample: Optional[Sample] = None
    ) -> tuple[set[str], set[str]]:
        """(the scorer's selection, TD's include list) for the job."""
        files = sorted(set(unit.ran) | set(unit.excluded))
        env, config = unit.build_env, unit.test_config
        costs = np.array([self.times.cost(env, config, f) for f in files])
        include = set(td_include(files, run.aggregated))
        budget = sum(cost_ms(c) for f, c in zip(files, costs) if f in include)
        raised = self.heuristics - active(run.heuristics, run.raised)
        p = p_files(self.model, run.scores, raised, env, config, files, costs)
        if sample is not None and len(sample.p) < SAMPLE_ROWS:
            sample.p.extend(
                {
                    "scores": {h: v[f] for h, v in run.scores.items() if f in v},
                    "raised": sorted(raised),
                    "cost": float(c),
                    "build_env": env,
                    "test_config": config,
                    "p": float(pi),
                }
                for f, c, pi in list(zip(files, costs, p))[:: max(1, len(files) // 5)]
            )
        selected = scorer_cut(files, p, costs, budget, must_run_files(run))
        if sample is not None and len(sample.jobs) < SAMPLE_JOBS:
            sample.jobs.append(
                {
                    "heuristics": run.scores,
                    "raised": sorted(raised | set(run.raised)),
                    "include": sorted(include),
                    "exclude": sorted(set(files) - include),
                    "times": dict(self.times.entry(env, config)[0]),
                    "build_env": env,
                    "test_config": config,
                    "selected": sorted(selected),
                }
            )
        return selected, include


def evaluate_window(
    model: Mapping[str, Any],
    shards: Iterable[DayShard],
    prs: set[int],
    landings: Sequence[TrunkLanding],
    times: JobTimes,
) -> WindowReport:
    """Scores the model over the window's shards (oldest first) for the PRs in `prs`."""
    ev = Evaluator(model, times)
    report = WindowReport(days=[], prs=len(prs), trunk_landings=len(landings))
    wanted = {
        (p.head_sha, p.build_env, p.test_config) for x in landings for p in x.pairs
    }
    trunk_cuts: dict[tuple[str, str, str], set[str]] = {}
    seen: set[tuple[int, str, str, str]] = set()
    per_pr: dict[int, list[int]] = {}
    heads: dict[str, Head] = {}
    for shard in shards:
        report.days.append(shard.day)
        report.units += len(shard.units)
        collect_heads(shard, heads, exclude_prs=set())
        runs = {r.run_id: r for r in shard.runs}
        units = sorted(shard.units, key=lambda u: (runs[u.run_id].created_at, u.run_id))
        for unit in units:
            run = runs[unit.run_id]
            key = (run.head_sha, unit.build_env, unit.test_config)
            must_run = must_run_files(run)
            new = []
            for f in unit_labels(unit)[0] if run.pr in prs else []:
                event = (run.pr, unit.build_env, unit.test_config, f)
                if event in seen:
                    continue
                seen.add(event)
                if f in must_run:
                    report.must_run_events += 1
                else:
                    new.append(f)
            if not new and key not in wanted:
                continue
            selected, include = ev.cut(run, unit)
            report.jobs_evaluated += 1
            caught = sum(f in selected for f in new)
            report.pr_events += len(new)
            td_caught = sum(f in include for f in new)
            report.pr_caught += caught
            report.td_include_caught += td_caught
            if new:
                counts = per_pr.setdefault(run.pr, [0, 0, 0])
                counts[0] += len(new)
                counts[1] += caught
                counts[2] += td_caught
            if key in wanted:
                trunk_cuts[key] = selected
    report.prs_with_events = len(per_pr)
    report.pr_recall_sum = sum(c / n for n, c, _ in per_pr.values())
    report.td_recall_sum = sum(t / n for n, _, t in per_pr.values())
    for landing in landings:
        caught = False
        for p in landing.pairs:
            pair_cut = trunk_cuts.get((p.head_sha, p.build_env, p.test_config))
            if pair_cut is None:
                report.trunk_pairs_without_job += 1
            caught = caught or (pair_cut is not None and p.test_file in pair_cut)
        report.trunk_caught += caught
    gate_heads = [h for h in heads.values() if h.pr in prs]
    trunk_shas = {p.head_sha for x in landings for p in x.pairs}
    r, label = labelled(model, gate_heads, trunk_shas)
    report.risk = evaluate(r, label)
    report.risk_r, report.risk_label = r.tolist(), label.tolist()
    return report


def sample_model(
    model: Mapping[str, Any], shards: Iterable[DayShard], times: JobTimes
) -> Sample:
    """Sample rows of the model on the shards' jobs and PR heads, until full."""
    ev, sample = Evaluator(model, times), Sample()
    heads: dict[str, Head] = {}
    for shard in shards:
        collect_heads(shard, heads, exclude_prs=set())
        runs = {r.run_id: r for r in shard.runs}
        for unit in shard.units:
            if sample.full:
                break
            ev.cut(runs[unit.run_id], unit, sample)
        if sample.full and len(heads) >= SAMPLE_ROWS:
            break
    for h in list(heads.values())[:SAMPLE_ROWS]:
        features = change_features(h.files)
        sample.r.append({"features": features, "r": risk_r(model, features)})
    return sample
