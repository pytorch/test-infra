from collections import Counter
from dataclasses import dataclass
from typing import Dict, List, Set, Tuple

from .load import Record

CATEGORY_REGRESSION = "regression"
CATEGORY_FLAKY = "flaky"


@dataclass(frozen=True)
class RankRow:
    name: str
    count: int
    verdict: str = ""


@dataclass(frozen=True)
class Meta:
    source: str
    total_rows: int
    distinct_commits: int
    regression_rows: int
    flaky_rows: int
    min_day: str
    max_day: str


@dataclass(frozen=True)
class Datasets:
    days: List[str]
    flaky_commits_by_day: List[int]
    flaky_signals_by_day: List[int]
    flaky_rank_by_signal: List[RankRow]
    flaky_rank_by_workflow: List[RankRow]
    regression_commits_by_day: List[int]
    regression_signals_by_day: List[int]
    regression_rank_by_signal: List[RankRow]
    regression_rank_by_workflow: List[RankRow]
    meta: Meta


def _by_category(records: List[Record], category: str) -> List[Record]:
    return [r for r in records if r.category == category]


def _distinct_commits_by_day(records: List[Record], days: List[str]) -> List[int]:
    seen: Dict[str, Set[str]] = {day: set() for day in days}
    for r in records:
        seen[r.day].add(r.commit_sha)
    return [len(seen[day]) for day in days]


def _rows_by_day(records: List[Record], days: List[str]) -> List[int]:
    counts: Counter = Counter(r.day for r in records)
    return [counts.get(day, 0) for day in days]


def _rank(records: List[Record], attr: str) -> List[RankRow]:
    counts: Counter = Counter(getattr(r, attr) for r in records)
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [RankRow(name=name, count=count) for name, count in ordered]


def _latest_verdict_by_signal(records: List[Record]) -> Dict[str, str]:
    latest: Dict[str, Tuple[str, str]] = {}
    for r in records:
        if not r.advisor_verdict:
            continue
        prev = latest.get(r.signal_key)
        if prev is None or r.commit_time >= prev[0]:
            latest[r.signal_key] = (r.commit_time, r.advisor_verdict)
    return {key: verdict for key, (_, verdict) in latest.items()}


def _rank_signals_with_verdict(records: List[Record]) -> List[RankRow]:
    verdicts = _latest_verdict_by_signal(records)
    base = _rank(records, "signal_key")
    return [
        RankRow(name=row.name, count=row.count, verdict=verdicts.get(row.name, ""))
        for row in base
    ]


def _sorted_union_days(records: List[Record]) -> List[str]:
    return sorted({r.day for r in records})


def _build_meta(source: str, records: List[Record], days: List[str]) -> Meta:
    regressions = _by_category(records, CATEGORY_REGRESSION)
    flaky = _by_category(records, CATEGORY_FLAKY)
    return Meta(
        source=source,
        total_rows=len(records),
        distinct_commits=len({r.commit_sha for r in records}),
        regression_rows=len(regressions),
        flaky_rows=len(flaky),
        min_day=days[0] if days else "",
        max_day=days[-1] if days else "",
    )


def aggregate(records: List[Record], source: str) -> Datasets:
    days = _sorted_union_days(records)
    flaky = _by_category(records, CATEGORY_FLAKY)
    regressions = _by_category(records, CATEGORY_REGRESSION)

    return Datasets(
        days=days,
        flaky_commits_by_day=_distinct_commits_by_day(flaky, days),
        flaky_signals_by_day=_rows_by_day(flaky, days),
        flaky_rank_by_signal=_rank(flaky, "signal_key"),
        flaky_rank_by_workflow=_rank(flaky, "workflow"),
        regression_commits_by_day=_distinct_commits_by_day(regressions, days),
        regression_signals_by_day=_rows_by_day(regressions, days),
        regression_rank_by_signal=_rank_signals_with_verdict(regressions),
        regression_rank_by_workflow=_rank(regressions, "workflow"),
        meta=_build_meta(source, records, days),
    )


def top_n(rows: List[RankRow], n: int) -> Tuple[List[RankRow], int]:
    if n < 0:
        n = 0
    head = rows[:n]
    leftover = sum(row.count for row in rows[n:])
    return head, leftover
