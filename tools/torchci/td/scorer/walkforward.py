"""The training data of every healthy day, and the walk-forward months over it.

`History` holds the training rows (rows.py) and the PR heads (risk.py) of every healthy
day, holdout PRs left out, the PRs that ran each day, and the counted trunk landings. A
model is fitted on the rows and heads of the days before a cut-off day, without the PRs
given, with the configured budget block when there is one: the shipped model on the days
up to two days before the refit (__main__.py), and each walk-forward month on the days
before it without that month's PRs. `assemble` reads the days' shards and the trunk
landings into a History, for refit and the sweep (sweep.py); it builds and writes nothing.

Walk-forward: for each calendar month M that starts at least a month after the first day
of data, through the day before the refit (`folds`, shared with the sweep), the model
fitted on the days before M is scored on M by gate.evaluate_window: the PRs whose first
TD run is in M, at TD's cost per job and at the budget when the model has one, the
counted trunk landings of M, and the risk score's AUC on those PRs' heads. The gate
pools the months (gate.Gate.pooled).

Candidates (`candidates`, report only): History also records the PRs with a run where a
heuristic of train.CANDIDATES ran and did not raise. For each of those months with such
new PRs, two models are fitted on the days before it the same way, one over
train.HEURISTICS and one with train.CANDIDATES added, neither with a budget block, and
both score those PRs and the month's counted trunk landings of those PRs, at TD's cost.
A month whose earlier days have no row where a candidate was active gives it no weight,
so both models agree there. Once the scorer is published, PR failures are only observed
in files the published cut ran, so a candidate that would have run other files gets no
credit from them; the counted trunk landings (tests TD skipped on the PR that then broke
trunk) are not biased that way. The months are taken newest first and none starts after
CANDIDATES_SECONDS, so the report cannot use up the refit job's time.
"""

import logging
import time
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Callable, Iterable, Iterator, Mapping, Optional, Sequence

import numpy as np
from torchci.td.scorer import model_json, risk, train, trunk
from torchci.td.scorer.gate import evaluate_window, WindowReport
from torchci.td.scorer.logs import active, TDLog
from torchci.td.scorer.risk import Head
from torchci.td.scorer.rows import JobTimes, RowBuilder, Rows
from torchci.td.scorer.shards import DayShard
from torchci.td.scorer.trunk import counted_pairs, TrunkLanding


logger = logging.getLogger(__name__)

CANDIDATES_SECONDS = 1800


def next_month(day: date) -> date:
    return date(day.year + day.month // 12, day.month % 12 + 1, 1)


def fold_months(days: Iterable[date]) -> list[date]:
    """The first day of each month of `days` that starts at least a month after the
    first of them."""
    days = sorted(days)
    if not days:
        return []
    earliest = next_month(days[0])
    if days[0].day > 1:
        earliest = next_month(earliest)
    return sorted({d.replace(day=1) for d in days if d >= earliest})


def merge_heads(
    per_day: Iterable[Mapping[str, Head]], exclude_prs: set[int]
) -> list[Head]:
    """One head per sha over the days, positive when it was on any day."""
    out: dict[str, Head] = {}
    for heads in per_day:
        for sha, h in heads.items():
            if h.pr in exclude_prs:
                continue
            seen = out.get(sha)
            out[sha] = Head(
                h.pr, sha, h.files, h.positive or bool(seen and seen.positive)
            )
    return list(out.values())


@dataclass
class Fit:
    model: dict[str, Any]
    rows: int
    positives: int
    trunk_landings: int
    heads: int
    heuristics: list[str]

    def text(self) -> str:
        return (
            f"{self.rows} rows, {self.positives} positives, {self.trunk_landings}"
            f" trunk landings, {self.heads} PR heads, heuristics {self.heuristics}"
        )


class History:
    def __init__(self, times: JobTimes, exclude_prs: set[int]) -> None:
        self.exclude = exclude_prs
        self.times = times
        self.builder: Optional[RowBuilder] = RowBuilder(times)
        self.rows: Optional[Rows] = None
        self.heads: dict[date, dict[str, Head]] = {}
        self.prs: dict[date, set[int]] = {}
        self.candidate_prs: set[int] = set()
        self.landings: list[TrunkLanding] = []
        self.logs: Mapping[str, TDLog] = {}

    def add_shard(self, day: date, shard: DayShard) -> None:
        assert self.builder is not None
        self.prs[day] = {r.pr for r in shard.runs}
        self.candidate_prs.update(
            r.pr
            for r in shard.runs
            if active(r.heuristics, r.raised).intersection(train.CANDIDATES)
        )
        self.builder.add_shard(shard, self.exclude)
        self.heads[day] = {}
        risk.collect_heads(shard, self.heads[day], self.exclude)

    def finish(
        self, landings: Sequence[TrunkLanding], logs: Mapping[str, TDLog]
    ) -> None:
        """Adds the counted trunk landings and builds the rows."""
        assert self.builder is not None
        self.builder.add_trunk(landings, logs, self.exclude)
        self.landings, self.logs = list(landings), logs
        self.rows, self.builder = self.builder.build(), None

    def fit(
        self,
        before: date,
        exclude_prs: set[int],
        version: str,
        budget: Optional[Mapping[str, float]] = None,
        heuristics: Optional[Sequence[str]] = None,
    ) -> Fit:
        """The model fitted on the days before `before`, without `exclude_prs`, carrying
        `budget` as its budget block when given, over train.HEURISTICS or, when given,
        `heuristics`."""
        assert self.rows is not None
        keep = (self.rows.day < before.toordinal()) & ~np.isin(
            self.rows.pr, np.array(sorted(exclude_prs), dtype=np.int64)
        )
        training = self.rows.subset(keep)
        heads = merge_heads(
            (h for d, h in self.heads.items() if d < before), exclude_prs
        )
        landings = [x for x in self.landings if x.day < before.isoformat()]
        excluded = self.exclude | exclude_prs
        risk_block = risk.fit_risk(
            heads, risk.trunk_heads(landings, self.logs, excluded)
        )
        scorer = (
            train.fit_scorer(training)
            if heuristics is None
            else train.fit_scorer(training, heuristics)
        )
        return Fit(
            model=model_json.build_model(
                version,
                scorer,
                risk_block,
                self.times.start_up_table,
                budget=budget,
            ),
            rows=len(training),
            positives=int(training.label.sum()),
            trunk_landings=sum(
                bool(counted_pairs(x, self.logs, excluded)) for x in landings
            ),
            heads=len(heads),
            heuristics=training.heuristics,
        )


def assemble(
    load: Callable[[date], DayShard],
    days: Sequence[date],
    exclude_prs: set[int],
    times: JobTimes,
    stop: date,
) -> History:
    """The History of `days` (oldest first) without `exclude_prs`, with the counted
    trunk landings from the first day to `stop`."""
    history = History(times, exclude_prs)
    for d in days:
        history.add_shard(d, load(d))
    landings = trunk.fetch_landings(
        datetime.combine(days[0], datetime.min.time()),
        datetime.combine(stop, datetime.min.time()),
    )
    head_logs = trunk.fetch_head_logs(p.head_sha for x in landings for p in x.pairs)
    history.finish(landings, head_logs)
    return history


@dataclass
class FoldSpec:
    """One walk-forward month: its days, the days before it, the PRs that ran in it, the
    PRs whose first TD run is in it, and its counted trunk landings."""

    month: date
    days: list[date]
    before: list[date]
    prs: set[int]
    new_prs: set[int]
    landings: list[TrunkLanding]


def folds(history: History) -> Iterator[FoldSpec]:
    days = sorted(history.prs)
    for month in fold_months(days):
        end = next_month(month)
        in_month = [d for d in days if month <= d < end]
        before = [d for d in days if d < month]
        prs = set().union(*(history.prs[d] for d in in_month))
        new_prs = prs - set().union(*(history.prs[d] for d in before))
        landings = [
            x for x in history.landings if month.isoformat() <= x.day < end.isoformat()
        ]
        yield FoldSpec(month, in_month, before, prs, new_prs, landings)


@dataclass
class Fold:
    month: str
    train_days: int
    report: WindowReport


def walk_forward(
    history: History,
    load: Callable[[date], DayShard],
    times: JobTimes,
    version: str,
    budget: Optional[Mapping[str, float]] = None,
) -> list[Fold]:
    out = []
    for spec in folds(history):
        fit = history.fit(spec.month, spec.prs, version, budget)
        report = evaluate_window(
            fit.model,
            (load(d) for d in spec.days),
            spec.new_prs,
            spec.landings,
            times,
        )
        out.append(Fold(spec.month.isoformat()[:7], len(spec.before), report))
    return out


def candidates(
    history: History,
    load: Callable[[date], DayShard],
    times: JobTimes,
    version: str,
    seconds: float = CANDIDATES_SECONDS,
) -> tuple[list[Fold], list[Fold]]:
    """Report only: (the folds of the model over train.HEURISTICS, those of the model
    with train.CANDIDATES added), for the months with new PRs where a candidate was
    active, each scored on those PRs and their counted trunk landings of the month. No
    other month is fitted. The months are fitted newest first, and none starts after
    `seconds`: the older ones are then left out, and logged."""
    base: list[Fold] = []
    added: list[Fold] = []
    deadline = time.monotonic() + seconds
    for spec in reversed(list(folds(history))):
        prs = spec.new_prs & history.candidate_prs
        if not prs:
            continue
        if time.monotonic() > deadline:
            logger.warning(
                "candidates: out of time after %d months, %s and earlier left out",
                len(base),
                spec.month.isoformat()[:7],
            )
            break
        landings = [x for x in spec.landings if any(p.pr in prs for p in x.pairs)]
        for out, heuristics in (
            (base, None),
            (added, train.HEURISTICS + train.CANDIDATES),
        ):
            fit = history.fit(spec.month, spec.prs, version, heuristics=heuristics)
            report = evaluate_window(
                fit.model, (load(d) for d in spec.days), prs, landings, times
            )
            out.append(Fold(spec.month.isoformat()[:7], len(spec.before), report))
    return base[::-1], added[::-1]


def _row(name: str, train_days: str, reports: Sequence[WindowReport]) -> dict:
    prs = sum(x.prs_with_events for x in reports)
    scorer = sum(x.pr_recall_sum for x in reports)
    td = sum(x.td_recall_sum for x in reports)
    events = sum(x.pr_events for x in reports)
    r = np.array([v for x in reports for v in x.risk_r], dtype=float)
    label = np.array([v for x in reports for v in x.risk_label], dtype=int)
    return {
        "month": name,
        "train_days": train_days,
        "units": sum(x.units for x in reports),
        "prs_with_events": prs,
        "scorer": round(scorer, 1),
        "td": round(td, 1),
        "ratio": scorer / td if td else float("nan"),
        "events": events,
        "event_recall": (
            sum(x.pr_caught for x in reports) / events if events else float("nan")
        ),
        "trunk_landings": sum(x.trunk_landings for x in reports),
        "trunk_caught": sum(x.trunk_caught for x in reports),
        "heads": len(label),
        "risk_auc": risk.weighted_auc(r, label),
    }


def summary(folds: Sequence[Fold]) -> list[dict[str, Any]]:
    """One row per month, then the total."""
    out = [_row(f.month, str(f.train_days), [f.report]) for f in folds]
    if folds:
        out.append(_row("total", "", [f.report for f in folds]))
    return out


def text(folds: Sequence[Fold]) -> str:
    if not folds:
        return "walk-forward: no month (the first needs a month of training days)"
    lines = [
        "walk-forward: per month, fitted on every healthy day before it",
        "month    train days    units  PRs w/ events  scorer / TD = ratio"
        "   event recall  trunk landings (scorer caught)  risk AUC (heads)",
    ]
    for row in summary(folds):
        lines.append(
            f"{row['month']:<8} {row['train_days']:>10} {row['units']:>8}"
            f"  {row['prs_with_events']:>13}"
            f"  {row['scorer']:>7.1f} / {row['td']:<7.1f} = {row['ratio']:.3f}"
            f"   {row['event_recall']:>12.3f}  {row['trunk_landings']:>14}"
            f" ({row['trunk_caught']})"
            f"{'':>15}{row['risk_auc']:.3f} ({row['heads']})"
        )
    return "\n".join(lines)


def candidates_summary(base: Sequence[Fold], added: Sequence[Fold]) -> dict[str, Any]:
    """`summary` of each side of `candidates`, and how many PRs both scored."""
    return {
        "heuristics": list(train.CANDIDATES),
        "prs": sum(f.report.prs for f in base),
        "scorer": summary(base),
        "with_candidates": summary(added),
    }


def candidates_text(base: Sequence[Fold], added: Sequence[Fold]) -> str:
    table = candidates_summary(base, added)
    names = ", ".join(table["heuristics"])
    if not base:
        return (
            f"candidates (report only): {names}: no walk-forward month has new PRs"
            " where a candidate ran"
        )
    lines = [
        f"candidates (report only): {names}, on the {table['prs']} PRs where a"
        " candidate ran: the scorer without and with the candidates, at TD's cost"
        " (ratios to TD)",
        "month    train days  PRs w/ events       TD   scorer (ratio)"
        "  with candidates (ratio)  events  event recall (with)"
        "  trunk landings (scorer caught, with)",
    ]
    for row, with_ in zip(table["scorer"], table["with_candidates"]):
        lines.append(
            f"{row['month']:<8} {row['train_days']:>10}  {row['prs_with_events']:>13}"
            f"  {row['td']:>7.1f}  {row['scorer']:>7.1f} ({row['ratio']:.3f})"
            f"  {with_['scorer']:>15.1f} ({with_['ratio']:.3f})  {row['events']:>6}"
            f"  {row['event_recall']:>11.3f} ({with_['event_recall']:.3f})"
            f"  {row['trunk_landings']:>14}"
            f" ({row['trunk_caught']}, {with_['trunk_caught']})"
        )
    return "\n".join(lines)
