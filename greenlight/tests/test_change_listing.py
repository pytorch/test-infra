from __future__ import annotations

import logging
import threading
import time
from dataclasses import replace
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, cast

import pytest
from github import GithubException

from greenlight import change_listing, quota, scan_memory
from greenlight.change_feed import EMPTY_MARKER, Marker
from greenlight.constants import (
    FINGERPRINT_QUIET,
    FULL_TICK_INTERVAL,
    FULL_TICK_MINUTES_DEFAULT,
    LISTING_OVERLAP,
    TARGET_REPO,
)
from greenlight.fingerprint_cache import FingerprintCache
from greenlight.guards import IterationTimeout
from greenlight.pr_listing import candidate_fields
from greenlight.pr_view import READ_ALONE_MAX_ATTEMPTS, PRView, cohort_digest
from greenlight.repo_config import BUILTIN_PYTORCH, RepoEntry
from greenlight.scan_memory import ScanMemory, decode_memory, encode_memory
from greenlight.state import PRState
from tests.change_helpers import NOW, RECENT, FreshnessStub, record

if TYPE_CHECKING:
    from collections.abc import Iterator

    from github import Github

    from greenlight.change_listing import Listing
    from greenlight.pr_listing import Candidates, OpenPR

_NOW = NOW
_WINDOW = timedelta(hours=24)
_COHORT = frozenset({"alice"})
_CLIENT = cast("Github", object())
_CLICKHOUSE = replace(BUILTIN_PYTORCH, change_source="clickhouse")
_SWEEP = timedelta(minutes=FULL_TICK_MINUTES_DEFAULT)
_IDLE = _NOW - timedelta(days=3)
# A PR HUD has rows for, whose rows show nothing newer than any listing here.
_SEEN = Marker(pr_updated_at=_IDLE - timedelta(days=1), reviews=1)
# A hanging read gives up after this long, so a tick that waited for it fails its time check instead of hanging.
_HANG_SECONDS = 10


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
        self.open_error: Exception | None = None
        self.single: dict[int, OpenPR | None] = {}
        self.single_errors: dict[int, Exception] = {}
        self.clickhouse_forbidden = False
        self.hang_markers: threading.Event | None = None
        self.hang_freshness: threading.Event | None = None

    def read_markers(self, repo, numbers):
        if self.clickhouse_forbidden:
            pytest.fail("the tick read HUD ClickHouse's markers")
        self.events.append(f"markers {repo} {list(numbers)}")
        if self.hang_markers is not None:
            self.hang_markers.wait(_HANG_SECONDS)
        if self.marker_errors:
            raise self.marker_errors.pop(0)
        return {number: self.markers.get(number, self.unknown_marker) for number in numbers}

    def read_freshness(self, repo):
        if self.clickhouse_forbidden:
            pytest.fail("the tick read HUD ClickHouse's freshness")
        if repo != TARGET_REPO:
            pytest.fail(f"the tick read the freshness of {repo}")
        self.events.append("freshness")
        if self.hang_freshness is not None:
            self.hang_freshness.wait(_HANG_SECONDS)
        if self.freshness_error is not None:
            raise self.freshness_error
        return FreshnessStub(self.freshness_problem, self.problem_error)

    def list_open(self, _client, repo):
        self.events.append(f"list open {repo}")
        if self.open_error is not None:
            raise self.open_error
        return list(self.open)

    def list_recent(self, _client, repo, *, cutoff):
        self.events.append(f"list recent {repo} since {cutoff:%H:%M}")
        if self.recent_error is not None:
            raise self.recent_error
        return list(self.recent)

    def list_reverted(self, _client, repo, authors):
        self.events.append(f"list reverted {repo} {sorted(authors)}")
        return list(self.reverted)

    def read_record(self, _client, repo, number):
        self.events.append(f"read {repo} #{number}")
        error = self.single_errors.get(number)
        if error is not None:
            raise error
        return self.single[number]

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
    authors: frozenset[str] = _COHORT,
) -> Listing:
    return change_listing.list_candidates(
        _CLIENT,
        entry=entry,
        pr=pr,
        authors=authors,
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
        read_record=sources.read_record,
    )


def _warm(*records: OpenPR, full_at: datetime = _NOW - timedelta(minutes=2)) -> ScanMemory:
    """A memory whose view a completed full tick at ``full_at`` built from ``records``."""
    memory = ScanMemory()
    memory.view.rebuild(records, full_at, _COHORT)
    memory.mark_full_tick(full_at)
    return memory


def test_a_cold_start_lists_every_open_pr_and_keeps_and_reads_the_cohorts_after_the_listing(caplog):
    sources = _Sources()
    sources.open = [record(1), record(2, author="carol"), record(3, draft=True)]
    sources.markers = {1: Marker(comments=1)}
    memory = ScanMemory()

    with caplog.at_level(logging.INFO, logger="greenlight"):
        listing = _list(memory, sources)

    assert sources.events == ["freshness", f"list open {TARGET_REPO}", f"markers {TARGET_REPO} [1, 3]"]
    assert listing.kind == "full"
    assert listing.candidates.numbers == [1]
    assert listing.candidates.heads == {1: "sha1"}
    assert listing.markers == {1: (Marker(comments=1), _NOW)}
    assert sorted(memory.view.records) == [1, 3]
    assert memory.view.listed_at == _NOW
    assert memory.view.usable(_COHORT)
    assert memory.full_tick_interval == _SWEEP
    assert (
        f"{TARGET_REPO}: full tick from ClickHouse; 3 PR(s) listed, 0 read alone, 1 candidate(s), "
        "2 PR(s) whose marker changed" in caplog.text
    )


def _fan_out(memory: ScanMemory, sources: _Sources, now: datetime) -> str:
    """List at ``now`` and fingerprint PR1 five seconds later unless the cache settles it, as a tick does."""
    listing = _list(memory, sources, now=now)
    cache = FingerprintCache(
        memory,
        reuse=listing.kind != "full",
        authorized_logins=_COHORT,
        updated_at=listing.candidates.updated_at,
        head_sha=listing.candidates.heads,
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
    if listing.kind == "full":
        memory.mark_full_tick(now)
    return outcome


def test_a_cold_start_keeps_nothing_until_the_quiet_period_after_first_sight():
    sources = _Sources()
    sources.open = [record(1)]
    memory = ScanMemory()

    # PR1's listed updated_at is an hour old, yet the first tick keeps nothing: the process first saw its
    # marker at that tick. The second, the quiet period on, fetches again and keeps it for the third.
    assert _fan_out(memory, sources, _NOW) == "fetched"
    assert _fan_out(memory, sources, _NOW + FINGERPRINT_QUIET) == "fetched"
    assert _fan_out(memory, sources, _NOW + FINGERPRINT_QUIET + timedelta(minutes=2)) == "reused"


def test_a_cold_start_whose_marker_reads_fail_caches_as_a_github_repo_does():
    sources = _Sources()
    sources.open = [record(1)]
    sources.marker_errors = [RuntimeError("clickhouse down"), RuntimeError("clickhouse down")]
    memory = ScanMemory()

    # With no marker read, PR1 is kept on its hour-old updated_at alone and reused; the first tick that
    # reads its marker misses the result kept under none.
    assert _fan_out(memory, sources, _NOW) == "fetched"
    assert _fan_out(memory, sources, _NOW + timedelta(minutes=2)) == "reused"
    assert _fan_out(memory, sources, _NOW + timedelta(minutes=4)) == "fetched"


def test_the_next_tick_reads_the_markers_before_its_listings_and_walks_back_from_the_last_listing():
    sources = _Sources()
    sources.recent = [record(2)]
    memory = _warm(record(1))
    previous = memory.view.listed_at

    listing = _list(memory, sources)

    assert previous is not None
    assert sources.events == [
        f"markers {TARGET_REPO} [1]",
        "freshness",
        f"list recent {TARGET_REPO} since {previous - LISTING_OVERLAP:%H:%M}",
        f"list reverted {TARGET_REPO} ['alice']",
    ]
    assert listing.kind == "fast"
    assert listing.candidates.numbers == [1, 2]
    assert memory.view.listed_at == _NOW
    # The walk just added PR2: the view has read no marker for it yet.
    assert listing.markers == {1: (_SEEN, _NOW), 2: None}


@pytest.mark.parametrize(
    ("since_full", "problem", "kind"),
    [
        pytest.param(timedelta(minutes=5), None, "fast", id="event"),
        pytest.param(timedelta(minutes=5), "stale", "fast", id="event-while-stale"),
        pytest.param(FULL_TICK_INTERVAL, None, "wide", id="wide-while-fresh"),
        pytest.param(FULL_TICK_INTERVAL, "stale", "full", id="full-while-stale"),
        pytest.param(_SWEEP, None, "full", id="sweep"),
    ],
)
def test_the_ticks_kind(since_full, problem, kind):
    sources = _Sources()
    sources.open = [record(1)]
    sources.freshness_problem = problem
    memory = _warm(record(1), full_at=_NOW - since_full)

    listing = _list(memory, sources)

    assert listing.kind == kind
    assert memory.full_tick_interval == (_SWEEP if problem is None else FULL_TICK_INTERVAL)
    assert (f"list open {TARGET_REPO}" in sources.events) is (kind == "full")


def test_a_wide_tick_hands_over_every_candidate_and_an_event_tick_only_the_window():
    records = (record(1, updated_at=_IDLE), record(2), record(3, author="carol"))

    wide = _list(_warm(*records, full_at=_NOW - FULL_TICK_INTERVAL), _Sources())
    event = _list(_warm(*records), _Sources())

    assert (wide.kind, wide.candidates.numbers) == ("wide", [1, 2])
    assert (event.kind, event.candidates.numbers) == ("fast", [2])


def test_a_wide_tick_counts_from_the_last_wide_tick_too():
    memory = _warm(record(1), full_at=_NOW - timedelta(minutes=20))
    memory.mark_wide_tick(_NOW - timedelta(minutes=5))

    assert _list(memory, _Sources()).kind == "fast"


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
    memory = _warm(record(1), record(2))

    assert _stale(caplog, sources, memory) is None
    assert memory.full_tick_interval == _SWEEP


def test_stale_tables_turn_the_sweep_back_to_the_full_tick_interval(caplog):
    sources = _Sources()
    sources.freshness_problem = "pull_request's newest event is 50 minutes old"
    memory = _warm(record(1))

    assert _stale(caplog, sources, memory) == "pull_request's newest event is 50 minutes old"
    assert memory.full_tick_interval == FULL_TICK_INTERVAL


def test_a_failed_marker_reading_is_logged_stale_and_reads_no_freshness(caplog):
    sources = _Sources()
    sources.marker_errors = [RuntimeError("clickhouse down")]
    memory = _warm(record(1))
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
    memory = _warm(record(1))

    assert _stale(caplog, sources, memory) == "the freshness reading failed"
    assert memory.full_tick_interval == FULL_TICK_INTERVAL
    [error] = [record for record in caplog.records if record.levelno == logging.ERROR]
    assert error.getMessage() == "cannot read the freshness of HUD ClickHouse's webhook tables"
    assert error.exc_info is not None


def test_a_repo_hud_has_no_rows_for_counts_as_stale(caplog):
    sources = _Sources()
    sources.unknown_marker = EMPTY_MARKER
    memory = _warm(record(1), record(2))

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
        _list(_warm(record(1)), sources)


def test_a_failed_reading_after_a_full_listing_leaves_its_prs_unread(caplog):
    sources = _Sources()
    sources.open = [record(1)]
    sources.marker_errors = [RuntimeError("clickhouse down")]
    memory = ScanMemory()

    assert _stale(caplog, sources, memory) == "the marker reading failed"
    assert memory.view.seen(1) is None
    assert memory.full_tick_interval == _SWEEP


def test_closes_and_merges_leave_the_view_and_a_reopen_brings_the_pr_back():
    sources = _Sources()
    sources.recent = [record(1, state="closed"), record(2, state="closed")]
    memory = _warm(record(1), record(2), record(3))

    closed = _list(memory, sources)
    sources.recent = [record(1)]
    reopened = _list(memory, sources, now=_NOW + timedelta(minutes=2))

    assert closed.candidates.numbers == [3]
    assert reopened.candidates.numbers == [1, 3]
    assert sorted(memory.view.records) == [1, 3]


def test_a_lagging_list_position_enters_the_window_through_the_markers_newest_comment():
    commented = _NOW - timedelta(minutes=3)
    sources = _Sources()
    sources.markers = {1: Marker(comments=4, comment_updated_at=commented)}
    memory = _warm(record(1, updated_at=_IDLE), record(2, updated_at=_IDLE))

    listing = _list(memory, sources)

    assert listing.candidates.numbers == [1]
    assert listing.candidates.updated_at == {1: commented}


def test_the_reverted_prs_join_the_ticks_candidates_without_entering_the_view():
    sources = _Sources()
    sources.reverted = [
        record(2, labels=("Reverted",), head_sha="", updated_at=_IDLE),
        record(9, labels=("Reverted",), updated_at=_IDLE),
    ]
    memory = _warm(record(1), record(2))

    listing = _list(memory, sources)

    assert listing.candidates.numbers == [1, 2, 9]
    assert listing.candidates.labels == {1: (), 2: ("Reverted",), 9: ("Reverted",)}
    assert listing.candidates.heads[2] == ""
    assert listing.markers[9] is None
    assert sorted(memory.view.records) == [1, 2]
    assert memory.view.records[2].labels == ()


def test_a_failing_recent_listing_raises_and_keeps_the_previous_listings_start():
    sources = _Sources()
    sources.recent_error = RuntimeError("listing boom")
    memory = _warm(record(1))
    previous = memory.view.listed_at

    with pytest.raises(RuntimeError, match="listing boom"):
        _list(memory, sources)

    assert memory.view.listed_at == previous
    assert f"list reverted {TARGET_REPO} ['alice']" not in sources.events


def test_a_github_repo_drops_its_view_and_keeps_todays_full_tick():
    sources = _Sources()
    sources.open = [record(1)]
    memory = _warm(record(1), full_at=_NOW - FULL_TICK_INTERVAL)
    memory.full_tick_interval = _SWEEP

    listing = _list(memory, sources, entry=BUILTIN_PYTORCH)

    assert sources.events == [f"fetch {TARGET_REPO}"]
    assert (listing.kind, listing.markers) == ("full", {})
    assert listing.candidates.numbers == [1]
    assert not memory.view.built
    assert memory.full_tick_interval == FULL_TICK_INTERVAL


def test_a_github_repo_between_full_ticks_runs_todays_fast_listing():
    sources = _Sources()
    sources.recent = [record(4)]

    listing = _list(_warm(full_at=_NOW - timedelta(minutes=2)), sources, entry=BUILTIN_PYTORCH)

    assert sources.events == [f"fetch_updated {TARGET_REPO} since {_NOW - _WINDOW:%Y-%m-%d %H:%M}"]
    assert (listing.kind, listing.candidates.numbers) == ("fast", [4])


def test_a_scan_without_memory_lists_in_full_whatever_the_source():
    sources = _Sources()
    sources.open = [record(1)]

    listing = _list(None, sources)

    assert sources.events == [f"fetch {TARGET_REPO}"]
    assert (listing.kind, listing.candidates.numbers, listing.markers) == ("full", [1], {})


def test_a_single_pr_scan_of_a_clickhouse_repo_lists_nothing_and_leaves_the_view_alone():
    sources = _Sources()
    memory = _warm(record(1))
    memory.full_tick_interval = _SWEEP

    listing = _list(memory, sources, pr=7)

    assert sources.events == []
    assert (listing.candidates.numbers, listing.markers) == ([7], {})
    assert memory.view.built
    assert memory.full_tick_interval == _SWEEP


_EVENT = _NOW - timedelta(minutes=5)


def _missed(*numbers: int, author: str = "alice") -> tuple[_Sources, ScanMemory]:
    """A view of PRs ``numbers`` listed as drafts days ago; their markers show a newer ``pull_request`` event."""
    sources = _Sources()
    sources.markers = {number: Marker(pr_updated_at=_EVENT) for number in numbers}
    sources.single = {number: record(number, author=author, updated_at=_EVENT) for number in numbers}
    memory = _warm(*(record(number, author=author, updated_at=_IDLE, draft=True) for number in numbers))
    return sources, memory


def test_a_draft_marked_ready_that_the_walk_missed_is_read_alone_and_is_a_candidate_this_tick(caplog):
    sources, memory = _missed(1)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        listing = _list(memory, sources)

    assert sources.events[:2] == [f"markers {TARGET_REPO} [1]", "freshness"]
    assert sources.events[2].startswith(f"list recent {TARGET_REPO} since")
    assert sources.events[3:] == [f"read {TARGET_REPO} #1", f"list reverted {TARGET_REPO} ['alice']"]
    assert listing.candidates.numbers == [1]
    assert listing.candidates.updated_at == {1: _EVENT}
    assert memory.view.records[1] == record(1, updated_at=_EVENT)
    assert "event tick from ClickHouse; 0 PR(s) listed, 1 read alone, 1 candidate(s)" in caplog.text


def test_a_close_the_walk_missed_takes_the_pr_out_of_the_view():
    sources, memory = _missed(1)
    sources.single[1] = record(1, updated_at=_EVENT, state="closed")

    listing = _list(memory, sources)

    assert listing.candidates.numbers == []
    assert 1 not in memory.view.records
    assert memory.view.seen(1) is None


def test_only_cohort_prs_whose_marker_shows_a_newer_pull_request_event_are_read():
    sources = _Sources()
    sources.markers = {
        1: Marker(pr_updated_at=_EVENT),
        2: Marker(pr_updated_at=RECENT),
        3: Marker(pr_updated_at=_EVENT),
        4: Marker(comment_updated_at=_EVENT, reviews=1),
        5: Marker(pr_updated_at=_EVENT),
    }
    sources.single = {1: record(1, updated_at=_EVENT)}
    memory = _warm(
        record(1),
        record(2),
        record(3, author="carol"),
        record(4),
        record(5, updated_at=None),
    )

    _list(memory, sources)

    # PR2's marker is no newer than its record, PR3 is outside the cohort, PR4's newer event is a comment,
    # and PR5 has no listed updated_at to compare.
    assert [event for event in sources.events if event.startswith("read")] == [f"read {TARGET_REPO} #1"]


def test_at_most_the_read_limit_is_read_lowest_number_first():
    limit = change_listing._STALE_RECORD_READS
    sources, memory = _missed(*range(1, limit + 6))

    listing = _list(memory, sources)

    assert [event for event in sources.events if event.startswith("read")] == [
        f"read {TARGET_REPO} #{number}" for number in range(1, limit + 1)
    ]
    assert listing.candidates.numbers == list(range(1, limit + 1))


def test_a_failed_read_is_logged_and_skipped(caplog):
    sources, memory = _missed(1, 2)
    sources.single_errors = {1: RuntimeError("502 from GitHub")}

    with caplog.at_level(logging.INFO, logger="greenlight"):
        listing = _list(memory, sources)

    assert listing.candidates.numbers == [2]
    [error] = [entry for entry in caplog.records if entry.levelno == logging.ERROR]
    assert error.getMessage() == f"{TARGET_REPO}: cannot read PR #1, whose marker is newer than its record"
    assert error.exc_info is not None
    assert "2 read alone" in caplog.text


def test_a_rate_limit_reading_a_pr_alone_raises_as_a_listings_does():
    sources, memory = _missed(1, 2, 3)
    error = GithubException(429, {"message": "secondary rate limit"})
    sources.single_errors = {2: error}

    with pytest.raises(GithubException) as raised:
        _list(memory, sources)

    assert raised.value is error
    assert [event for event in sources.events if event.startswith(("read", "list reverted"))] == [
        f"read {TARGET_REPO} #1",
        f"read {TARGET_REPO} #2",
    ]


def _reads(sources: _Sources) -> list[int]:
    """The PRs read alone since ``sources.events`` was last cleared, in order; clears it."""
    read = [int(event.rsplit("#", 1)[1]) for event in sources.events if event.startswith("read")]
    sources.events.clear()
    return read


def _tick(memory: ScanMemory, sources: _Sources, number: int) -> list[int]:
    """List at the ``number``-th tick after ``_NOW``, two minutes apart; the PRs it read alone."""
    _list(memory, sources, now=_NOW + timedelta(minutes=2 * number))
    return _reads(sources)


def _lagging(sources: _Sources, *numbers: int) -> None:
    """Each read alone of ``numbers`` returns the record as the view holds it, still behind its marker."""
    for number in numbers:
        sources.single[number] = record(number, updated_at=_IDLE, draft=True)


def test_reads_alone_go_never_tried_first_then_the_oldest_attempt_first_across_ticks(monkeypatch):
    monkeypatch.setattr(change_listing, "_STALE_RECORD_READS", 2)
    sources, memory = _missed(1, 2, 3)
    _lagging(sources, 1, 2, 3)

    assert [_tick(memory, sources, number) for number in range(3)] == [[1, 2], [3, 1], [2, 3]]


def test_a_pr_whose_read_alone_fails_goes_behind_the_rest_and_is_retried(monkeypatch, caplog):
    monkeypatch.setattr(change_listing, "_STALE_RECORD_READS", 1)
    sources, memory = _missed(1, 2)
    sources.single_errors = {1: RuntimeError("502 from GitHub")}

    with caplog.at_level(logging.INFO, logger="greenlight"):
        reads = [_tick(memory, sources, number) for number in range(3)]

    # PR1's failed read counts as an attempt, so PR2 is read before PR1 is tried again.
    assert reads == [[1], [2], [1]]
    errors = [entry.getMessage() for entry in caplog.records if entry.levelno == logging.ERROR]
    assert errors == [f"{TARGET_REPO}: cannot read PR #1, whose marker is newer than its record"] * 2


def test_a_record_read_alone_still_behind_its_marker_stays_pending_and_is_read_again_next_tick():
    sources, memory = _missed(1)
    _lagging(sources, 1)

    assert [_tick(memory, sources, number) for number in range(2)] == [[1], [1]]
    assert memory.view.records[1].draft


def test_a_record_read_alone_that_caught_up_is_not_read_again_until_its_marker_moves():
    sources, memory = _missed(1)

    assert [_tick(memory, sources, number) for number in range(2)] == [[1], []]

    sources.markers[1] = Marker(pr_updated_at=_EVENT + timedelta(minutes=1))
    assert _tick(memory, sources, 2) == [1]


def test_the_last_attempt_at_a_marker_gives_its_read_up_with_a_warning(caplog):
    sources, memory = _missed(1)
    _lagging(sources, 1)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        reads = [_tick(memory, sources, number) for number in range(READ_ALONE_MAX_ATTEMPTS + 1)]

    assert reads == [[1]] * READ_ALONE_MAX_ATTEMPTS + [[]]
    [warning] = [entry for entry in caplog.records if entry.levelno == logging.WARNING]
    assert warning.getMessage() == (
        f"{TARGET_REPO}: gave up reading PR #1 alone at its marker's pull_request event of {_EVENT} after "
        f"{READ_ALONE_MAX_ATTEMPTS} attempts"
    )


def test_a_read_that_keeps_failing_is_given_up_too(caplog):
    sources, memory = _missed(1)
    sources.single_errors = {1: RuntimeError("502 from GitHub")}

    with caplog.at_level(logging.INFO, logger="greenlight"):
        reads = [_tick(memory, sources, number) for number in range(READ_ALONE_MAX_ATTEMPTS + 1)]

    assert reads == [[1]] * READ_ALONE_MAX_ATTEMPTS + [[]]
    assert [entry.levelno for entry in caplog.records].count(logging.WARNING) == 1


def test_an_iteration_timeout_reading_a_pr_alone_propagates():
    sources, memory = _missed(1)
    sources.single_errors = {1: quota.RateLimitStop("stop")}

    with pytest.raises(quota.RateLimitStop):
        _list(memory, sources)


def test_a_pr_read_alone_that_names_no_author_is_left_as_it_was():
    sources, memory = _missed(1)
    sources.single[1] = None

    listing = _list(memory, sources)

    assert listing.candidates.numbers == []
    assert memory.view.records[1].draft


@pytest.mark.parametrize(
    "stale",
    [
        pytest.param({"freshness_problem": "pull_request's newest event is 50 minutes old"}, id="stale-tables"),
        pytest.param({"freshness_error": RuntimeError("no grant")}, id="failed-freshness"),
    ],
)
def test_nothing_is_read_alone_while_the_reading_is_stale(stale):
    sources, memory = _missed(1)
    for name, value in stale.items():
        setattr(sources, name, value)

    _list(memory, sources)

    assert not [event for event in sources.events if event.startswith("read")]


def _round_trip(memory: ScanMemory) -> ScanMemory:
    """``memory`` as the state store gives it back to the next tick."""
    return decode_memory(encode_memory(memory, TARGET_REPO), TARGET_REPO)


def _finished(memory: ScanMemory, listing: Listing, at: datetime) -> None:
    """Mark the tick's full or wide listing done, as a finished scan does (``review_finish``)."""
    if listing.kind == "full":
        memory.mark_full_tick(at)
    elif listing.kind == "wide":
        memory.mark_wide_tick(at)


def _unusable(cause: str) -> ScanMemory:
    """A memory whose last full tick started two minutes ago, its sweep every ``full_tick_minutes``, whose
    view the tick cannot use."""
    memory = _warm(record(1))
    memory.full_tick_interval = _SWEEP
    if cause == "not-stored":
        memory.view = PRView()
    elif cause == "no-digest":
        memory.view.digest = None
    return memory


@pytest.mark.parametrize(
    ("cause", "authors"),
    [
        pytest.param("not-stored", _COHORT, id="view-not-stored"),
        pytest.param("no-digest", _COHORT, id="view-without-a-digest"),
        pytest.param("cohort", frozenset({"alice", "bob"}), id="cohort-change"),
    ],
)
def test_with_no_usable_view_and_no_sweep_due_the_tick_is_a_github_fast_tick(caplog, cause, authors):
    sources = _Sources()
    sources.clickhouse_forbidden = True
    sources.recent = [record(4)]
    memory = _unusable(cause)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        listing = _list(memory, sources, authors=authors)

    assert sources.events == [f"fetch_updated {TARGET_REPO} since {_NOW - _WINDOW:%Y-%m-%d %H:%M}"]
    assert (listing.kind, listing.candidates.numbers, listing.markers) == ("fast", [4], {})
    assert not memory.view.built
    assert not memory.wide_due(_NOW)
    assert memory.full_tick_interval == FULL_TICK_INTERVAL
    assert (
        f"{TARGET_REPO}: event tick from GitHub, no usable view; 1 PR(s) listed, 0 read alone, 1 candidate(s), "
        "0 PR(s) whose marker changed" in caplog.text
    )


@pytest.mark.parametrize("cause", ["not-stored", "no-digest"])
def test_with_no_usable_view_the_sweep_is_due_a_full_tick_interval_after_the_last_full_tick(cause):
    sources = _Sources()
    sources.open = [record(1)]
    memory = _unusable(cause)
    memory.mark_full_tick(_NOW - FULL_TICK_INTERVAL)

    listing = _list(memory, sources)

    assert listing.kind == "full"
    assert sources.events == ["freshness", f"list open {TARGET_REPO}", f"markers {TARGET_REPO} [1]"]
    assert memory.view.usable(_COHORT)


def test_a_view_that_is_never_stored_is_listed_in_full_only_every_full_tick_interval(monkeypatch):
    monkeypatch.setattr(scan_memory, "MEMORY_MAX_BYTES", 1)
    sources = _Sources()
    sources.open = [record(1)]
    memory = ScanMemory()
    kinds: list[str] = []

    for minutes in range(0, 32, 2):
        at = _NOW + timedelta(minutes=minutes)
        listing = _list(memory, sources, now=at)
        kinds.append(listing.kind)
        _finished(memory, listing, at)
        memory = _round_trip(memory)
        assert not memory.view.built

    assert kinds == ["full"] + ["fast"] * 7 + ["full"] + ["fast"] * 7
    assert sources.events.count("freshness") == 2


def test_a_cohort_change_lists_from_github_until_the_full_tick_rebuilds_the_view_for_it():
    sources = _Sources()
    sources.open = [record(1), record(2, author="bob"), record(3, author="carol")]
    memory = _unusable("cohort")
    widened = frozenset({"alice", "bob"})

    fast = _list(memory, sources, authors=widened)
    sources.events.clear()
    full_at = _NOW - timedelta(minutes=2) + FULL_TICK_INTERVAL
    full = _list(memory, sources, now=full_at, authors=widened)

    assert fast.kind == "fast"
    assert full.kind == "full"
    assert sources.events == ["freshness", f"list open {TARGET_REPO}", f"markers {TARGET_REPO} [1, 2]"]
    assert full.candidates.numbers == [1, 2]
    assert memory.view.digest == cohort_digest(widened)
    assert memory.view.usable(widened)
    assert not memory.view.usable(_COHORT)


def test_a_full_listing_that_raises_after_a_cohort_change_leaves_the_view_it_found():
    sources = _Sources()
    error = GithubException(429, {"message": "secondary rate limit"})
    sources.open_error = error
    memory = _warm(record(1), full_at=_NOW - FULL_TICK_INTERVAL)
    widened = frozenset({"alice", "bob"})

    with pytest.raises(GithubException) as raised:
        _list(memory, sources, authors=widened)

    assert raised.value is error
    assert sources.events == ["freshness", f"list open {TARGET_REPO}"]
    assert memory.view.digest == cohort_digest(_COHORT)
    assert sorted(memory.view.records) == [1]
    assert not memory.view.usable(widened)


@pytest.fixture
def hang(monkeypatch: pytest.MonkeyPatch) -> Iterator[threading.Event]:
    """An event a fake read blocks on, released when the test ends; the reading deadline is cut to 0.1 s."""
    monkeypatch.setattr(change_listing, "CHANGE_FEED_DEADLINE_SECONDS", 0.1)
    release = threading.Event()
    yield release
    release.set()


def _timed(caplog: pytest.LogCaptureFixture, memory: ScanMemory, sources: _Sources) -> tuple[Listing, float]:
    started = time.monotonic()
    with caplog.at_level(logging.INFO, logger="greenlight"):
        listing = _list(memory, sources)
    return listing, time.monotonic() - started


@pytest.mark.parametrize("read", ["hang_markers", "hang_freshness"])
def test_a_reading_that_hangs_is_stale_at_its_deadline_and_the_tick_still_lists(caplog, hang, read):
    sources = _Sources()
    setattr(sources, read, hang)
    sources.recent = [record(2)]
    memory = _warm(record(1))
    memory.view.note({1: Marker(reviews=1)}, _NOW - timedelta(minutes=10))

    listing, elapsed = _timed(caplog, memory, sources)

    assert elapsed < _HANG_SECONDS / 2
    assert listing.kind == "fast"
    assert listing.candidates.numbers == [1, 2]
    assert listing.markers[1] == (Marker(reviews=1), _NOW - timedelta(minutes=10))
    assert memory.full_tick_interval == FULL_TICK_INTERVAL
    [error] = [entry for entry in caplog.records if entry.levelno == logging.ERROR]
    assert error.getMessage() == (
        f"{TARGET_REPO}: cannot read the HUD ClickHouse markers of 1 PR(s) and the tables' freshness in time"
    )
    assert error.exc_info is not None
    assert "event tick from GitHub, stale: the reading did not finish in time" in caplog.text


def test_a_full_ticks_freshness_read_that_hangs_is_a_failed_freshness_reading(caplog, hang):
    sources = _Sources()
    sources.hang_freshness = hang
    sources.open = [record(1)]

    listing, elapsed = _timed(caplog, ScanMemory(), sources)

    assert elapsed < _HANG_SECONDS / 2
    assert (listing.kind, listing.candidates.numbers) == ("full", [1])
    assert sources.events == ["freshness", f"list open {TARGET_REPO}", f"markers {TARGET_REPO} [1]"]
    assert "full tick from GitHub, stale: the freshness reading failed" in caplog.text


def test_a_full_ticks_marker_read_that_hangs_is_a_failed_marker_reading(caplog, hang):
    sources = _Sources()
    sources.hang_markers = hang
    sources.open = [record(1)]
    memory = ScanMemory()

    listing, elapsed = _timed(caplog, memory, sources)

    assert elapsed < _HANG_SECONDS / 2
    assert (listing.kind, listing.candidates.numbers, listing.markers) == ("full", [1], {1: None})
    assert memory.view.seen(1) is None
    [error] = [entry for entry in caplog.records if entry.levelno == logging.ERROR]
    assert error.getMessage() == f"{TARGET_REPO}: cannot read the HUD ClickHouse markers of 1 PR(s)"
    assert error.exc_info is not None
    assert isinstance(error.exc_info[1], TimeoutError)
    assert "full tick from GitHub, stale: the marker reading failed" in caplog.text


def _row(number: int, status: str = "LAND") -> PRState:
    return PRState(
        pr_number=number, status=status, eval_hash="a" * 64, head_sha=f"sha{number}", version=RECENT, run_id=1
    )


def _recheck(listing: Listing, memory: ScanMemory | None, sources: _Sources, states: dict[int, PRState]) -> Candidates:
    return change_listing.recheck_landed(
        _CLIENT,
        repo=TARGET_REPO,
        listing=listing,
        states=states,
        memory=memory,
        authors=_COHORT,
        now=_NOW,
        read_record=sources.read_record,
    )


def _wide(*records: OpenPR) -> tuple[_Sources, ScanMemory, Listing]:
    sources = _Sources()
    memory = _warm(*records, full_at=_NOW - FULL_TICK_INTERVAL)
    listing = _list(memory, sources)
    assert listing.kind == "wide"
    sources.events.clear()
    return sources, memory, listing


def test_a_wide_tick_rereads_its_land_prs_and_drops_the_author_of_one_whose_base_is_now_refused(caplog):
    sources, memory, listing = _wide(record(1), record(2), record(3))
    retargeted = replace(record(1, updated_at=_EVENT), base_accepted=False, base_ref="release/2.10")
    sources.single = {1: retargeted, 2: record(2, updated_at=_EVENT, author="Alice")}

    with caplog.at_level(logging.INFO, logger="greenlight"):
        candidates = _recheck(listing, memory, sources, {1: _row(1), 2: _row(2), 3: _row(3, "NO_LAND")})

    assert _reads(sources) == [1, 2]
    assert candidates.numbers == [1, 2, 3]
    assert candidates.authors == {2: "Alice", 3: "alice"}
    assert candidates.updated_at == {1: _EVENT, 2: _EVENT, 3: RECENT}
    assert candidates.heads == listing.candidates.heads
    assert memory.view.records[1] == retargeted
    assert f"{TARGET_REPO}: wide tick rechecked 2 LAND PR(s) from GitHub" in caplog.text


def test_a_land_pr_whose_fresh_record_names_an_author_outside_the_cohort_loses_its_author_but_stays_in_the_view():
    sources, memory, listing = _wide(record(1))
    stored = memory.view.records[1]
    sources.single = {1: record(1, author="carol", updated_at=_EVENT)}

    candidates = _recheck(listing, memory, sources, {1: _row(1)})

    assert candidates.authors == {}
    assert memory.view.records[1] == stored


def test_a_land_pr_renamed_out_of_the_cohort_is_reread_and_loses_its_author_again_at_the_next_wide_tick():
    sources, memory, listing = _wide(record(1))
    sources.single = {1: record(1, author="carol")}

    first = _recheck(listing, memory, sources, {1: _row(1)})
    memory.mark_wide_tick(_NOW)
    memory = _round_trip(memory)
    later = _list(memory, sources, now=_NOW + FULL_TICK_INTERVAL)
    second = _recheck(later, memory, sources, {1: _row(1)})

    # The first tick's revoke failed, say: the stored view still holds PR1, so the next wide tick retries it.
    assert later.kind == "wide"
    assert later.candidates.authors == {1: "alice"}
    assert (first.authors, second.authors) == ({}, {})
    assert _reads(sources) == [1, 1]


def test_a_fresh_record_that_lags_the_listing_keeps_the_listed_updated_at():
    sources, memory, listing = _wide(record(1))
    sources.single = {1: record(1, updated_at=_IDLE)}

    assert _recheck(listing, memory, sources, {1: _row(1)}).updated_at == {1: RECENT}


@pytest.mark.parametrize(
    ("full_at", "kind"),
    [pytest.param(_NOW - timedelta(minutes=2), "fast", id="event"), pytest.param(_NOW - _SWEEP, "full", id="full")],
)
def test_only_a_wide_tick_rereads_its_land_prs(full_at, kind):
    sources = _Sources()
    sources.open = [record(1)]
    memory = _warm(record(1), full_at=full_at)
    listing = _list(memory, sources)
    sources.events.clear()

    assert listing.kind == kind
    assert _recheck(listing, memory, sources, {1: _row(1)}) is listing.candidates
    assert _reads(sources) == []


def test_a_scan_without_memory_rereads_nothing():
    sources = _Sources()
    listing = change_listing.Listing(candidate_fields([record(1)]), "wide", {})

    assert _recheck(listing, None, sources, {1: _row(1)}) is listing.candidates
    assert _reads(sources) == []


def test_a_candidate_whose_latest_row_is_not_a_land_is_not_read():
    sources, memory, listing = _wide(record(1), record(2))

    candidates = _recheck(listing, memory, sources, {1: _row(1, "NO_LAND")})

    assert _reads(sources) == []
    assert candidates == listing.candidates


def test_a_failed_reread_is_logged_and_keeps_the_pr_as_listed(caplog):
    sources, memory, listing = _wide(record(1))
    sources.single_errors = {1: RuntimeError("502 from GitHub")}

    with caplog.at_level(logging.INFO, logger="greenlight"):
        candidates = _recheck(listing, memory, sources, {1: _row(1)})

    assert candidates == listing.candidates
    [error] = [entry for entry in caplog.records if entry.levelno == logging.ERROR]
    assert error.getMessage() == f"{TARGET_REPO}: cannot read PR #1, whose latest recorded row is a LAND"
    assert error.exc_info is not None


def test_a_rate_limit_rereading_a_land_pr_raises():
    sources, memory, listing = _wide(record(1), record(2))
    error = GithubException(429, {"message": "secondary rate limit"})
    sources.single_errors = {1: error}

    with pytest.raises(GithubException) as raised:
        _recheck(listing, memory, sources, {1: _row(1), 2: _row(2)})

    assert raised.value is error
    assert _reads(sources) == [1]


def test_a_reread_that_names_no_author_or_finds_the_pr_closed_leaves_it_as_listed():
    sources, memory, listing = _wide(record(1), record(2))
    sources.single = {1: None, 2: replace(record(2), state="closed", base_accepted=False)}

    candidates = _recheck(listing, memory, sources, {1: _row(1), 2: _row(2)})

    assert _reads(sources) == [1, 2]
    assert candidates == listing.candidates
    assert sorted(memory.view.records) == [1, 2]


_GATE_CLICKHOUSE = replace(_CLICKHOUSE, safety="gate")


def _based(number: int, base_ref: str | None) -> OpenPR:
    return replace(record(number), base_ref=base_ref)


def test_a_gate_repos_full_tick_hands_an_author_only_to_its_prs_on_main():
    sources = _Sources()
    sources.open = [_based(1, "main"), _based(2, "gh/alice/1/base"), _based(3, None)]

    listing = _list(ScanMemory(), sources, entry=_GATE_CLICKHOUSE)

    assert listing.kind == "full"
    assert listing.candidates.numbers == [1, 2, 3]
    assert listing.candidates.authors == {1: "alice"}


def test_a_gate_repos_view_keeps_each_records_base_for_the_next_event_tick():
    sources = _Sources()
    sources.recent = [_based(4, "alice/part-1")]
    memory = _warm(_based(1, "main"), _based(2, "release/2.9"))

    listing = _list(memory, sources, entry=_GATE_CLICKHOUSE)

    assert listing.kind == "fast"
    assert memory.view.records[2].base_ref == "release/2.9"
    assert listing.candidates.numbers == [1, 2, 4]
    assert listing.candidates.authors == {1: "alice"}


@pytest.mark.parametrize(("safety", "authors"), [("pytorchbot", {1: "alice", 2: "alice"}), ("gate", {1: "alice"})])
def test_a_github_repo_takes_the_strict_base_only_when_its_safety_is_gate(safety, authors):
    sources = _Sources()
    sources.open = [_based(1, "main"), _based(2, "gh/alice/1/base")]

    listing = _list(None, sources, entry=replace(BUILTIN_PYTORCH, safety=safety))

    assert listing.candidates.authors == authors
