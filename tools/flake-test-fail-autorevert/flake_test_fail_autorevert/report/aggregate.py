from collections import Counter
from dataclasses import dataclass, replace
from typing import Dict, List, Set, Tuple

from .load import Record


CATEGORY_REGRESSION = "regression"
CATEGORY_FLAKY = "flaky"

PREMERGE_STATUS_TD_DESELECTED = "NOT_RUN:td_deselected"
PREMERGE_STATUS_RUN_SUCCEEDED = "RUN_SUCCEEDED"
PREMERGE_STATUS_RUN_FAILED = "RUN_FAILED"
PREMERGE_STATUS_FORCE_MERGE = "NOT_RUN:force_merge"
PREMERGE_STATUS_NO_MERGE_RECORD = "NOT_RUN:no_merge_record"
PREMERGE_STATUS_ERROR = "ERROR"
PREMERGE_STATUS_SKIPPED = "NOT_RUN:skipped"
PREMERGE_STATUS_NOT_IN_MATRIX = "NOT_RUN:not_in_matrix"

# Report-only remap: a test that reports "skipped" on the pre-merge head is often
# skipped only because the pre-merge matrix ran a config that excludes it (e.g. the
# 'slow' shard's fast-skip, or a platform guard) while the config that actually
# executes it was absent - i.e. effectively a matrix-coverage gap, not a genuine
# opt-out. The generator keeps the precise status; the report folds skipped into
# not_in_matrix so the funnel/breakdown don't overstate genuine skips.
_REPORT_STATUS_REMAP = {PREMERGE_STATUS_SKIPPED: PREMERGE_STATUS_NOT_IN_MATRIX}

# Plain-language explanations of every pre-merge status, keyed once here so the
# breakdown rows, totals cards, and table headings all share one source of
# truth. Written for readers with no CI jargon; ASCII-only so they escape
# cleanly into HTML title attributes.
PREMERGE_STATUS_TOOLTIPS: Dict[str, str] = {
    PREMERGE_STATUS_RUN_SUCCEEDED: (
        "This test ran while the change was still a pull request and passed "
        "there. It only started failing after the change landed on main - "
        "usually a 'landrace': the change was fine on its own but broke when "
        "combined with another change that merged around the same time."
    ),
    "RUN_FAILED": (
        "This test already failed while the change was still a pull request, "
        "yet it was merged anyway. The breakage was visible in CI before it "
        "landed."
    ),
    "NOT_RUN:force_merge": (
        "The change was merged without waiting for the required CI checks (a "
        "force-merge / '-f'), so this test never ran before it landed."
    ),
    "NOT_RUN:skipped": (
        "The test was present in the pre-merge run but was explicitly skipped, "
        "so it produced no pass/fail result before merge."
    ),
    PREMERGE_STATUS_TD_DESELECTED: (
        "The test's file ran before merge, but this specific test wasn't "
        "selected - PyTorch skips tests it predicts are unaffected by the "
        "change (or the test was renamed/removed). No pre-merge result exists "
        "for it."
    ),
    "NOT_RUN:not_in_matrix": (
        "The test's job/configuration didn't run before merge at all - it "
        "wasn't part of this pull request's checks, even though other checks "
        "did run."
    ),
    PREMERGE_STATUS_NO_MERGE_RECORD: (
        "We couldn't identify which pre-merge version to check for this commit "
        "- e.g. a stacked-PR commit that isn't the top of its stack, a revert, "
        "or a direct push. Pre-merge status is unknown."
    ),
    PREMERGE_STATUS_ERROR: (
        "The query that determines pre-merge status failed, so the status is "
        "unknown for this row."
    ),
}

# Grouped explanations for the two totals cards that combine several statuses.
# Kept here so cards stay single-sourced alongside the per-status tooltips.
PREMERGE_TOOLTIP_UNDETERMINED = (
    "Pre-merge status couldn't be determined: either no pre-merge version "
    "could be identified, or the lookup failed."
)
PREMERGE_TOOLTIP_OTHER = (
    "All remaining outcomes: the test failed before merge, was force-merged, "
    "was skipped, or its job wasn't in the pre-merge checks."
)


@dataclass(frozen=True)
class RankRow:
    name: str
    count: int
    verdict: str = ""


@dataclass(frozen=True)
class PremergeStatusCount:
    name: str
    signals: int
    commits: int


@dataclass(frozen=True)
class PremergeBuckets:
    td_deselected: int
    run_succeeded: int
    undetermined: int
    other: int

    @property
    def total(self) -> int:
        return self.td_deselected + self.run_succeeded + self.undetermined + self.other


@dataclass(frozen=True)
class PremergeRow:
    commit_sha: str
    commit_url: str
    commit_time: str
    workflow: str
    signal_key: str


@dataclass(frozen=True)
class PremergeData:
    total_eligible: int
    total_eligible_commits: int
    buckets: PremergeBuckets
    breakdown: List[PremergeStatusCount]
    run_succeeded_rows: List[PremergeRow]
    td_deselected_rows: List[PremergeRow]
    green_would_be_red_commits: int
    td_deselected_commits: int


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
    premerge: PremergeData
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


def _apply_report_remap(records: List[Record]) -> List[Record]:
    remapped = []
    for r in records:
        target = _REPORT_STATUS_REMAP.get(r.premerge_status)
        remapped.append(replace(r, premerge_status=target) if target else r)
    return remapped


def aggregate(records: List[Record], source: str) -> Datasets:
    records = _apply_report_remap(records)
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
        premerge=_build_premerge(records),
        meta=_build_meta(source, records, days),
    )


def _premerge_eligible(records: List[Record]) -> List[Record]:
    return [r for r in records if r.premerge_status]


def _premerge_buckets(eligible: List[Record]) -> PremergeBuckets:
    counts: Counter = Counter(r.premerge_status for r in eligible)
    td_deselected = counts.get(PREMERGE_STATUS_TD_DESELECTED, 0)
    run_succeeded = counts.get(PREMERGE_STATUS_RUN_SUCCEEDED, 0)
    undetermined = counts.get(PREMERGE_STATUS_NO_MERGE_RECORD, 0) + counts.get(
        PREMERGE_STATUS_ERROR, 0
    )
    other = len(eligible) - td_deselected - run_succeeded - undetermined
    buckets = PremergeBuckets(
        td_deselected=td_deselected,
        run_succeeded=run_succeeded,
        undetermined=undetermined,
        other=other,
    )
    assert buckets.total == len(eligible), (
        "premerge buckets must partition the eligible rows: "
        f"{buckets.total} != {len(eligible)}"
    )
    return buckets


_COMMIT_STATUS_PRIORITY = {
    PREMERGE_STATUS_TD_DESELECTED: 6,
    PREMERGE_STATUS_RUN_FAILED: 5,
    PREMERGE_STATUS_RUN_SUCCEEDED: 4,
    PREMERGE_STATUS_NOT_IN_MATRIX: 3,
    PREMERGE_STATUS_FORCE_MERGE: 2,
    PREMERGE_STATUS_NO_MERGE_RECORD: 1,
    PREMERGE_STATUS_ERROR: 0,
}


def _commit_winning_status(eligible: List[Record]) -> Dict[str, str]:
    winner: Dict[str, str] = {}
    best: Dict[str, int] = {}
    for r in eligible:
        rank = _COMMIT_STATUS_PRIORITY.get(r.premerge_status, -1)
        if r.commit_sha not in best or rank > best[r.commit_sha]:
            best[r.commit_sha] = rank
            winner[r.commit_sha] = r.premerge_status
    return winner


def _premerge_breakdown(
    eligible: List[Record], winner: Dict[str, str]
) -> List[PremergeStatusCount]:
    signal_counts: Counter = Counter(r.premerge_status for r in eligible)
    commit_counts: Counter = Counter(winner.values())
    names = set(signal_counts) | set(commit_counts)
    ordered = sorted(names, key=lambda name: (-signal_counts.get(name, 0), name))
    return [
        PremergeStatusCount(
            name=name,
            signals=signal_counts.get(name, 0),
            commits=commit_counts.get(name, 0),
        )
        for name in ordered
    ]


def _premerge_rows(eligible: List[Record], status: str) -> List[PremergeRow]:
    matched = [r for r in eligible if r.premerge_status == status]
    matched.sort(
        key=lambda r: (r.commit_time, r.commit_sha, r.signal_key), reverse=True
    )
    return [
        PremergeRow(
            commit_sha=r.commit_sha,
            commit_url=r.commit_url,
            commit_time=r.commit_time,
            workflow=r.workflow,
            signal_key=r.signal_key,
        )
        for r in matched
    ]


def _premerge_td_commit_counts(eligible: List[Record]) -> Tuple[int, int]:
    by_commit: Dict[str, Set[str]] = {}
    for r in eligible:
        by_commit.setdefault(r.commit_sha, set()).add(r.premerge_status)
    td_commits = 0
    green_would_be_red = 0
    for statuses in by_commit.values():
        if PREMERGE_STATUS_TD_DESELECTED not in statuses:
            continue
        td_commits += 1
        if PREMERGE_STATUS_RUN_FAILED not in statuses:
            green_would_be_red += 1
    return green_would_be_red, td_commits


def _build_premerge(records: List[Record]) -> PremergeData:
    eligible = _premerge_eligible(records)
    winner = _commit_winning_status(eligible)
    total_eligible_commits = len({r.commit_sha for r in eligible})
    breakdown = _premerge_breakdown(eligible, winner)
    assert sum(row.commits for row in breakdown) == total_eligible_commits, (
        "premerge breakdown commits must partition the eligible commits: "
        f"{sum(row.commits for row in breakdown)} != {total_eligible_commits}"
    )
    green_would_be_red, td_deselected_commits = _premerge_td_commit_counts(eligible)
    return PremergeData(
        total_eligible=len(eligible),
        total_eligible_commits=total_eligible_commits,
        buckets=_premerge_buckets(eligible),
        breakdown=breakdown,
        run_succeeded_rows=_premerge_rows(eligible, PREMERGE_STATUS_RUN_SUCCEEDED),
        td_deselected_rows=_premerge_rows(eligible, PREMERGE_STATUS_TD_DESELECTED),
        green_would_be_red_commits=green_would_be_red,
        td_deselected_commits=td_deselected_commits,
    )


def top_n(rows: List[RankRow], n: int) -> Tuple[List[RankRow], int]:
    if n < 0:
        n = 0
    head = rows[:n]
    leftover = sum(row.count for row in rows[n:])
    return head, leftover
