from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from datetime import timedelta
from typing import TYPE_CHECKING, Any

import pytest

from greenlight import constants, merge_authz
from greenlight.change_feed import EMPTY_MARKER, Marker
from greenlight.constants import TARGET_REPO
from greenlight.pr_view import READ_ALONE_MAX_ATTEMPTS, PRView, cohort_digest, marker_form, marker_from_form
from tests.change_helpers import NOW, record

if TYPE_CHECKING:
    from greenlight.pr_listing import OpenPR

_NOW = NOW
_WINDOW = timedelta(hours=24)
_COHORT = frozenset({"alice"})


def _built(*records: OpenPR, cohort: frozenset[str] = _COHORT) -> PRView:
    view = PRView()
    view.rebuild(records, _NOW, cohort)
    return view


def test_a_new_view_is_empty_and_not_built():
    view = PRView()

    assert (view.built, view.records, view.listed_at, view.digest) == (False, {}, None, None)
    assert view.candidates(_COHORT, now=_NOW, window=None) == []
    assert not view.usable(_COHORT)


def test_a_full_listing_replaces_every_record_and_forgets_the_markers_of_prs_it_no_longer_holds():
    view = _built(record(1), record(2))
    view.note({1: Marker(reviews=1), 2: Marker(reviews=2)}, _NOW)
    later = _NOW + timedelta(hours=4)

    view.rebuild([record(2, head_sha="sha2-pushed"), record(3)], later, _COHORT)

    assert view.built
    assert view.listed_at == later
    assert sorted(view.records) == [2, 3]
    assert view.records[2].head_sha == "sha2-pushed"
    assert view.seen(1) is None
    assert view.seen(2) == (Marker(reviews=2), _NOW)


def test_a_full_listing_keeps_only_the_cohorts_prs_drafts_included_and_records_the_cohorts_digest():
    view = PRView()

    view.rebuild([record(1), record(2, author="Carol", draft=True), record(3, author="dave")], _NOW, ["ALICE", "carol"])

    assert sorted(view.records) == [1, 2]
    assert view.digest == cohort_digest(["carol", "alice"])


def test_the_cohort_digest_is_the_sha256_of_the_sorted_lower_cased_logins():
    expected = hashlib.sha256(b"alice\nbob").hexdigest()

    assert cohort_digest(["Bob", "alice"]) == cohort_digest(iter(["ALICE", "bob"])) == expected


def test_a_view_is_usable_only_for_the_cohort_its_last_full_listing_had():
    view = _built(record(1), cohort=frozenset({"alice", "bob"}))

    assert view.usable(["BOB", "Alice"])
    assert not view.usable(["alice"])
    assert not view.usable(["alice", "bob", "carol"])


def test_only_a_full_listing_records_the_cohorts_digest():
    view = _built(record(1))
    digest = view.digest

    view.apply([record(2, author="carol")], _NOW + timedelta(minutes=2), ["alice", "carol"])

    assert view.digest == digest
    assert view.usable(_COHORT)
    assert not view.usable(["alice", "carol"])


def test_a_walk_before_any_full_listing_builds_a_view_no_cohort_can_use():
    view = PRView()

    view.apply([record(1)], _NOW, _COHORT)

    assert view.built
    assert view.digest is None
    assert not view.usable(_COHORT)


def test_the_recent_walk_updates_open_prs_and_removes_closed_and_merged_ones():
    view = _built(record(1), record(2), record(3))
    view.note({1: Marker(reviews=1), 2: Marker(reviews=1)}, _NOW)
    later = _NOW + timedelta(minutes=2)

    view.apply([record(1, state="closed"), record(3, draft=True), record(4)], later, _COHORT)

    assert view.listed_at == later
    assert sorted(view.records) == [2, 3, 4]
    assert view.records[3].draft
    assert view.seen(1) is None
    assert view.seen(2) == (Marker(reviews=1), _NOW)


def test_the_recent_walk_adds_only_the_cohorts_open_prs_and_removes_any_closed_pr_whoever_wrote_it():
    view = _built(record(1), record(2, author="carol"), cohort=frozenset({"alice", "carol"}))
    view.note({2: Marker(reviews=1)}, _NOW)
    view.record_read(2, _NOW, caught_up=False)

    view.apply([record(2, author="carol", state="closed"), record(3, author="dave"), record(4)], _NOW, _COHORT)

    assert sorted(view.records) == [1, 4]
    assert view.seen(2) is None
    assert view.to_form()["reads"] == []


def test_a_reopened_pr_comes_back_with_the_walk():
    view = _built(record(1))
    view.apply([record(1, state="closed")], _NOW + timedelta(minutes=2), _COHORT)

    view.apply([record(1)], _NOW + timedelta(minutes=4), _COHORT)

    assert [record.number for record in view.candidates(_COHORT, now=_NOW, window=_WINDOW)] == [1]


def test_a_marker_keeps_its_first_sight_until_its_value_changes():
    view = _built(record(1), record(2))
    later = _NOW + timedelta(minutes=2)

    assert view.note({1: EMPTY_MARKER, 2: Marker(comments=1)}, _NOW) == {1, 2}
    assert view.note({1: EMPTY_MARKER, 2: Marker(comments=2)}, later) == {2}

    assert view.seen(1) == (EMPTY_MARKER, _NOW)
    assert view.seen(2) == (Marker(comments=2), later)
    assert view.seen(3) is None


def test_the_candidates_are_the_records_is_candidate_admits_sorted_by_number():
    view = _built(
        record(5),
        record(2, author="Alice"),
        record(3, author="carol"),
        record(4, draft=True),
        cohort=frozenset({"alice", "carol"}),
    )

    assert [record.number for record in view.candidates({"ALICE"}, now=_NOW, window=None)] == [2, 5]


def test_a_window_keeps_only_the_prs_updated_inside_it_and_none_never_ages_out():
    view = _built(
        record(1, updated_at=_NOW - _WINDOW),
        record(2, updated_at=_NOW - _WINDOW + timedelta(seconds=1)),
        record(3, updated_at=None),
    )

    assert [record.number for record in view.candidates(_COHORT, now=_NOW, window=_WINDOW)] == [2, 3]
    assert [record.number for record in view.candidates(_COHORT, now=_NOW, window=None)] == [1, 2, 3]


def test_a_marker_newer_than_the_listed_update_moves_the_pr_into_the_window():
    idle = _NOW - timedelta(days=3)
    commented = _NOW - timedelta(minutes=5)
    view = _built(record(1, updated_at=idle), record(2, updated_at=idle), record(3, updated_at=None))
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


_EVENT = _NOW - timedelta(minutes=10)
_LATER_EVENT = _NOW - timedelta(minutes=1)


def test_pending_reads_come_never_attempted_first_by_number_then_by_oldest_attempt():
    view = _built(*(record(number) for number in range(1, 7)))
    view.record_read(2, _EVENT, caught_up=False)
    view.record_read(4, _EVENT, caught_up=False)
    view.record_read(2, _EVENT, caught_up=False)
    view.record_read(6, _EVENT, caught_up=True)

    # PR4's last attempt is older than PR2's second one, so PR4 goes first.
    assert view.pending_reads(dict.fromkeys((6, 5, 4, 3, 2, 1), _EVENT)) == [1, 3, 5, 4, 2]


def test_a_pr_acknowledged_at_one_marker_time_is_pending_again_at_a_new_one():
    view = _built(record(1), record(2))
    view.record_read(1, _EVENT, caught_up=True)
    view.record_read(2, _EVENT, caught_up=False)

    assert view.pending_reads({1: _EVENT, 2: _EVENT}) == [2]
    # At a new marker time PR1 has never been attempted, so it goes before PR2's attempt at the old one.
    assert view.pending_reads({1: _LATER_EVENT, 2: _LATER_EVENT}) == [1, 2]


def test_a_read_that_caught_up_acknowledges_its_marker_time():
    view = _built(record(1))

    assert view.record_read(1, _EVENT, caught_up=True) is False
    assert view.pending_reads({1: _EVENT}) == []


def test_a_read_that_keeps_lagging_gives_its_marker_time_up_at_the_fifth_attempt():
    view = _built(record(1))

    results = [view.record_read(1, _EVENT, caught_up=False) for _ in range(READ_ALONE_MAX_ATTEMPTS)]

    assert READ_ALONE_MAX_ATTEMPTS == 5
    assert results == [False, False, False, False, True]
    assert view.pending_reads({1: _EVENT}) == []
    assert view.record_read(1, _EVENT, caught_up=False) is False


def test_a_new_marker_time_restarts_the_attempt_count():
    view = _built(record(1))
    for _ in range(READ_ALONE_MAX_ATTEMPTS - 1):
        view.record_read(1, _EVENT, caught_up=False)

    assert view.record_read(1, _LATER_EVENT, caught_up=False) is False
    assert view.pending_reads({1: _LATER_EVENT}) == [1]
    assert [view.record_read(1, _LATER_EVENT, caught_up=False) for _ in range(3)] == [False, False, False]
    assert view.record_read(1, _LATER_EVENT, caught_up=False) is True


def test_a_full_listing_forgets_the_read_states_of_the_prs_it_no_longer_holds():
    view = _built(record(1), record(2))
    view.record_read(1, _EVENT, caught_up=False)
    view.record_read(2, _EVENT, caught_up=False)

    view.rebuild([record(2)], _NOW + timedelta(hours=4), _COHORT)

    assert [row[0] for row in view.to_form()["reads"]] == [2]
    assert view.to_form()["read_sequence"] == 2


def _stored(number: int, base_ref: str, head_ref: str, stack_trunk: str | None, **fields: Any) -> OpenPR:
    return replace(record(number, **fields), base_ref=base_ref, head_ref=head_ref, stack_trunk=stack_trunk)


def _full_view() -> PRView:
    view = _built(
        _stored(1, "main", "alice/fix", None, labels=("Stale", "ci-no-td")),
        _stored(2, "gh/alice/1/base", "gh/alice/1/head", None, draft=True, updated_at=None),
        _stored(3, "alice/part-1", "alice/part-2", "main"),
        replace(_stored(4, "release/2.9", "alice/backport", None), base_accepted=False),
        record(5),
    )
    view.note({1: Marker(_EVENT, 1, 2, 3, _LATER_EVENT), 3: EMPTY_MARKER}, _NOW - timedelta(minutes=4))
    view.record_read(1, _EVENT, caught_up=False)
    view.record_read(3, _EVENT, caught_up=True)
    return view


def _round_trip(view: PRView) -> PRView:
    return PRView.from_form(json.loads(json.dumps(view.to_form())), TARGET_REPO)


def test_the_codec_round_trips_the_view_without_titles_and_urls():
    view = _full_view()

    restored = _round_trip(view)

    assert (restored.listed_at, restored.digest) == (_NOW, cohort_digest(_COHORT))
    assert restored.usable(_COHORT)
    assert restored.records == {
        number: replace(original, title="", url=f"https://github.com/{TARGET_REPO}/pull/{number}")
        for number, original in view.records.items()
        if number != 5
    } | {5: replace(view.records[5], title="", url=f"https://github.com/{TARGET_REPO}/pull/5", base_accepted=None)}
    assert restored.seen(1) == (Marker(_EVENT, 1, 2, 3, _LATER_EVENT), _NOW - timedelta(minutes=4))
    assert restored.seen(3) == (EMPTY_MARKER, _NOW - timedelta(minutes=4))
    assert restored.pending_reads({1: _EVENT, 3: _EVENT}) == [1]
    assert restored.to_form() == view.to_form()
    restored.record_read(3, _LATER_EVENT, caught_up=False)
    assert restored.to_form()["read_sequence"] == 3


def test_the_codec_derives_base_accepted_from_the_stored_branch_names():
    restored = _round_trip(_full_view())

    # Main, a ghstack head, a native stack on main, another base; PR5 was stored with no branch names.
    assert [restored.records[number].base_accepted for number in range(1, 6)] == [True, True, True, False, None]


def test_a_changed_base_rule_reaches_every_stored_pr(monkeypatch):
    form = json.loads(json.dumps(_full_view().to_form()))
    monkeypatch.setattr(constants, "TARGET_BRANCH", "release/2.9")

    restored = PRView.from_form(form, TARGET_REPO)

    assert [restored.records[number].base_accepted for number in range(1, 5)] == [False, True, False, True]


def test_the_codec_asks_the_shared_base_rule(monkeypatch):
    asked: list[tuple[str, str, str | None]] = []

    def accepts_refs(base_ref: str, head_ref: str, stack_trunk: str | None) -> bool:
        asked.append((base_ref, head_ref, stack_trunk))
        return False

    monkeypatch.setattr(merge_authz, "accepts_refs", accepts_refs)

    restored = _round_trip(_full_view())

    assert {record.base_accepted for record in restored.records.values()} == {False, None}
    assert asked[0] == ("main", "alice/fix", None)
    assert len(asked) == 4


def test_an_empty_view_round_trips_unbuilt():
    restored = _round_trip(PRView())

    assert (restored.built, restored.records, restored.digest) == (False, {}, None)


@pytest.mark.parametrize(
    "marker",
    [EMPTY_MARKER, Marker(_EVENT, 1, 2, 3, _LATER_EVENT), Marker(comment_updated_at=_EVENT, comments=4)],
    ids=["empty", "full", "comment-only"],
)
def test_the_marker_encoding_round_trips(marker):
    assert marker_from_form(json.loads(json.dumps(marker_form(marker)))) == marker
