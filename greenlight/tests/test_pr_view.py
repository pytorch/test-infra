from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta

from greenlight.change_feed import EMPTY_MARKER, Marker
from greenlight.constants import TARGET_REPO
from greenlight.pr_listing import OpenPR
from greenlight.pr_view import PRView

_NOW = datetime(2026, 11, 17, 12, 0, 0)
_WINDOW = timedelta(hours=24)
_COHORT = frozenset({"alice"})


def _record(
    number: int,
    *,
    author: str = "alice",
    updated_at: datetime | None = _NOW - timedelta(hours=1),
    draft: bool = False,
    state: str = "open",
) -> OpenPR:
    return OpenPR(
        TARGET_REPO, number, author, f"fix {number}", f"url{number}", f"sha{number}", updated_at, True, (), draft, state
    )


def _built(*records: OpenPR) -> PRView:
    view = PRView()
    view.rebuild(records, _NOW)
    return view


def test_a_new_view_is_empty_and_not_built():
    view = PRView()

    assert (view.built, view.records, view.listed_at) == (False, {}, None)
    assert view.candidates(_COHORT, now=_NOW, window=None) == []


def test_a_full_listing_replaces_every_record_and_forgets_the_markers_of_prs_it_no_longer_holds():
    view = _built(_record(1), _record(2))
    view.note({1: Marker(reviews=1), 2: Marker(reviews=2)}, _NOW)
    later = _NOW + timedelta(hours=4)

    view.rebuild([_record(2, author="carol"), _record(3)], later)

    assert view.built
    assert view.listed_at == later
    assert sorted(view.records) == [2, 3]
    assert view.records[2].author == "carol"
    assert view.seen(1) is None
    assert view.seen(2) == (Marker(reviews=2), _NOW)


def test_the_recent_walk_updates_open_prs_and_removes_closed_and_merged_ones():
    view = _built(_record(1), _record(2), _record(3))
    view.note({1: Marker(reviews=1), 2: Marker(reviews=1)}, _NOW)
    later = _NOW + timedelta(minutes=2)

    view.apply([_record(1, state="closed"), _record(3, draft=True), _record(4)], later)

    assert view.listed_at == later
    assert sorted(view.records) == [2, 3, 4]
    assert view.records[3].draft
    assert view.seen(1) is None
    assert view.seen(2) == (Marker(reviews=1), _NOW)


def test_a_reopened_pr_comes_back_with_the_walk():
    view = _built(_record(1))
    view.apply([_record(1, state="closed")], _NOW + timedelta(minutes=2))

    view.apply([_record(1)], _NOW + timedelta(minutes=4))

    assert [record.number for record in view.candidates(_COHORT, now=_NOW, window=_WINDOW)] == [1]


def test_a_marker_keeps_its_first_sight_until_its_value_changes():
    view = _built(_record(1), _record(2))
    later = _NOW + timedelta(minutes=2)

    assert view.note({1: EMPTY_MARKER, 2: Marker(comments=1)}, _NOW) == {1, 2}
    assert view.note({1: EMPTY_MARKER, 2: Marker(comments=2)}, later) == {2}

    assert view.seen(1) == (EMPTY_MARKER, _NOW)
    assert view.seen(2) == (Marker(comments=2), later)
    assert view.seen(3) is None


def test_the_candidates_are_the_records_is_candidate_admits_sorted_by_number():
    view = _built(_record(5), _record(2, author="Alice"), _record(3, author="carol"), _record(4, draft=True))

    assert [record.number for record in view.candidates({"ALICE"}, now=_NOW, window=None)] == [2, 5]


def test_a_window_keeps_only_the_prs_updated_inside_it_and_none_never_ages_out():
    view = _built(
        _record(1, updated_at=_NOW - _WINDOW),
        _record(2, updated_at=_NOW - _WINDOW + timedelta(seconds=1)),
        _record(3, updated_at=None),
    )

    assert [record.number for record in view.candidates(_COHORT, now=_NOW, window=_WINDOW)] == [2, 3]
    assert [record.number for record in view.candidates(_COHORT, now=_NOW, window=None)] == [1, 2, 3]


def test_a_marker_newer_than_the_listed_update_moves_the_pr_into_the_window():
    idle = _NOW - timedelta(days=3)
    commented = _NOW - timedelta(minutes=5)
    view = _built(_record(1, updated_at=idle), _record(2, updated_at=idle), _record(3, updated_at=None))
    view.note(
        {1: Marker(comments=1, comment_updated_at=commented), 2: Marker(pr_updated_at=idle - timedelta(hours=1))},
        _NOW,
    )
    view.note({3: Marker(pr_updated_at=commented)}, _NOW)

    window = view.candidates(_COHORT, now=_NOW, window=_WINDOW)
    wide = view.candidates(_COHORT, now=_NOW, window=None)

    # A list position that lagged leaves PR1's listed updated_at days old; its marker's newest non-bot
    # comment is the update the scan judges it by. PR2's older marker changes nothing, and PR3, listed
    # with no updated_at, keeps none.
    assert window == [replace(view.records[1], updated_at=commented), view.records[3]]
    assert wide == [replace(view.records[1], updated_at=commented), view.records[2], view.records[3]]
    assert view.records[1].updated_at == idle


def test_clear_forgets_everything():
    view = _built(_record(1))
    view.note({1: Marker(reviews=1)}, _NOW)

    view.clear()

    assert (view.built, view.records, view.listed_at, view.seen(1)) == (False, {}, None, None)
