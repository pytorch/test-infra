"""The harness's decision rules, applied in order on the stored per-event results."""

import dataclasses
import math
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

from torchci.td.llm.metrics import (
    BOOTSTRAP_ITERS,
    Interval,
    paired_bootstrap,
    slice_events,
    Standalone,
    standalone_for,
)
from torchci.td.llm.models import MODELS
from torchci.td.llm.pytorch_repo import CORPORA
from torchci.td.llm.replay import ReplaySummary, summaries_for
from torchci.td.llm.scoring import AGGREGATIONS


BASE_MODEL = "qwen3-0.6b"
SIZE_ONLY = "size-only"
CORPUS_NAMES = tuple(CORPORA)
JOB_OVERHEAD_SECONDS = 180.0
BUNDLE_DOWNLOAD_BYTES_PER_SECOND = 500 * 10**6
JOB_MAX_SECONDS = 330.0
# The upload job's ubuntu-24.04 runner has a 14 GB disk for the downloaded bundle.
BUNDLE_MAX_BYTES = 12 * 10**9
BUILD_MAX_MINUTES = 90.0


@dataclass(frozen=True)
class Settings:
    corpus: str
    aggregation: str
    instruction: bool

    def id(self, model: str) -> str:
        return config_id(model, self.corpus, self.aggregation, self.instruction)


def config_id(model: str, corpus: str, aggregation: str, instruction: bool) -> str:
    return f"{model}/{corpus}/{aggregation}/{'inst' if instruction else 'noinst'}"


def registry_order() -> list[str]:
    """Every registry model, smallest committed snapshot (so smallest bundle) first."""
    return sorted(
        MODELS, key=lambda k: (sum(s for _, s in MODELS[k].files.values()), k)
    )


@dataclass(frozen=True)
class Metrics(Standalone):
    replay: dict[str, tuple[ReplaySummary, ReplaySummary]] = field(default_factory=dict)
    replay_single: dict[str, ReplaySummary] = field(default_factory=dict)
    replay_td_off: dict[str, ReplaySummary] = field(default_factory=dict)


def metrics_for(
    result: Mapping[str, Any], events: Mapping[str, Any], slice_name: str
) -> Metrics:
    """One configuration's stored results (written by evaluate.py), sliced."""
    standalone = standalone_for(result, events, slice_name)
    e1_meta, e2_meta = slice_events(events, slice_name)
    stored = result.get("replay", {})
    single = {k for k, v in e1_meta.items() if v["stack_size"] == 1}
    td_off = {k for k, v in e2_meta.items() if not v["td_cut"]}
    return Metrics(
        **vars(standalone),
        replay=summaries_for(stored, set(e1_meta), set(e2_meta)),
        replay_single={
            t: s[0] for t, s in summaries_for(stored, single, set()).items()
        },
        replay_td_off={
            t: s[1] for t, s in summaries_for(stored, set(), td_off).items()
        },
    )


@dataclass(frozen=True)
class Comparison:
    candidate: str
    incumbent: str
    interval: Interval
    e1_candidate: int
    e1_incumbent: int

    @property
    def beats(self) -> bool:
        """Superior on the primary metric and not worse on E1."""
        return self.interval.lo > 0 and self.e1_candidate >= self.e1_incumbent

    def line(self) -> str:
        i = self.interval
        return (
            f"{self.candidate} vs {self.incumbent}: primary {i.diff:+.3f}, 95% CI "
            f"[{i.lo:+.3f}, {i.hi:+.3f}] (width {i.width:.3f}, {i.n} PRs), E1 "
            f"{self.e1_candidate} vs {self.e1_incumbent}"
        )


def compare(cand: str, inc: str, metrics: Mapping[str, Metrics]) -> Comparison:
    a, b = metrics[cand], metrics[inc]
    shared = set(a.e1) & set(b.e1)
    return Comparison(
        candidate=cand,
        incumbent=inc,
        interval=paired_bootstrap(a.primary, b.primary, BOOTSTRAP_ITERS, seed=0),
        e1_candidate=sum(a.e1[k] for k in shared),
        e1_incumbent=sum(b.e1[k] for k in shared),
    )


def mean_diff(a: Mapping[int, float], b: Mapping[int, float]) -> float:
    keys = set(a) & set(b)
    return sum(a[k] - b[k] for k in keys) / len(keys) if keys else math.nan


def job_seconds(cost: Mapping[str, Any]) -> float:
    download = cost["bundle_bytes"] / BUNDLE_DOWNLOAD_BYTES_PER_SECOND
    return JOB_OVERHEAD_SECONDS + download + cost["per_pr_seconds"]


def build_minutes(cost: Mapping[str, Any]) -> float:
    return cost["corpus_tokens"] / cost["tokens_per_second"] / 60


def gates(cost: Mapping[str, Any]) -> dict[str, bool]:
    return {
        "job": job_seconds(cost) <= JOB_MAX_SECONDS,
        "bundle": cost["bundle_bytes"] <= BUNDLE_MAX_BYTES,
        "build": build_minutes(cost) <= BUILD_MAX_MINUTES,
    }


@dataclass
class Decisions:
    lines: list[str] = field(default_factory=list)
    comparisons: list[Comparison] = field(default_factory=list)
    frozen: Optional[str] = None

    def binary(
        self, label: str, keep: Settings, alt: Settings, metrics: Mapping[str, Metrics]
    ) -> Optional[Settings]:
        """`keep` unless `alt` beats it on BASE_MODEL; None when `keep` was not measured."""
        keep_id, alt_id = keep.id(BASE_MODEL), alt.id(BASE_MODEL)
        if keep_id not in metrics:
            self.lines.append(f"{label}: {keep_id} not measured, no decision.")
            return None
        if alt_id not in metrics:
            self.lines.append(f"{label}: {alt_id} not measured, keeping {keep_id}.")
            return keep
        c = compare(alt_id, keep_id, metrics)
        self.comparisons.append(c)
        self.lines.append(f"{label}: {c.line()} -> {alt_id if c.beats else keep_id}.")
        return alt if c.beats else keep

    def model(
        self,
        settings: Settings,
        selection: Mapping[str, Metrics],
        confirmation: Mapping[str, Metrics],
        costs: Mapping[str, Mapping[str, Any]],
    ) -> Optional[str]:
        """By registry size from the smallest: a bigger model replaces the incumbent if
        it beats it on the selection slice and is also ahead on the confirmation slice.
        The pick must be within the gates."""
        order = registry_order()
        measured = {m for m in order if settings.id(m) in selection and m in costs}
        for m in order:
            if m not in measured:
                self.lines.append(f"4. model: {settings.id(m)} not measured.")
        best = order[0]
        if best not in measured:
            self.lines.append(f"4. model: no decision without the smallest, {best}.")
            return None
        self.lines.append(f"4. model: start from {best}.")
        for m in order[1:]:
            if m not in measured:
                continue
            c = compare(settings.id(m), settings.id(best), selection)
            self.comparisons.append(c)
            new, old = (
                confirmation.get(settings.id(m)),
                confirmation.get(settings.id(best)),
            )
            conf = mean_diff(new.primary, old.primary) if new and old else math.nan
            wins = c.beats and conf > 0
            g = gates(costs[m])
            if wins and all(g.values()):
                note = f"replaces {best}"
                best = m
            elif wins:
                note = f"would have won but is outside the gates {g}"
            else:
                note = f"does not replace {best}"
            self.lines.append(f"   {c.line()}; confirmation {conf:+.3f}: {m} {note}.")
        if not all(gates(costs[best]).values()):
            self.lines.append(f"   {best} is outside the gates {gates(costs[best])}.")
            return None
        return best


def decide(
    selection: Mapping[str, Metrics],
    confirmation: Mapping[str, Metrics],
    all_costs: Mapping[str, Mapping[str, Mapping[str, Any]]],
) -> Decisions:
    """`all_costs`: corpus -> model -> measured cost."""
    d = Decisions()
    settings: Optional[Settings] = Settings(CORPUS_NAMES[0], AGGREGATIONS[0], True)
    rules = [
        ("1. corpus", "corpus", CORPUS_NAMES[1]),
        ("2. aggregation", "aggregation", AGGREGATIONS[1]),
        ("3. query instruction", "instruction", False),
    ]
    for label, name, value in rules:
        assert settings is not None
        settings = d.binary(
            label, settings, dataclasses.replace(settings, **{name: value}), selection
        )
        if settings is None:
            return d
        cost = all_costs.get(settings.corpus, {}).get(BASE_MODEL)
        if (
            settings.corpus != CORPUS_NAMES[0]
            and cost
            and not all(gates(cost).values())
        ):
            d.lines.append(
                f"   {settings.id(BASE_MODEL)} is outside the gates {gates(cost)}: "
                f"keeping {CORPUS_NAMES[0]}."
            )
            settings = dataclasses.replace(settings, corpus=CORPUS_NAMES[0])
    assert settings is not None
    costs = all_costs.get(settings.corpus, {})
    best = d.model(settings, selection, confirmation, costs)
    if best is None:
        return d
    d.frozen = settings.id(best)
    d.lines.append(f"   frozen configuration: {d.frozen}.")
    return d
