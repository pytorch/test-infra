"""Pick a listing tick's kind and list its candidates, by the repo's change source (``repos.yaml``).

A ``github`` repo, a ``--pr`` scan and a scan with no ``ScanMemory`` list as ``pr_listing`` describes:
a full tick when the memory says one is due (always without a memory), a fast one otherwise. A
``github`` repo's memory drops any view of its PRs and keeps ``FULL_TICK_INTERVAL``, so a switch back
to ``clickhouse`` starts with a full listing.

A ``clickhouse`` repo with a memory reads HUD ClickHouse's markers for every PR in its view
(``pr_view``) before the tick's first GitHub read, then the tables' freshness, read afresh each tick.
The reading is fresh when both reads succeed, the tables are not stale
(``change_feed.Freshness.problem``), and, while the view holds open PRs, at least one of them has a
row. Fresh, the repo's sweep comes every ``full_tick_minutes``; otherwise every ``FULL_TICK_INTERVAL``,
as a ``github`` repo's full tick. A failed reading is logged as an error and treated as stale; an
``IterationTimeout`` propagates.

- **full**, when the view is not built or the sweep is due: lists every open PR, rebuilds the view,
  reads the rebuilt view's markers (so a cold start first sees them at this tick), and hands the scan
  every candidate in it.
- **wide**, when ``ScanMemory.wide_due``: every candidate in the view, with no recency window.
- **event** (a fast tick), otherwise: the candidates in the view whose effective ``updated_at`` is
  inside the review window.

Every tick but a full one first walks every PR, open or closed, updated since the previous listing's
start less ``LISTING_OVERLAP`` into the view (a failing walk raises and leaves that start as it was).
While the reading is fresh, it then reads alone, lowest number first and at most
``_STALE_RECORD_READS``, each cohort PR whose marker shows a ``pull_request`` event newer than its
record (a close, a label, a draft marked ready, a base change the walk missed) and that it has not
read alone at that event already; a failed read is logged and retried next tick, a rate limit raises
as a listing's does, and the PRs left wait for the next tick. Last it adds
the open ``Reverted`` PRs to its candidates without writing them into the view; a PR in both keeps the
``Reverted`` copy. The tick hands the scan each candidate's marker as the view last read it, None for
a PR it never read, and logs one line naming its kind, its source and its counts.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import TYPE_CHECKING, NamedTuple

from greenlight import change_feed, github_client, pr_listing
from greenlight.change_feed import EMPTY_MARKER
from greenlight.constants import FULL_TICK_INTERVAL, LISTING_OVERLAP
from greenlight.guards import IterationTimeout
from greenlight.pr_listing import candidate_fields, candidate_numbers, lowered
from greenlight.pr_view import PRView

if TYPE_CHECKING:
    from collections.abc import Callable, Collection, Mapping
    from datetime import datetime

    from github import Github

    from greenlight.change_feed import Freshness, Marker
    from greenlight.pr_listing import Candidates, FetchFn, FetchUpdatedFn, OpenPR
    from greenlight.repo_config import RepoEntry
    from greenlight.scan_memory import ScanMemory, TickKind

    ReadMarkersFn = Callable[[str, Collection[int]], Mapping[int, Marker]]
    ListOpenFn = Callable[[Github, str], list[OpenPR]]
    ListRecentFn = Callable[..., list[OpenPR]]
    ListRevertedFn = Callable[[Github, str, frozenset[str]], list[OpenPR]]
    ReadRecordFn = Callable[[Github, str, int], OpenPR | None]

logger = logging.getLogger(__name__)

_MARKERS_FAILED = "the marker reading failed"
_FRESHNESS_FAILED = "the freshness reading failed"
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
    read_freshness: Callable[[], Freshness] = change_feed.read_freshness,
    list_open: ListOpenFn = pr_listing.list_open_records,
    list_recent: ListRecentFn = pr_listing.list_recent_records,
    list_reverted: ListRevertedFn = pr_listing.list_reverted_prs,
    read_record: ReadRecordFn = pr_listing.read_record,
) -> Listing:
    """List the tick's candidates; ``now`` is the clock read before any of the tick's listings."""
    if entry.change_source == "github" or memory is None or pr is not None:
        if memory is not None and entry.change_source == "github":
            memory.full_tick_interval = FULL_TICK_INTERVAL
            memory.view = PRView()
        full_tick = memory is None or memory.full_tick_due(now)
        candidates = candidate_numbers(
            client,
            repo=entry.repo,
            pr=pr,
            authors=authors,
            fetch=fetch,
            cutoff=None if full_tick else now - window,
            fetch_updated=fetch_updated,
        )
        return Listing(candidates, "full" if full_tick else "fast", {})
    repo = entry.repo
    view = memory.view
    markers, stale = _reading(read_markers, read_freshness, repo, view)
    memory.full_tick_interval = FULL_TICK_INTERVAL if stale is not None else timedelta(minutes=entry.full_tick_minutes)
    changed = set() if markers is None else view.note(markers, now)
    previous = view.listed_at
    reads = 0
    kind: TickKind
    if previous is None or memory.sweep_due(now):
        kind = "full"
        records = list_open(client, repo)
        view.rebuild(records, now)
        rebuilt = _read_markers(read_markers, repo, view.records)
        if rebuilt is None:
            stale = stale or _MARKERS_FAILED
        else:
            changed |= view.note(rebuilt, now)
        picked = view.candidates(authors, now=now, window=None)
    else:
        kind = "wide" if memory.wide_due(now) else "fast"
        records = list_recent(client, repo, cutoff=previous - LISTING_OVERLAP, state="all")
        view.apply(records, now)
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
    logger.info(
        "%s: %s tick from %s; %d PR(s) listed, %d read alone, %d candidate(s), %d PR(s) whose marker changed",
        repo,
        "event" if kind == "fast" else kind,
        source,
        len(records),
        reads,
        len(picked),
        len(changed),
    )
    return Listing(candidate_fields(picked), kind, {record.number: view.seen(record.number) for record in picked})


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
    stale = [
        (number, missed)
        for number, record in sorted(view.records.items())
        if record.author.lower() in cohort
        and (missed := _missed_event(record, markers.get(number), view.read_alone_at(number))) is not None
    ]
    reads = 0
    for number, missed in stale[:_STALE_RECORD_READS]:
        reads += 1
        try:
            record = read_record(client, repo, number)
        except IterationTimeout:
            raise
        except Exception as exc:
            if github_client.is_rate_limit_error(exc):
                raise
            logger.error("%s: cannot read PR #%d, whose marker is newer than its record", repo, number, exc_info=True)
            continue
        view.read_alone(number, missed)
        if record is not None:
            view.apply([record], now)
    return reads


def _missed_event(record: OpenPR, marker: Marker | None, read_alone_at: datetime | None) -> datetime | None:
    """The marker's ``pull_request`` event when the record lacks it and the PR was not read alone at it, else None."""
    newest = None if marker is None else marker.pr_updated_at
    if newest is None or record.updated_at is None or newest <= record.updated_at or newest == read_alone_at:
        return None
    return newest


def _reading(
    read_markers: ReadMarkersFn, read_freshness: Callable[[], Freshness], repo: str, view: PRView
) -> tuple[Mapping[int, Marker] | None, str | None]:
    """The view's markers (None before it is built or when they cannot be read), and why the reading is stale."""
    if not view.built:
        return None, _freshness_problem(read_freshness)
    markers = _read_markers(read_markers, repo, view.records)
    if markers is None:
        return None, _MARKERS_FAILED
    stale = _freshness_problem(read_freshness)
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


def _freshness_problem(read_freshness: Callable[[], Freshness]) -> str | None:
    """Why HUD ClickHouse's webhook tables count as stale, or None when they are fresh; a failure is logged."""
    try:
        return read_freshness().problem()
    except IterationTimeout:
        raise
    except Exception:
        logger.error("cannot read the freshness of HUD ClickHouse's webhook tables", exc_info=True)
        return _FRESHNESS_FAILED
