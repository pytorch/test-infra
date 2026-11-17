from __future__ import annotations

import logging
from dataclasses import replace
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, cast

import pytest

from greenlight import change_listing, quota
from greenlight.change_feed import EMPTY_MARKER, Marker
from greenlight.constants import (
    FINGERPRINT_QUIET,
    FULL_TICK_INTERVAL,
    FULL_TICK_MINUTES_DEFAULT,
    LISTING_OVERLAP,
    TARGET_REPO,
)
from greenlight.guards import IterationTimeout
from greenlight.pr_listing import OpenPR
from greenlight.repo_config import BUILTIN_PYTORCH, RepoEntry
from greenlight.scan_memory import FingerprintCache, ScanMemory

if TYPE_CHECKING:
    from github import Github

    from greenlight.change_listing import Listing

_NOW = datetime(2026, 11, 17, 12, 0, 0)
_WINDOW = timedelta(hours=24)
_COHORT = frozenset({"alice"})
_CLIENT = cast("Github", object())
_CLICKHOUSE = replace(BUILTIN_PYTORCH, change_source="clickhouse")
_SWEEP = timedelta(minutes=FULL_TICK_MINUTES_DEFAULT)
_RECENT = _NOW - timedelta(hours=1)
_IDLE = _NOW - timedelta(days=3)
# A PR HUD has rows for, whose rows show nothing newer than any listing here.
_SEEN = Marker(pr_updated_at=_IDLE - timedelta(days=1), reviews=1)


def _record(
    number: int,
    *,
    author: str = "alice",
    updated_at: datetime | None = _RECENT,
    draft: bool = False,
    state: str = "open",
    labels: tuple[str, ...] = (),
    head_sha: str | None = None,
) -> OpenPR:
    return OpenPR(
        TARGET_REPO,
        number,
        author,
        f"fix {number}",
        f"url{number}",
        head_sha if head_sha is not None else f"sha{number}",
        updated_at,
        True,
        labels,
        draft,
        state,
    )


class _Freshness:
    def __init__(self, problem: str | None, error: Exception | None) -> None:
        self._problem = problem
        self._error = error

    def problem(self) -> str | None:
        if self._error is not None:
            raise self._error
        return self._problem


class _Sources:
    """The tick's GitHub listings and HUD ClickHouse reads, each call recorded in ``events`` in order."""

    def __init__(self) -> None:
        self.events: list[str] = []
        self.open: list[OpenPR] = []
        self.recent: list[OpenPR] = []
        self.reverted: list[OpenPR] = []
        self.markers: dict[int, Marker] = {}
        self.unknown_marker = _SEEN
        self.marker_errors: list[BaseException] = []
        self.freshness_problem: str | None = None
        self.freshness_error: BaseException | None = None
        self.problem_error: Exception | None = None
        self.recent_error: Exception | None = None

    def read_markers(self, repo, numbers):
        self.events.append(f"markers {repo} {list(numbers)}")
        if self.marker_errors:
            raise self.marker_errors.pop(0)
        return {number: self.markers.get(number, self.unknown_marker) for number in numbers}

    def read_freshness(self):
        self.events.append("freshness")
        if self.freshness_error is not None:
            raise self.freshness_error
        return _Freshness(self.freshness_problem, self.problem_error)

    def list_open(self, _client, repo):
        self.events.append(f"list open {repo}")
        return list(self.open)

    def list_recent(self, _client, repo, *, cutoff, state):
        self.events.append(f"list recent {repo} {state} since {cutoff:%H:%M}")
        if self.recent_error is not None:
            raise self.recent_error
        return list(self.recent)

    def list_reverted(self, _client, repo, authors):
        self.events.append(f"list reverted {repo} {sorted(authors)}")
        return list(self.reverted)

    def fetch(self, _client, repo, _authors):
        self.events.append(f"fetch {repo}")
        return list(self.open)

    def fetch_updated(self, _client, repo, _authors, cutoff):
        self.events.append(f"fetch_updated {repo} since {cutoff:%Y-%m-%d %H:%M}")
        return list(self.recent)


def _list(
    memory: ScanMemory | None,
    sources: _Sources,
    *,
    now: datetime = _NOW,
    entry: RepoEntry = _CLICKHOUSE,
    pr: int | None = None,
) -> Listing:
    return change_listing.list_candidates(
        _CLIENT,
        entry=entry,
        pr=pr,
        authors=_COHORT,
        memory=memory,
        now=now,
        window=_WINDOW,
        fetch=sources.fetch,
        fetch_updated=sources.fetch_updated,
        read_markers=sources.read_markers,
        read_freshness=sources.read_freshness,
        list_open=sources.list_open,
        list_recent=sources.list_recent,
        list_reverted=sources.list_reverted,
    )


def _warm(*records: OpenPR, full_at: datetime = _NOW - timedelta(minutes=2)) -> ScanMemory:
    """A memory whose view a completed full tick at ``full_at`` built from ``records``."""
    memory = ScanMemory()
    memory.view.rebuild(records, full_at)
    memory.mark_full_tick(full_at)
    return memory


def test_a_cold_start_lists_every_open_pr_and_reads_the_markers_after_the_listing(caplog):
    sources = _Sources()
    sources.open = [_record(1), _record(2, author="carol"), _record(3, draft=True)]
    sources.markers = {1: Marker(comments=1)}
    memory = ScanMemory()

    with caplog.at_level(logging.INFO, logger="greenlight"):
        listing = _list(memory, sources)

    assert sources.events == ["freshness", f"list open {TARGET_REPO}", f"markers {TARGET_REPO} [1, 2, 3]"]
    assert (listing.full_tick, listing.wide_tick) == (True, False)
    assert listing.numbers == [1]
    assert listing.heads == {1: "sha1"}
    assert listing.markers == {1: (Marker(comments=1), _NOW)}
    assert sorted(memory.view.records) == [1, 2, 3]
    assert memory.view.listed_at == _NOW
    assert memory.full_tick_interval == _SWEEP
    assert (
        f"{TARGET_REPO}: full tick from ClickHouse; 3 PR(s) listed, 1 candidate(s), 3 PR(s) whose marker changed"
        in caplog.text
    )


def test_a_cold_start_keeps_nothing_until_the_quiet_period_after_first_sight():
    sources = _Sources()
    sources.open = [_record(1)]
    memory = ScanMemory()

    def fan_out(now: datetime) -> str:
        """List PR1 at ``now`` and fingerprint it five seconds later unless the cache settles it."""
        listing = _list(memory, sources, now=now)
        cache = FingerprintCache(
            memory,
            reuse=not listing.full_tick,
            authorized_logins=_COHORT,
            updated_at=listing.updated_at,
            head_sha=listing.heads,
            now=now + timedelta(seconds=5),
            markers=listing.markers,
        )
        if cache.lookup(1) is None:
            cache.store(1, ("sha1", "a" * 64))
            outcome = "fetched"
        else:
            cache.keep(1)
            outcome = "reused"
        cache.commit()
        if listing.full_tick:
            memory.mark_full_tick(now)
        return outcome

    # PR1's listed updated_at is an hour old, yet the first tick keeps nothing: the process first saw its
    # marker at that tick. The second, the quiet period on, fetches again and keeps it for the third.
    assert fan_out(_NOW) == "fetched"
    assert fan_out(_NOW + FINGERPRINT_QUIET) == "fetched"
    assert fan_out(_NOW + FINGERPRINT_QUIET + timedelta(minutes=2)) == "reused"


def test_the_next_tick_reads_the_markers_before_its_listings_and_walks_back_from_the_last_listing():
    sources = _Sources()
    sources.recent = [_record(2)]
    memory = _warm(_record(1))
    previous = memory.view.listed_at

    listing = _list(memory, sources)

    assert previous is not None
    assert sources.events == [
        f"markers {TARGET_REPO} [1]",
        "freshness",
        f"list recent {TARGET_REPO} all since {previous - LISTING_OVERLAP:%H:%M}",
        f"list reverted {TARGET_REPO} ['alice']",
    ]
    assert (listing.full_tick, listing.wide_tick) == (False, False)
    assert listing.numbers == [1, 2]
    assert memory.view.listed_at == _NOW
    # The walk just added PR2: the view has read no marker for it yet.
    assert listing.markers == {1: (_SEEN, _NOW), 2: None}


@pytest.mark.parametrize(
    ("since_full", "problem", "kind"),
    [
        pytest.param(timedelta(minutes=5), None, "event", id="event"),
        pytest.param(timedelta(minutes=5), "stale", "event", id="event-while-stale"),
        pytest.param(FULL_TICK_INTERVAL, None, "wide", id="wide-while-fresh"),
        pytest.param(FULL_TICK_INTERVAL, "stale", "full", id="full-while-stale"),
        pytest.param(_SWEEP, None, "full", id="sweep"),
    ],
)
def test_the_ticks_kind(since_full, problem, kind):
    sources = _Sources()
    sources.open = [_record(1)]
    sources.freshness_problem = problem
    memory = _warm(_record(1), full_at=_NOW - since_full)

    listing = _list(memory, sources)

    assert ("full" if listing.full_tick else "wide" if listing.wide_tick else "event") == kind
    assert memory.full_tick_interval == (_SWEEP if problem is None else FULL_TICK_INTERVAL)
    assert (f"list open {TARGET_REPO}" in sources.events) is (kind == "full")


def test_a_wide_tick_hands_over_every_candidate_and_an_event_tick_only_the_window():
    records = (_record(1, updated_at=_IDLE), _record(2), _record(3, author="carol"))

    wide = _list(_warm(*records, full_at=_NOW - FULL_TICK_INTERVAL), _Sources())
    event = _list(_warm(*records), _Sources())

    assert (wide.wide_tick, wide.numbers) == (True, [1, 2])
    assert (event.wide_tick, event.numbers) == (False, [2])


def test_a_wide_tick_counts_from_the_last_wide_tick_too():
    memory = _warm(_record(1), full_at=_NOW - timedelta(minutes=20))
    memory.mark_wide_tick(_NOW - timedelta(minutes=5))

    assert not _list(memory, _Sources()).wide_tick


def _stale(caplog: pytest.LogCaptureFixture, sources: _Sources, memory: ScanMemory) -> str | None:
    with caplog.at_level(logging.INFO, logger="greenlight"):
        _list(memory, sources)
    [line] = [record.getMessage() for record in caplog.records if " tick from " in record.getMessage()]
    source = line.split(" tick from ", 1)[1].split(";", 1)[0]
    return None if source == "ClickHouse" else source.removeprefix("GitHub, stale: ")


def test_a_fresh_reading_keeps_the_repos_sweep_interval(caplog):
    sources = _Sources()
    sources.unknown_marker = EMPTY_MARKER
    sources.markers = {1: Marker(reviews=1)}
    memory = _warm(_record(1), _record(2))

    assert _stale(caplog, sources, memory) is None
    assert memory.full_tick_interval == _SWEEP


def test_stale_tables_turn_the_sweep_back_to_the_full_tick_interval(caplog):
    sources = _Sources()
    sources.freshness_problem = "pull_request's newest event is 50 minutes old"
    memory = _warm(_record(1))

    assert _stale(caplog, sources, memory) == "pull_request's newest event is 50 minutes old"
    assert memory.full_tick_interval == FULL_TICK_INTERVAL


def test_a_failed_marker_reading_is_logged_stale_and_reads_no_freshness(caplog):
    sources = _Sources()
    sources.marker_errors = [RuntimeError("clickhouse down")]
    memory = _warm(_record(1))
    memory.view.note({1: Marker(reviews=1)}, _NOW - timedelta(minutes=10))

    assert _stale(caplog, sources, memory) == "the marker reading failed"
    assert "freshness" not in sources.events
    assert memory.full_tick_interval == FULL_TICK_INTERVAL
    [error] = [record for record in caplog.records if record.levelno == logging.ERROR]
    assert error.getMessage() == f"{TARGET_REPO}: cannot read the HUD ClickHouse markers of 1 PR(s)"
    assert error.exc_info is not None
    # The view keeps the last marker it read, so the cache keeps a ``github`` repo's reuse.
    assert memory.view.seen(1) == (Marker(reviews=1), _NOW - timedelta(minutes=10))


@pytest.mark.parametrize("failure", ["freshness_error", "problem_error"])
def test_a_failed_freshness_reading_is_logged_and_stale(caplog, failure):
    sources = _Sources()
    setattr(sources, failure, RuntimeError("no grant on default.issue_comment"))
    memory = _warm(_record(1))

    assert _stale(caplog, sources, memory) == "the freshness reading failed"
    assert memory.full_tick_interval == FULL_TICK_INTERVAL
    [error] = [record for record in caplog.records if record.levelno == logging.ERROR]
    assert error.getMessage() == "cannot read the freshness of HUD ClickHouse's webhook tables"
    assert error.exc_info is not None


def test_a_repo_hud_has_no_rows_for_counts_as_stale(caplog):
    sources = _Sources()
    sources.unknown_marker = EMPTY_MARKER
    memory = _warm(_record(1), _record(2))

    assert _stale(caplog, sources, memory) == "no open PR of the repo has a row"
    assert memory.full_tick_interval == FULL_TICK_INTERVAL


def test_a_view_with_no_open_pr_counts_as_covered(caplog):
    assert _stale(caplog, _Sources(), _warm()) is None


@pytest.mark.parametrize("read", ["markers", "freshness"])
@pytest.mark.parametrize("error", [IterationTimeout("iteration exceeded 600 seconds"), quota.RateLimitStop("stop")])
def test_an_iteration_timeout_propagates(read, error):
    sources = _Sources()
    if read == "markers":
        sources.marker_errors = [error]
    else:
        sources.freshness_error = error

    with pytest.raises(type(error)):
        _list(_warm(_record(1)), sources)


def test_a_failed_reading_after_a_full_listing_leaves_its_prs_unread(caplog):
    sources = _Sources()
    sources.open = [_record(1)]
    sources.marker_errors = [RuntimeError("clickhouse down")]
    memory = ScanMemory()

    assert _stale(caplog, sources, memory) == "the marker reading failed"
    assert memory.view.seen(1) is None
    assert memory.full_tick_interval == _SWEEP


def test_closes_and_merges_leave_the_view_and_a_reopen_brings_the_pr_back():
    sources = _Sources()
    sources.recent = [_record(1, state="closed"), _record(2, state="closed")]
    memory = _warm(_record(1), _record(2), _record(3))

    closed = _list(memory, sources)
    sources.recent = [_record(1)]
    reopened = _list(memory, sources, now=_NOW + timedelta(minutes=2))

    assert closed.numbers == [3]
    assert reopened.numbers == [1, 3]
    assert sorted(memory.view.records) == [1, 3]


def test_a_lagging_list_position_enters_the_window_through_the_markers_newest_comment():
    commented = _NOW - timedelta(minutes=3)
    sources = _Sources()
    sources.markers = {1: Marker(comments=4, comment_updated_at=commented)}
    memory = _warm(_record(1, updated_at=_IDLE), _record(2, updated_at=_IDLE))

    listing = _list(memory, sources)

    assert listing.numbers == [1]
    assert listing.updated_at == {1: commented}


def test_the_reverted_prs_join_the_ticks_candidates_without_entering_the_view():
    sources = _Sources()
    sources.reverted = [
        _record(2, labels=("Reverted",), head_sha="", updated_at=_IDLE),
        _record(9, labels=("Reverted",), updated_at=_IDLE),
    ]
    memory = _warm(_record(1), _record(2))

    listing = _list(memory, sources)

    assert listing.numbers == [1, 2, 9]
    assert listing.labels == {1: (), 2: ("Reverted",), 9: ("Reverted",)}
    assert listing.heads[2] == ""
    assert listing.markers[9] is None
    assert sorted(memory.view.records) == [1, 2]
    assert memory.view.records[2].labels == ()


def test_a_failing_recent_listing_raises_and_keeps_the_previous_listings_start():
    sources = _Sources()
    sources.recent_error = RuntimeError("listing boom")
    memory = _warm(_record(1))
    previous = memory.view.listed_at

    with pytest.raises(RuntimeError, match="listing boom"):
        _list(memory, sources)

    assert memory.view.listed_at == previous
    assert f"list reverted {TARGET_REPO} ['alice']" not in sources.events


def test_a_github_repo_drops_its_view_and_keeps_todays_full_tick():
    sources = _Sources()
    sources.open = [_record(1)]
    memory = _warm(_record(1), full_at=_NOW - FULL_TICK_INTERVAL)
    memory.full_tick_interval = _SWEEP

    listing = _list(memory, sources, entry=BUILTIN_PYTORCH)

    assert sources.events == [f"fetch {TARGET_REPO}"]
    assert (listing.full_tick, listing.wide_tick, listing.markers) == (True, False, {})
    assert listing.numbers == [1]
    assert not memory.view.built
    assert memory.full_tick_interval == FULL_TICK_INTERVAL


def test_a_github_repo_between_full_ticks_runs_todays_fast_listing():
    sources = _Sources()
    sources.recent = [_record(4)]

    listing = _list(_warm(full_at=_NOW - timedelta(minutes=2)), sources, entry=BUILTIN_PYTORCH)

    assert sources.events == [f"fetch_updated {TARGET_REPO} since {_NOW - _WINDOW:%Y-%m-%d %H:%M}"]
    assert (listing.full_tick, listing.numbers) == (False, [4])


def test_a_scan_without_memory_lists_in_full_whatever_the_source():
    sources = _Sources()
    sources.open = [_record(1)]

    listing = _list(None, sources)

    assert sources.events == [f"fetch {TARGET_REPO}"]
    assert (listing.full_tick, listing.numbers, listing.markers) == (True, [1], {})


def test_a_single_pr_scan_of_a_clickhouse_repo_lists_nothing_and_leaves_the_view_alone():
    sources = _Sources()
    memory = _warm(_record(1))
    memory.full_tick_interval = _SWEEP

    listing = _list(memory, sources, pr=7)

    assert sources.events == []
    assert (listing.numbers, listing.markers) == ([7], {})
    assert memory.view.built
    assert memory.full_tick_interval == _SWEEP
