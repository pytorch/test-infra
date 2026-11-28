"""Pick a listing tick's kind and list its candidates, by the repo's change source.

``change_source`` and ``full_tick_minutes`` come from the repo's own ``.github/greenlight/config.yml``
(``repo_config``). A ``github`` repo, a ``--pr`` scan and a scan with no ``ScanMemory`` list as
``pr_listing`` describes: a full tick when the memory says one is due (always without a memory), a fast
one otherwise. A ``github`` repo's memory drops any view of its PRs and keeps ``FULL_TICK_INTERVAL``, so a
switch back to ``clickhouse`` starts with a full listing.

A ``clickhouse`` repo's memory carries a view of its evaluation cohort's open PRs (``pr_view``), which a
tick uses only while it is usable for the tick's cohort: built by a full listing of that same cohort. With
no usable view (a cold start, a memory stored without one or by an older release, a cohort change), the
sweep comes every ``FULL_TICK_INTERVAL``. Until it is due, the tick drops the view and is a fast tick
listed from GitHub as a ``github`` repo's, which reads nothing from HUD ClickHouse; once due, it is a full
tick, which reads only the tables' freshness before its listing. So a repo whose view is never stored
lists in full only every ``FULL_TICK_INTERVAL``, and a full listing that raises leaves the view it found.

With a usable view, the tick reads HUD ClickHouse's markers for every PR in it before the tick's first
GitHub read, then the tables' freshness and the repo's own newest issue comment, read afresh each tick.
The reading is fresh when both reads succeed, the tables and the repo are not stale
(``change_feed.Freshness.problem``), and, while the view holds open PRs, at least one of them has a row.
Fresh, the repo's sweep comes every ``full_tick_minutes``; otherwise every ``FULL_TICK_INTERVAL``, as a
``github`` repo's full tick. HUD ClickHouse is read under
``CHANGE_FEED_DEADLINE_SECONDS`` (``change_feed.call_bounded``): the markers and freshness a usable view
reads before the listings share one deadline, while the freshness a full tick with no usable view reads
and the markers a full tick reads after its listing have one each. A failed or unfinished reading is
logged as an error and treated as stale; an ``IterationTimeout`` propagates. GitHub reads are not bounded.

- **full**, when the view is not usable or the sweep is due: lists every open PR, rebuilds the view for
  the cohort, reads the rebuilt view's markers (so a cold start first sees them at this tick), and hands
  the scan every candidate in it.
- **wide**, when ``ScanMemory.wide_due``: every candidate in the view, with no recency window.
- **event** (a fast tick), otherwise: the candidates in the view whose effective ``updated_at`` is
  inside the review window.

Every tick but a full one first walks every PR, open or closed, updated since the previous listing's
start less ``LISTING_OVERLAP`` into the view (a failing walk raises and leaves that start as it was).
While the reading is fresh, it then reads alone, at most ``_STALE_RECORD_READS``, the PRs whose marker
shows a ``pull_request`` event newer than their record (a close, a label, a draft marked ready, a base
change the walk missed), in ``PRView.pending_reads`` order: those never tried at that event first, then
the oldest attempt first, so a PR whose read keeps failing goes behind the rest. A read that returns a
record at or past the event (or no record) catches up and acknowledges it; one still behind it, or a
failed read (logged), stays pending for the next tick, until ``pr_view.READ_ALONE_MAX_ATTEMPTS`` attempts
at that event give it up with a warning. A rate limit raises as a listing's does. Last it adds the open
``Reverted`` PRs to its candidates without writing them into the view; a PR in both keeps the
``Reverted`` copy. The tick hands the scan each candidate's marker as the view last read it, None for a
PR it never read, and logs one line naming its kind, its source and its counts, the fast tick with no
usable view included (its source ``GitHub, no usable view``).

The scan judges a candidate's base and author from the view's record, which a base change both the walk
and HUD missed leaves stale until the sweep. So on a wide tick ``recheck_landed`` reads alone each
candidate whose latest recorded row is a LAND, once ``review.prepare`` has read the rows: a refused base
then reaches the ineligible revoke within ``FULL_TICK_INTERVAL``, as on a ``github`` repo.
"""

from __future__ import annotations

import functools
import logging
from datetime import timedelta
from typing import TYPE_CHECKING, NamedTuple

from greenlight import change_feed, github_client, pr_listing
from greenlight.change_feed import EMPTY_MARKER
from greenlight.constants import CHANGE_FEED_DEADLINE_SECONDS, FULL_TICK_INTERVAL, LISTING_OVERLAP, STATUS_LAND
from greenlight.guards import IterationTimeout
from greenlight.pr_listing import candidate_fields, candidate_numbers, lowered
from greenlight.pr_view import READ_ALONE_MAX_ATTEMPTS, PRView

if TYPE_CHECKING:
    from collections.abc import Callable, Collection, Mapping
    from datetime import datetime
    from typing import Protocol

    from github import Github

    from greenlight.change_feed import Freshness, Marker
    from greenlight.pr_listing import Candidates, FetchFn, FetchUpdatedFn, OpenPR
    from greenlight.repo_config import RepoEntry
    from greenlight.scan_memory import ScanMemory, TickKind
    from greenlight.state import PRState

    ReadMarkersFn = Callable[[str, Collection[int]], Mapping[int, Marker]]
    ReadFreshnessFn = Callable[[str], Freshness]
    ListOpenFn = Callable[[Github, str], list[OpenPR]]

    class ListRecentFn(Protocol):
        def __call__(self, client: Github, repo: str, *, cutoff: datetime) -> list[OpenPR]: ...

    ListRevertedFn = Callable[[Github, str, frozenset[str]], list[OpenPR]]
    ReadRecordFn = Callable[[Github, str, int], OpenPR | None]
    Reading = tuple[Mapping[int, Marker] | None, str | None]

logger = logging.getLogger(__name__)

_MARKERS_FAILED = "the marker reading failed"
_FRESHNESS_FAILED = "the freshness reading failed"
_UNFINISHED = "the reading did not finish in time"
_NO_USABLE_VIEW = "no usable view"
_NOT_COVERED = "no open PR of the repo has a row"
_STALE_RECORD_READS = 20


class Listing(NamedTuple):
    """The tick's candidates, its kind and each candidate's marker as the view last read it."""

    candidates: Candidates
    kind: TickKind
    markers: Mapping[int, tuple[Marker, datetime] | None]


def list_candidates(
    client: Github,
    *,
    entry: RepoEntry,
    pr: int | None,
    authors: frozenset[str],
    memory: ScanMemory | None,
    now: datetime,
    window: timedelta,
    fetch: FetchFn,
    fetch_updated: FetchUpdatedFn,
    read_markers: ReadMarkersFn = change_feed.read_markers,
    read_freshness: ReadFreshnessFn = change_feed.read_freshness,
    list_open: ListOpenFn = pr_listing.list_open_records,
    list_recent: ListRecentFn = pr_listing.list_recent_records,
    list_reverted: ListRevertedFn = pr_listing.list_reverted_prs,
    read_record: ReadRecordFn = pr_listing.read_record,
) -> Listing:
    """List the tick's candidates; ``now`` is the clock read before any of the tick's listings, ``authors``
    the tick's evaluation cohort.

    A ``gate`` repo's candidates take the strict base rule (``pr_listing.candidate_fields``).
    """
    repo = entry.repo
    strict_base = entry.strict_base
    clickhouse = entry.change_source == "clickhouse" and pr is None
    usable = memory is not None and memory.view.usable(authors)
    if memory is not None and clickhouse and not usable:
        memory.full_tick_interval = FULL_TICK_INTERVAL
    if not clickhouse or memory is None or (not usable and not memory.sweep_due(now)):
        if memory is not None and (entry.change_source == "github" or pr is None):
            memory.full_tick_interval = FULL_TICK_INTERVAL
            memory.view = PRView()
        full_tick = memory is None or memory.full_tick_due(now)
        candidates = candidate_numbers(
            client,
            repo=repo,
            pr=pr,
            authors=authors,
            fetch=fetch,
            cutoff=None if full_tick else now - window,
            fetch_updated=fetch_updated,
            strict_base=strict_base,
        )
        if memory is not None and clickhouse:
            listed = len(candidates.numbers)
            _log_tick(repo, "fast", f"GitHub, {_NO_USABLE_VIEW}", listed=listed, reads=0, picked=listed, changed=0)
        return Listing(candidates, "full" if full_tick else "fast", {})
    view = memory.view
    if usable:
        markers, stale = _reading(read_markers, read_freshness, repo, view)
    else:
        markers, stale = None, _freshness_problem(_bounded(read_freshness), repo)
    memory.full_tick_interval = FULL_TICK_INTERVAL if stale is not None else timedelta(minutes=entry.full_tick_minutes)
    changed = set() if markers is None else view.note(markers, now)
    previous = view.listed_at
    reads = 0
    kind: TickKind
    if previous is None or not usable or memory.sweep_due(now):
        kind = "full"
        records = list_open(client, repo)
        view.rebuild(records, now, authors)
        rebuilt = _read_markers(_bounded(read_markers), repo, view.records)
        if rebuilt is None:
            stale = stale or _MARKERS_FAILED
        else:
            changed |= view.note(rebuilt, now)
        picked = view.candidates(authors, now=now, window=None)
    else:
        kind = "wide" if memory.wide_due(now) else "fast"
        records = list_recent(client, repo, cutoff=previous - LISTING_OVERLAP)
        view.apply(records, now, authors)
        if stale is None and markers is not None:
            reads = _refresh_stale_records(client, repo, view, markers, authors, read_record, now)
        reverted = list_reverted(client, repo, authors)
        records = [*records, *reverted]
        by_number = {
            record.number: record
            for record in view.candidates(authors, now=now, window=None if kind == "wide" else window)
        }
        by_number.update((record.number, record) for record in reverted)
        picked = [by_number[number] for number in sorted(by_number)]
    source = "ClickHouse" if stale is None else f"GitHub, stale: {stale}"
    _log_tick(repo, kind, source, listed=len(records), reads=reads, picked=len(picked), changed=len(changed))
    markers_seen = {record.number: view.seen(record.number) for record in picked}
    return Listing(candidate_fields(picked, strict_base=strict_base), kind, markers_seen)


def recheck_landed(
    client: Github,
    *,
    repo: str,
    listing: Listing,
    states: Mapping[int, PRState],
    memory: ScanMemory | None,
    authors: frozenset[str],
    now: datetime,
    read_record: ReadRecordFn = pr_listing.read_record,
) -> Candidates:
    """``listing``'s candidates, each LAND PR's author and ``updated_at`` read afresh from GitHub on a wide tick.

    ``authors`` is the tick's evaluation cohort and ``now`` the clock its listing started at. Any other tick
    returns the candidates as listed. On a wide tick each candidate whose latest recorded row in ``states``
    is a LAND is read alone. The PR loses its author when its base is refused or its author is outside the
    cohort, so the ineligible revoke reaches it, else takes the record's author and the later ``updated_at``.
    An open record by a cohort author goes into the view; one by another author leaves the view's record as
    it was, so a revoke that fails is retried at every wide tick until the sweep's rebuild drops the PR. A
    failed read (logged) or a record that is None or closed leaves the PR as listed; a rate limit raises.
    """
    candidates = listing.candidates
    if listing.kind != "wide" or memory is None:
        return candidates
    landed = [
        number for number in candidates.numbers if (row := states.get(number)) is not None and row.status == STATUS_LAND
    ]
    cohort = lowered(authors)
    authored, updated_at = dict(candidates.authors), dict(candidates.updated_at)
    for number in landed:
        _read, record = _read_alone(client, repo, number, read_record, "whose latest recorded row is a LAND")
        if record is None or record.state != "open":
            continue
        in_cohort = record.author.lower() in cohort
        if in_cohort:
            memory.view.apply([record], now, authors)
        if record.base_accepted is False or not in_cohort:
            authored.pop(number, None)
        else:
            authored[number] = record.author
        listed = updated_at.get(number)
        if listed is not None and record.updated_at is not None and record.updated_at > listed:
            updated_at[number] = record.updated_at
    logger.info("%s: wide tick rechecked %d LAND PR(s) from GitHub", repo, len(landed))
    return candidates._replace(authors=authored, updated_at=updated_at)


def _refresh_stale_records(
    client: Github,
    repo: str,
    view: PRView,
    markers: Mapping[int, Marker],
    authors: frozenset[str],
    read_record: ReadRecordFn,
    now: datetime,
) -> int:
    """Read alone the cohort PRs whose marker shows a ``pull_request`` event their record lacks; how many reads."""
    cohort = lowered(authors)
    stale = {
        number: missed
        for number, record in view.records.items()
        if record.author.lower() in cohort and (missed := _missed_event(record, markers.get(number))) is not None
    }
    reads = 0
    for number in view.pending_reads(stale)[:_STALE_RECORD_READS]:
        missed = stale[number]
        reads += 1
        read, record = _read_alone(client, repo, number, read_record, "whose marker is newer than its record")
        caught_up = read and (record is None or (record.updated_at is not None and record.updated_at >= missed))
        if view.record_read(number, missed, caught_up=caught_up):
            logger.warning(
                "%s: gave up reading PR #%d alone at its marker's pull_request event of %s after %d attempts",
                repo,
                number,
                missed,
                READ_ALONE_MAX_ATTEMPTS,
            )
        if record is not None:
            view.apply([record], now, authors)
    return reads


def _read_alone(
    client: Github, repo: str, number: int, read_record: ReadRecordFn, why: str
) -> tuple[bool, OpenPR | None]:
    """Whether PR ``number`` was read alone, and its record; a failed read is logged, ``why`` naming the PR, and a
    rate limit raises."""
    try:
        return True, read_record(client, repo, number)
    except IterationTimeout:
        raise
    except Exception as exc:
        if github_client.is_rate_limit_error(exc):
            raise
        logger.error("%s: cannot read PR #%d, %s", repo, number, why, exc_info=True)
        return False, None


def _log_tick(repo: str, kind: TickKind, source: str, *, listed: int, reads: int, picked: int, changed: int) -> None:
    logger.info(
        "%s: %s tick from %s; %d PR(s) listed, %d read alone, %d candidate(s), %d PR(s) whose marker changed",
        repo,
        "event" if kind == "fast" else kind,
        source,
        listed,
        reads,
        picked,
        changed,
    )


def _missed_event(record: OpenPR, marker: Marker | None) -> datetime | None:
    """The marker's ``pull_request`` event when the record lacks it, else None."""
    newest = None if marker is None else marker.pr_updated_at
    if newest is None or record.updated_at is None or newest <= record.updated_at:
        return None
    return newest


def _bounded[T](fn: Callable[..., T]) -> Callable[..., T]:
    """``fn``, its every call run under ``CHANGE_FEED_DEADLINE_SECONDS`` (``change_feed.call_bounded``)."""
    return functools.partial(change_feed.call_bounded, fn, seconds=CHANGE_FEED_DEADLINE_SECONDS)


def _reading(read_markers: ReadMarkersFn, read_freshness: ReadFreshnessFn, repo: str, view: PRView) -> Reading:
    """The built view's markers (None when they cannot be read in time), and why the reading is stale.

    Both reads run within one deadline; one that does not finish in it leaves the reading without markers.
    """
    numbers = sorted(view.records)
    try:
        return _bounded(_markers_then_freshness)(read_markers, read_freshness, repo, numbers)
    except IterationTimeout:
        raise
    except Exception:
        logger.error(
            "%s: cannot read the HUD ClickHouse markers of %d PR(s) and the tables' freshness in time",
            repo,
            len(numbers),
            exc_info=True,
        )
        return None, _UNFINISHED


def _markers_then_freshness(
    read_markers: ReadMarkersFn, read_freshness: ReadFreshnessFn, repo: str, numbers: list[int]
) -> Reading:
    markers = _read_markers(read_markers, repo, numbers)
    if markers is None:
        return None, _MARKERS_FAILED
    stale = _freshness_problem(read_freshness, repo)
    if stale is None and markers and all(marker == EMPTY_MARKER for marker in markers.values()):
        stale = _NOT_COVERED
    return markers, stale


def _read_markers(read_markers: ReadMarkersFn, repo: str, numbers: Collection[int]) -> Mapping[int, Marker] | None:
    """The markers of ``numbers``, or None when the reading failed (logged)."""
    try:
        return read_markers(repo, sorted(numbers))
    except IterationTimeout:
        raise
    except Exception:
        logger.error("%s: cannot read the HUD ClickHouse markers of %d PR(s)", repo, len(numbers), exc_info=True)
        return None


def _freshness_problem(read_freshness: ReadFreshnessFn, repo: str) -> str | None:
    """Why HUD ClickHouse's webhook tables count as stale for ``repo``, or None when they are fresh; a failure is
    logged."""
    try:
        return read_freshness(repo).problem()
    except IterationTimeout:
        raise
    except Exception:
        logger.error("cannot read the freshness of HUD ClickHouse's webhook tables", exc_info=True)
        return _FRESHNESS_FAILED
