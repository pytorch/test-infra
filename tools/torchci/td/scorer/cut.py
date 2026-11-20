"""The scorer's cut of one job, as pytorch's scorer.select_tests computes it.

Must-run files (a non-zero EditedByPR or PreviouslyFailedInPR score from a heuristic
that did not raise) come first, by name, whatever their cost. The rest are ranked by
p / cost ** a, ties by name, and fill what is left of the budget greedily as whole
files, skipping those that do not fit, with costs summed in integer milliseconds. With
a share, the first-ranked file is taken even when it does not fit, so no file is too
big ever to run; without one, it is taken when nothing at all is selected.

Without a share from model_json.budget_share, a is 1 and the budget is the cost of TD's
own include list, recomputed from the TD log as run_test.py's get_top_per_tests(25) cuts
it: the job's files (ran or excluded) by TD's aggregated score, then name, the first
n * 25 // 100 + 1. With a share (every served job, when the model has a budget block),
a is the block's cost_exponent and the budget is the share of the cost of all the job's
files. A file's cost is its seconds plus its config's start-up (rows.JobTimes); a job
whose config has no start-up in the model is not served: it keeps TD's include list in
both cuts, as pytorch's select_tests raises NoModel there.

job_budget is the budget rule; Evaluator.prepare builds a job's inputs once and
Evaluator.cuts gives both cuts from them. window_jobs yields a window's jobs with their
PR failures at the first failing head, for the gate and the sweep.
"""

import hashlib
import math
from dataclasses import dataclass, field
from typing import (
    Any,
    Callable,
    Iterable,
    Iterator,
    Mapping,
    NamedTuple,
    Optional,
    Sequence,
    Union,
)

import numpy as np
from torchci.td.scorer.logs import active
from torchci.td.scorer.model_json import budget_share, p_files
from torchci.td.scorer.risk import change_features, count_build_files, risk_r
from torchci.td.scorer.rows import JobTimes, unit_labels
from torchci.td.scorer.shards import DayShard, Run, Unit


TD_PERCENT = 25
MUST_RUN_HEURISTICS = ("EditedByPR", "PreviouslyFailedInPR")
SHARE_SAMPLE = 20
NO_START_UP = "no_start_up"

Floats = Union[Sequence[float], np.ndarray]


def cost_ms(cost_seconds: float) -> int:
    return round(cost_seconds * 1000)


def td_include(files: Sequence[str], aggregated: Mapping[str, float]) -> list[str]:
    order = sorted(files, key=lambda f: (-aggregated.get(f, 0.0), f))
    return order[: TD_PERCENT * len(order) // 100 + 1]


def job_files(unit: Unit) -> list[str]:
    """The job's test files, ran or excluded, by name."""
    return sorted(set(unit.ran) | set(unit.excluded))


def must_run_files(run: Run) -> set[str]:
    return {
        f
        for name in MUST_RUN_HEURISTICS
        if name not in run.raised
        for f, score in run.scores.get(name, {}).items()
        if score != 0
    }


class Ranking(NamedTuple):
    must_run: list[str]
    rest: list[str]


def rank(
    files: Sequence[str],
    p: Floats,
    costs: Floats,
    must_run: set[str],
    a: float,
) -> Ranking:
    """Must-run files by name, then the rest by p / cost ** a, ties by name; each key is
    the scalar Python float expression pytorch evaluates."""
    keyed = [
        (-(float(pi) / float(c) ** a), f)
        for f, pi, c in zip(files, p, costs)
        if f not in must_run
    ]
    return Ranking(
        sorted(f for f in files if f in must_run), [f for _, f in sorted(keyed)]
    )


def rank_by(
    files: Sequence[str], score: Mapping[str, float], must_run: set[str]
) -> Ranking:
    """Must-run files by name, then the rest by `score` (highest first), then name."""
    rest = sorted(
        (f for f in files if f not in must_run), key=lambda f: (-score.get(f, 0.0), f)
    )
    return Ranking(sorted(f for f in files if f in must_run), rest)


def fill(
    order: Ranking, costs_ms: Mapping[str, int], budget_ms: int, top: bool = False
) -> set[str]:
    """The cut of the ranking at budget_ms; `top` takes the first-ranked file even when
    it does not fit (a budgeted cut)."""
    selected = set(order.must_run)
    used = sum(costs_ms[f] for f in selected)
    for i, f in enumerate(order.rest):
        if used + costs_ms[f] <= budget_ms or (top and i == 0):
            selected.add(f)
            used += costs_ms[f]
    if not selected and order.rest:
        selected.add(order.rest[0])
    return selected


def scorer_cut(
    files: Sequence[str],
    p: Floats,
    costs: Floats,
    budget_ms: int,
    must_run: set[str],
) -> set[str]:
    return fill(
        rank(files, p, costs, must_run, 1.0),
        {f: cost_ms(c) for f, c in zip(files, costs)},
        budget_ms,
    )


def share_sampled(run_id: int, build_env: str, test_config: str) -> bool:
    """A deterministic 1 in SHARE_SAMPLE of all jobs, for the realised time share."""
    key = f"{run_id}\0{build_env}\0{test_config}".encode()
    return int.from_bytes(hashlib.sha256(key).digest()[:8], "big") % SHARE_SAMPLE == 0


@dataclass
class WindowJob:
    """A job of a window, with its PR's failures first seen there, must-run files left
    out, and how many must-run failures were left out."""

    run: Run
    unit: Unit
    new: list[str]
    must_run_events: int


def window_jobs(
    shards: Iterable[DayShard],
    prs: set[int],
    on_shard: Callable[[DayShard], None] = lambda shard: None,
) -> Iterator[WindowJob]:
    """Every job of the shards (oldest first), with the failures of the PRs in `prs`
    at their first failing head per (PR, build env, test config, file)."""
    seen: set[tuple[int, str, str, str]] = set()
    for shard in shards:
        on_shard(shard)
        runs = {r.run_id: r for r in shard.runs}
        units = sorted(shard.units, key=lambda u: (runs[u.run_id].created_at, u.run_id))
        for unit in units:
            run = runs[unit.run_id]
            must_run = must_run_files(run)
            new, skipped = [], 0
            for f in unit_labels(unit)[0] if run.pr in prs else []:
                event = (run.pr, unit.build_env, unit.test_config, f)
                if event in seen:
                    continue
                seen.add(event)
                if f in must_run:
                    skipped += 1
                else:
                    new.append(f)
            yield WindowJob(run, unit, new, skipped)


@dataclass
class Job:
    """One job's inputs to the cut, built once."""

    run: Run
    unit: Unit
    files: list[str]
    costs: np.ndarray
    ms: dict[str, int]
    sec: dict[str, float]
    include: set[str]
    raised: set[str]
    p: np.ndarray
    must_run: set[str]
    r: Optional[float]
    build_files: Optional[int]
    td_ms: int
    total_ms: int
    served: bool

    def seconds(self, selected: Iterable[str]) -> float:
        return math.fsum(self.sec[f] for f in selected)

    def used_ms(self, selected: Iterable[str]) -> int:
        return sum(self.ms[f] for f in selected)


def job_budget(model: Mapping[str, Any], job: Job) -> dict[str, Any]:
    """The budget rule: share and mode (model_json.budget_share), the cost exponent and
    the budget in ms. Without a share, a = 1 and the cost of TD's include list; a job
    that is not served has neither a share nor an exponent (mode NO_START_UP)."""
    if not job.served:
        return {
            "share": None,
            "mode": NO_START_UP,
            "cost_exponent": None,
            "budget_ms": job.td_ms,
        }
    share, mode = budget_share(model, job.build_files, job.r)
    if share is None:
        return {
            "share": None,
            "mode": mode,
            "cost_exponent": 1.0,
            "budget_ms": job.td_ms,
        }
    return {
        "share": share,
        "mode": mode,
        "cost_exponent": float(model["budget"]["cost_exponent"]),
        "budget_ms": round(share * job.total_ms),
    }


@dataclass
class Cuts:
    td_cost: set[str]
    budgeted: set[str]
    include: set[str]
    budget: dict[str, Any] = field(default_factory=dict)


class Evaluator:
    def __init__(self, model: Mapping[str, Any], times: JobTimes) -> None:
        self.model, self.times = model, times
        self.heuristics = set(model["scorer"]["heuristics"])
        self._change: dict[str, tuple[Optional[float], Optional[int]]] = {}

    def change(self, run: Run) -> tuple[Optional[float], Optional[int]]:
        """(r, build files) of the run's change, None each when its files are unknown;
        cached per head sha, which fixes the changed files."""
        if run.head_sha not in self._change:
            files = run.changed_files
            self._change[run.head_sha] = (
                (None, None)
                if files is None
                else (
                    risk_r(self.model, change_features(files)),
                    count_build_files(files),
                )
            )
        return self._change[run.head_sha]

    def prepare(self, run: Run, unit: Unit) -> Job:
        files = job_files(unit)
        env, config = unit.build_env, unit.test_config
        served = self.times.start_up(env, config) is not None
        costs = np.array([self.times.cost(env, config, f) for f in files])
        ms = {f: cost_ms(c) for f, c in zip(files, costs)}
        sec = {f: self.times.seconds(env, config, f) for f in files}
        include = set(td_include(files, run.aggregated))
        raised = self.heuristics - active(run.heuristics, run.raised)
        p = np.zeros(len(files))
        if served:
            p = p_files(self.model, run.scores, raised, env, config, files, costs)
        r, build_files = self.change(run)
        return Job(
            run,
            unit,
            files,
            costs,
            ms,
            sec,
            include,
            raised,
            p,
            must_run_files(run),
            r,
            build_files,
            sum(ms[f] for f in include),
            sum(ms.values()),
            served,
        )

    def cuts(self, job: Job) -> Cuts:
        budget = job_budget(self.model, job)
        if not job.served:
            return Cuts(set(job.include), set(job.include), job.include, budget)
        td_cost = scorer_cut(job.files, job.p, job.costs, job.td_ms, job.must_run)
        if budget["share"] is None:
            return Cuts(td_cost, td_cost, job.include, budget)
        order = rank(job.files, job.p, job.costs, job.must_run, budget["cost_exponent"])
        return Cuts(
            td_cost, fill(order, job.ms, budget["budget_ms"], True), job.include, budget
        )

    def cut(self, run: Run, unit: Unit) -> tuple[set[str], set[str]]:
        """(the scorer's cut at TD's cost, TD's include list) for the job."""
        cuts = self.cuts(self.prepare(run, unit))
        return cuts.td_cost, cuts.include
