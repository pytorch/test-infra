"""The publish gate: does the new scorer, at TD's own cost, catch what TD catches; and,
when the model carries a budget block, does its budgeted cut keep what TD catches?

A model publishes when the floor holds: pooled over the walk-forward months
(walkforward.py), each scored by a model fitted only on the days before it, the scorer
scores at least FLOOR_RATIO of TD, over at least MIN_FLOOR_PRS PRs with failures.
The holdout (holdout.py) is reported only: on the TD-off holdout's PR-specific failures
in files no must-run heuristic scored, how many the scorer's cut and TD's own include
list catch, job by job at TD's cost. A fixed 2026 window drifts away from what pytorch
tests, so it cannot decide a later model's fate.
A window's score (evaluate_window) covers the PRs whose first TD run falls in it; each
failure is taken once at its first failing head per (PR, build env, test config, file),
and left out when a must-run heuristic scored the file in that job (the scorer's cut
always runs it). cut.window_jobs yields every job of a window with those failures, for
the gate and the sweep (sweep.py).
Each PR with failures weighs 1, and each side scores its recall on the PR's failures:
the scorer's cut's, and TD's recomputed include list's (1 while the jobs ran TD's own
cut, which ran every failing file; less once they ran the scorer's, whose misses are
then never observed, so from then on the floor favours the scorer). Counted trunk
landings are reported only: the scorer catches one when any of its pairs is in its cut
of the job at the PR's last head; TD caught none by construction.

The budget check (only for a model with a budget block): pooled over the same months,
the per-PR detection retention of the budgeted cut, the share of the PRs with failures
inside TD's include list in jobs the budget applies to (every served job, with a block)
for which the budgeted cut catches at least one of those, must reach RETENTION_FLOOR
over at least MIN_FLOOR_PRS such PRs; the sweep counts the same PRs. It does not decide
`passed`: refit drops the block when it fails. Once the budget is live, PR failures are
only observed in files the budgeted cut ran, so the check then passes by construction.
The report adds the budgeted cut's catches and its realised mean share of the jobs' cost
and of their test-times seconds (ratios of sums over a 1 in cut.SHARE_SAMPLE hash sample
of the served jobs, those whose config has a start-up).

The cuts are cut.py's, as pytorch's scorer.select_tests computes them: a file's cost is
its seconds plus its config's start-up (rows.JobTimes), and a job whose config has no
start-up in the model keeps TD's include list in both cuts.
"""

import logging
import threading
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Iterable, Mapping, Optional, Sequence

from torchci.td.scorer import main_failures
from torchci.td.scorer.cut import Evaluator, Job, share_sampled, window_jobs
from torchci.td.scorer.model_json import valid_budget, without_budget
from torchci.td.scorer.risk import collect_heads, evaluate, Head, labelled
from torchci.td.scorer.rows import JobTimes
from torchci.td.scorer.shards import DayShard, Run, Unit
from torchci.td.scorer.trunk import TrunkLanding


logger = logging.getLogger(__name__)

FLOOR_RATIO = 0.60
MIN_FLOOR_PRS = 30
RETENTION_FLOOR = 0.65
MONITOR_DAYS = 61
MONITOR_SECONDS = 600


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
        return self.events > 0 and self.scorer_caught >= self.td_caught

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
    budget_caught: int = 0
    retention_prs: int = 0
    retention_kept: int = 0
    share_jobs: int = 0
    share_cost_ms: int = 0
    share_total_ms: int = 0
    share_seconds: float = 0.0
    share_total_seconds: float = 0.0


@dataclass
class BudgetCheck:
    """The budgeted cut over the pooled walk-forward months."""

    block: dict[str, float]
    prs: int = 0
    kept: int = 0
    events: int = 0
    caught: int = 0
    share_jobs: int = 0
    cost_share: float = float("nan")
    seconds_share: float = float("nan")
    retention_floor: float = RETENTION_FLOOR

    @classmethod
    def pooled(
        cls, block: Mapping[str, float], windows: Sequence[WindowReport]
    ) -> "BudgetCheck":
        total_ms = sum(w.share_total_ms for w in windows)
        total_s = sum(w.share_total_seconds for w in windows)
        return cls(
            dict(block),
            sum(w.retention_prs for w in windows),
            sum(w.retention_kept for w in windows),
            sum(w.pr_events for w in windows),
            sum(w.budget_caught for w in windows),
            sum(w.share_jobs for w in windows),
            sum(w.share_cost_ms for w in windows) / total_ms
            if total_ms
            else float("nan"),
            sum(w.share_seconds for w in windows) / total_s
            if total_s
            else float("nan"),
            RETENTION_FLOOR,
        )

    @property
    def retention(self) -> float:
        return self.kept / self.prs if self.prs else float("nan")

    @property
    def ok(self) -> bool:
        return self.prs >= MIN_FLOOR_PRS and self.retention >= self.retention_floor

    def text(self) -> str:
        b = self.block
        return (
            f"budget (share {b['share']}, spread {b['spread']}, cost exponent"
            f" {b['cost_exponent']}): per-PR retention of TD's catches {self.kept} /"
            f" {self.prs} = {self.retention:.3f} (needs >= {self.retention_floor} over"
            f" >= {MIN_FLOOR_PRS} PRs): {'ok' if self.ok else 'FAIL'}; budgeted cut"
            f" caught {self.caught} of {self.events} events; realised mean share of"
            f" cost {self.cost_share:.3f}, of test-times seconds {self.seconds_share:.3f}"
            f" ({self.share_jobs} sampled jobs)"
        )


@dataclass
class Gate:
    """The publish rule, the floor over the pooled walk-forward months, the holdout
    report, and the budget check when the model carries a budget block."""

    holdout: HoldoutReport
    prs_with_events: int = 0
    scorer_score: float = 0.0
    td_score: float = 0.0
    floor_ratio: float = FLOOR_RATIO
    budget: Optional[BudgetCheck] = None

    @classmethod
    def pooled(
        cls,
        holdout: HoldoutReport,
        windows: Sequence[WindowReport],
        floor_ratio: float = FLOOR_RATIO,
        budget: Optional[Mapping[str, float]] = None,
    ) -> "Gate":
        return cls(
            holdout,
            sum(w.prs_with_events for w in windows),
            sum(w.pr_recall_sum for w in windows),
            sum(w.td_recall_sum for w in windows),
            floor_ratio,
            None if budget is None else BudgetCheck.pooled(budget, windows),
        )

    @property
    def floor_ok(self) -> bool:
        return (
            self.prs_with_events >= MIN_FLOOR_PRS
            and self.scorer_score >= self.floor_ratio * self.td_score
        )

    @property
    def passed(self) -> bool:
        return self.floor_ok

    @property
    def budget_ok(self) -> bool:
        return self.budget is not None and self.budget.ok

    def text(self) -> str:
        ratio = self.scorer_score / self.td_score if self.td_score else float("nan")
        return "\n".join(
            [
                f"floor (pooled walk-forward): scorer {self.scorer_score:.1f}, TD"
                f" {self.td_score:.1f} = {ratio:.3f} over {self.prs_with_events} PRs"
                f" with events (needs >= {self.floor_ratio} x TD over >="
                f" {MIN_FLOOR_PRS} PRs with events): {'ok' if self.floor_ok else 'FAIL'}",
                self.holdout.text() + " (report only; scorer >= TD:"
                f" {'yes' if self.holdout.scorer_ok else 'no'})",
                *([] if self.budget is None else [self.budget.text()]),
                f"result: {'PASS' if self.passed else 'FAIL'}",
            ]
        )

    def summary(self) -> dict[str, Any]:
        out = {
            **asdict(self),
            "floor_ok": self.floor_ok,
            "holdout_ok": self.holdout.scorer_ok,
            "passed": self.passed,
        }
        if self.budget is None:
            del out["budget"]
        else:
            out["budget"].update(retention=self.budget.retention, ok=self.budget.ok)
            out["budget_ok"] = self.budget_ok
        return out


def add_share(report: WindowReport, job: Job, selected: set[str]) -> None:
    report.share_jobs += 1
    report.share_cost_ms += job.used_ms(selected)
    report.share_total_ms += job.total_ms
    report.share_seconds += job.seconds(selected)
    report.share_total_seconds += job.seconds(set(job.files))


def evaluate_window(
    model: Mapping[str, Any],
    shards: Iterable[DayShard],
    prs: set[int],
    landings: Sequence[TrunkLanding],
    times: JobTimes,
) -> WindowReport:
    """Scores the model over the window's shards (oldest first) for the PRs in `prs`."""
    ev = Evaluator(model, times)
    budgeted = "budget" in model
    report = WindowReport(days=[], prs=len(prs), trunk_landings=len(landings))
    wanted = {
        (p.head_sha, p.build_env, p.test_config) for x in landings for p in x.pairs
    }
    trunk_cuts: dict[tuple[str, str, str], set[str]] = {}
    per_pr: dict[int, list[int]] = {}
    kept: dict[int, bool] = {}
    heads: dict[str, Head] = {}

    def on_shard(shard: DayShard) -> None:
        report.days.append(shard.day)
        report.units += len(shard.units)
        collect_heads(shard, heads, exclude_prs=set())

    for wj in window_jobs(shards, prs, on_shard):
        run, unit, new = wj.run, wj.unit, wj.new
        report.must_run_events += wj.must_run_events
        key = (run.head_sha, unit.build_env, unit.test_config)
        scored = bool(new) or key in wanted
        sampled = (
            budgeted
            and times.start_up(*key[1:]) is not None
            and share_sampled(run.run_id, *key[1:])
        )
        if not scored and not sampled:
            continue
        job = ev.prepare(run, unit)
        cuts = ev.cuts(job)
        if sampled:
            add_share(report, job, cuts.budgeted)
        if not scored:
            continue
        selected, include = cuts.td_cost, cuts.include
        report.jobs_evaluated += 1
        caught = sum(f in selected for f in new)
        report.pr_events += len(new)
        td_caught = sum(f in include for f in new)
        report.pr_caught += caught
        report.td_include_caught += td_caught
        report.budget_caught += sum(f in cuts.budgeted for f in new)
        if new:
            counts = per_pr.setdefault(run.pr, [0, 0, 0])
            counts[0] += len(new)
            counts[1] += caught
            counts[2] += td_caught
        inside = [f for f in new if f in include]
        if inside and cuts.budget["share"] is not None:
            kept[run.pr] = kept.get(run.pr, False) or any(
                f in cuts.budgeted for f in inside
            )
        if key in wanted:
            trunk_cuts[key] = selected
    report.prs_with_events = len(per_pr)
    report.pr_recall_sum = sum(c / n for n, c, _ in per_pr.values())
    report.td_recall_sum = sum(t / n for n, _, t in per_pr.values())
    report.retention_prs, report.retention_kept = len(kept), sum(kept.values())
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


def settle_budget(model: dict[str, Any], result: Gate) -> dict[str, Any]:
    """The model to write: with its budget block when the budget check passed and
    pytorch's validator accepts the block, else without it (TD's cost)."""
    block = model["budget"]
    valid = valid_budget(block)
    if result.budget_ok and valid:
        print(f"budget mode: on, block kept: {block}")
        return model
    why = "the retention check failed" if valid else "pytorch would reject the block"
    print(f"budget mode: on, block dropped ({why}): the scorer stays at TD's cost")
    return without_budget(model)


def monitor_text(model: dict[str, Any], times: JobTimes, day: date) -> str:
    stop = datetime.combine(day, datetime.min.time())
    start = stop - timedelta(days=MONITOR_DAYS)
    landings, counts = main_failures.fetch_main_landings(start, stop)
    ev = Evaluator(model, times)

    def select(run: Run, unit: Unit) -> list[set[str]]:
        cuts = ev.cuts(ev.prepare(run, unit))
        return [cuts.budgeted, cuts.include]

    caught = main_failures.landings_caught(landings, select)
    failures = sum(n for _, _, n in caught)
    lines = [
        f"{name} caught {sum(c[i] > 0 for _, c, _ in caught)} landings,"
        f" {sum(c[i] for _, c, _ in caught)} of {failures} failures"
        for i, name in enumerate(("budgeted cut", "TD's 25% cut"))
    ]
    return (
        f"main-failure monitor (report only, {start:%Y-%m-%d}..{day}):"
        f" {len(landings)} landings; {'; '.join(lines)}; counts {counts}"
    )


def monitor(
    model: dict[str, Any], times: JobTimes, day: date, seconds: float = MONITOR_SECONDS
) -> None:
    """Report only: prints the last MONITOR_DAYS' main landings with new, confirmed
    failures, caught by `model`'s budgeted cut and by TD's 25% cut; "unavailable" on any
    error or after `seconds`. Never raises. `seconds` bounds the wait only: fetches already
    queued in the thread's pool still finish before the interpreter exits."""
    out: list[str] = []

    def work() -> None:
        try:
            out.append(monitor_text(model, times, day))
        except Exception as e:
            logger.error("main-failure monitor failed: %s", e, exc_info=True)
            out.append(f"main-failure monitor: unavailable ({type(e).__name__}: {e})")

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    thread.join(seconds)
    print(out[0] if out else "main-failure monitor: unavailable: timeout")
