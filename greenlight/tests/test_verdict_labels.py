from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

import pytest
from github import GithubException, UnknownObjectException

from greenlight import verdict_labels
from greenlight.constants import (
    DEFAULT_TIMEOUT_MINUTES,
    GL_APPROVED_LABEL,
    GL_HUMAN_LABEL,
    GL_SUPERSEDED_LABEL,
    STATUS_AI_REVIEW_DISPATCHED,
    STATUS_AI_REVIEW_STARTED,
    STATUS_CANCELLED,
    STATUS_FAILED,
    STATUS_LAND,
    STATUS_NO_LAND,
    STATUS_REVERTED,
)
from greenlight.state import PRState

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

_LISTED_AT = datetime(2026, 10, 15, 12, 0, 0)
_IN_TIME = timedelta(seconds=10)
_NOW = _LISTED_AT + _IN_TIME
_TIMEOUT = timedelta(minutes=DEFAULT_TIMEOUT_MINUTES)
_HEAD = "a" * 40
_REWORKED = "b" * 40
_EARLIER = "c" * 40


def _row(status: str, *, head: str = _HEAD, run_id: int = 1, age: timedelta = timedelta(hours=1)) -> PRState:
    return PRState(pr_number=1, status=status, eval_hash="e" * 64, head_sha=head, version=_NOW - age, run_id=run_id)


_LAND = _row(STATUS_LAND)
_NO_LAND = _row(STATUS_NO_LAND)
_LAND_EARLIER = _row(STATUS_LAND, head=_EARLIER)
_NO_LAND_EARLIER = _row(STATUS_NO_LAND, head=_EARLIER)


def _label_gone() -> GithubException:
    body = {
        "message": "Label does not exist",
        "documentation_url": "https://docs.github.com/rest/issues/labels#remove-a-label-from-an-issue",
        "status": "404",
    }
    return GithubException(404, body, message="Label does not exist")


class _FakeLabel:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakePR:
    """A PR's labels and the label writes made to it, one entry per write call.

    ``fail`` makes reading the labels, a removal or an add raise.
    """

    def __init__(self, labels: Sequence[str] = (), *, fail: Mapping[str, Exception] | None = None) -> None:
        self._labels = list(labels)
        self._fail = dict(fail or {})
        self.calls: list[tuple[str, ...]] = []

    @property
    def labels(self) -> list[_FakeLabel]:
        self._raise_if_failing("labels")
        return [_FakeLabel(name) for name in self._labels]

    def remove_from_labels(self, label: str) -> None:
        self.calls.append(("remove", label))
        self._raise_if_failing("remove")
        self._labels.remove(label)

    def add_to_labels(self, *labels: str) -> None:
        self.calls.append(("add", *labels))
        self._raise_if_failing("add")
        self._labels.extend(labels)

    def _raise_if_failing(self, step: str) -> None:
        error = self._fail.get(step)
        if error is not None:
            raise error


def _desired(
    gate: PRState | None,
    verdict: PRState | None,
    head: str | None = _HEAD,
    *,
    reverted: bool = False,
    eligible: bool = False,
    ineligible: bool = False,
    final: bool = False,
) -> frozenset[str] | None:
    return verdict_labels.desired_labels(
        gate,
        verdict,
        head,
        reverted=reverted,
        eligible=eligible,
        ineligible=ineligible,
        final=final,
        now=_NOW,
        timeout=_TIMEOUT,
    )


def test_a_land_shows_gl_approved_and_a_no_land_gl_human():
    assert verdict_labels.verdict_label(STATUS_LAND) == GL_APPROVED_LABEL
    assert verdict_labels.verdict_label(STATUS_NO_LAND) == GL_HUMAN_LABEL


@pytest.mark.parametrize(
    "status",
    [STATUS_REVERTED, STATUS_FAILED, STATUS_CANCELLED, STATUS_AI_REVIEW_STARTED, STATUS_AI_REVIEW_DISPATCHED],
)
def test_no_other_status_has_a_verdict_label(status):
    with pytest.raises(KeyError):
        verdict_labels.verdict_label(status)


@pytest.mark.parametrize(
    "gate",
    [
        pytest.param(None, id="no-rows"),
        pytest.param(_row(STATUS_FAILED), id="failed-run-only"),
        pytest.param(_row(STATUS_AI_REVIEW_STARTED), id="aged-out-run-only"),
        pytest.param(_row(STATUS_REVERTED), id="reverted-row-only"),
    ],
)
@pytest.mark.parametrize("reverted", [False, True])
def test_a_pr_without_an_authoritative_verdict_keeps_its_labels(gate, reverted):
    assert _desired(gate, None, reverted=reverted, ineligible=True, final=True) is None


@pytest.mark.parametrize(
    "gate",
    [
        pytest.param(_LAND, id="verdict-still-on-top"),
        pytest.param(_row(STATUS_AI_REVIEW_STARTED, run_id=2, age=timedelta(hours=3)), id="aged-out-run-on-top"),
        pytest.param(_row(STATUS_FAILED, run_id=2), id="failed-run-on-top"),
    ],
)
def test_a_reverted_pr_keeps_its_labels_until_its_gate_row_is_the_reverted_row(gate):
    assert _desired(gate, _LAND, reverted=True, final=True) is None


@pytest.mark.parametrize(("verdict", "label"), [(_LAND, GL_APPROVED_LABEL), (_NO_LAND, GL_HUMAN_LABEL)])
@pytest.mark.parametrize(
    "head",
    [
        pytest.param(_HEAD, id="still-at-the-reverted-head"),
        pytest.param(_REWORKED, id="reworked"),
        pytest.param(None, id="listed-without-a-head"),
    ],
)
@pytest.mark.parametrize(
    "flags",
    [
        pytest.param({}, id="undetermined"),
        pytest.param({"eligible": True}, id="eligible"),
        pytest.param({"ineligible": True, "final": True}, id="ineligible"),
    ],
)
def test_a_reverted_pr_carries_its_verdict_label_beside_superseded_when_the_verdict_was_on_the_reverted_head(
    verdict, label, head, flags
):
    gate = _row(STATUS_REVERTED, head=verdict.head_sha, run_id=2)

    assert _desired(gate, verdict, head, reverted=True, **flags) == frozenset({label, GL_SUPERSEDED_LABEL})


def test_a_reverted_pr_matches_its_verdicts_head_to_the_reverted_head_whatever_the_case():
    gate = _row(STATUS_REVERTED, run_id=2)
    verdict = _row(STATUS_NO_LAND, head=_HEAD.upper())

    assert _desired(gate, verdict, reverted=True) == frozenset({GL_HUMAN_LABEL, GL_SUPERSEDED_LABEL})


@pytest.mark.parametrize("verdict", [_LAND, _NO_LAND, _LAND_EARLIER])
@pytest.mark.parametrize("head", [_HEAD, _REWORKED])
def test_a_reverted_pr_whose_verdict_was_on_another_head_is_superseded_only(verdict, head):
    gate = _row(STATUS_REVERTED, head=_REWORKED, run_id=2)

    assert _desired(gate, verdict, head, reverted=True, eligible=True) == frozenset({GL_SUPERSEDED_LABEL})


@pytest.mark.parametrize(("verdict", "label"), [(_LAND, GL_APPROVED_LABEL), (_NO_LAND, GL_HUMAN_LABEL)])
@pytest.mark.parametrize("final", [pytest.param(False, id="active"), pytest.param(True, id="human-decided")])
def test_a_current_verdict_of_an_eligible_author_shows_its_label(verdict, label, final):
    assert _desired(verdict, verdict, eligible=True, final=final) == frozenset({label})


@pytest.mark.parametrize(
    ("recorded", "listed"),
    [
        pytest.param(_HEAD.upper(), _HEAD, id="uppercase-verdict-head"),
        pytest.param(_HEAD, _HEAD.upper(), id="uppercase-listed-head"),
    ],
)
def test_a_verdict_recorded_on_the_listed_head_in_another_case_is_current(recorded, listed):
    verdict = _row(STATUS_LAND, head=recorded)

    assert _desired(verdict, verdict, listed, eligible=True) == frozenset({GL_APPROVED_LABEL})


@pytest.mark.parametrize("verdict", [_LAND, _NO_LAND])
def test_a_current_verdict_of_a_determined_ineligible_author_is_superseded(verdict):
    assert _desired(verdict, verdict, ineligible=True, final=True) == frozenset({GL_SUPERSEDED_LABEL})


@pytest.mark.parametrize("verdict", [_LAND, _NO_LAND])
@pytest.mark.parametrize("final", [False, True])
def test_a_current_verdict_whose_author_is_neither_eligible_nor_ineligible_keeps_its_labels(verdict, final):
    assert _desired(verdict, verdict, final=final) is None


_NOT_CURRENT = [
    pytest.param(_LAND_EARLIER, _LAND_EARLIER, id="land-then-a-new-commit"),
    pytest.param(_NO_LAND_EARLIER, _NO_LAND_EARLIER, id="no-land-then-a-rebase"),
    pytest.param(_row(STATUS_FAILED, run_id=2), _LAND, id="newer-failed-run-at-the-same-head"),
    pytest.param(_row(STATUS_CANCELLED, run_id=2), _NO_LAND, id="newer-cancelled-run-at-the-same-head"),
    pytest.param(_row(STATUS_FAILED, run_id=2, age=timedelta(minutes=1)), _LAND, id="young-failed-run"),
    pytest.param(_row(STATUS_AI_REVIEW_STARTED, run_id=2, age=_TIMEOUT), _LAND, id="run-timed-out-at-the-same-head"),
    pytest.param(
        _row(STATUS_AI_REVIEW_DISPATCHED, head=_REWORKED, run_id=2, age=timedelta(hours=5)),
        _NO_LAND,
        id="dispatch-of-a-new-head-timed-out",
    ),
]


@pytest.mark.parametrize(("gate", "verdict"), _NOT_CURRENT)
@pytest.mark.parametrize(
    "flags",
    [
        pytest.param({"eligible": True}, id="human-decided"),
        pytest.param({"ineligible": True}, id="ineligible"),
        pytest.param({}, id="stale-skipped"),
    ],
)
def test_a_verdict_no_longer_current_is_superseded_once_greenlight_will_not_review_again(gate, verdict, flags):
    assert _desired(gate, verdict, final=True, **flags) == frozenset({GL_SUPERSEDED_LABEL})


@pytest.mark.parametrize(("gate", "verdict"), _NOT_CURRENT)
@pytest.mark.parametrize("eligible", [True, False])
def test_a_verdict_no_longer_current_keeps_its_labels_while_greenlight_may_review_again(gate, verdict, eligible):
    assert _desired(gate, verdict, eligible=eligible) is None


@pytest.mark.parametrize(
    "gate",
    [
        pytest.param(_row(STATUS_AI_REVIEW_STARTED, run_id=2, age=timedelta(minutes=5)), id="review-started"),
        pytest.param(_row(STATUS_AI_REVIEW_DISPATCHED, run_id=2, age=timedelta(0)), id="review-just-dispatched"),
        pytest.param(
            _row(STATUS_AI_REVIEW_STARTED, head=_REWORKED, run_id=2, age=_TIMEOUT - timedelta(microseconds=1)),
            id="review-of-a-new-head-about-to-time-out",
        ),
    ],
)
@pytest.mark.parametrize(
    "flags",
    [
        pytest.param({"eligible": True}, id="human-decided"),
        pytest.param({"ineligible": True}, id="ineligible"),
        pytest.param({}, id="stale-skipped"),
    ],
)
def test_a_review_in_progress_keeps_the_labels_even_when_greenlight_will_not_review_again(gate, flags):
    assert _desired(gate, _LAND, final=True, **flags) is None


def test_sync_removes_the_extras_before_it_adds_the_missing_label():
    pr = _FakePR([GL_APPROVED_LABEL, "module: dynamo", GL_HUMAN_LABEL])

    verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls[-1] == ("add", GL_SUPERSEDED_LABEL)
    assert sorted(pr.calls[:-1]) == [("remove", GL_APPROVED_LABEL), ("remove", GL_HUMAN_LABEL)]


def test_sync_adds_every_missing_label_in_one_call_in_sorted_order():
    pr = _FakePR(["triaged"])

    verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL, GL_HUMAN_LABEL}), number=7)

    assert pr.calls == [("add", GL_HUMAN_LABEL, GL_SUPERSEDED_LABEL)]


def test_sync_makes_its_one_add_call_after_the_removals():
    pr = _FakePR([GL_APPROVED_LABEL])

    verdict_labels.sync_labels(pr, frozenset({GL_HUMAN_LABEL, GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls == [("remove", GL_APPROVED_LABEL), ("add", GL_HUMAN_LABEL, GL_SUPERSEDED_LABEL)]


def test_sync_that_only_removes_makes_no_add_call():
    pr = _FakePR([GL_APPROVED_LABEL, GL_SUPERSEDED_LABEL])

    verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls == [("remove", GL_APPROVED_LABEL)]


def test_sync_leaves_exactly_the_desired_greenlight_labels_and_a_second_sync_writes_nothing():
    pr = _FakePR([GL_HUMAN_LABEL, "triaged", GL_SUPERSEDED_LABEL])
    desired = frozenset({GL_APPROVED_LABEL, GL_SUPERSEDED_LABEL})

    verdict_labels.sync_labels(pr, desired, number=7)

    assert sorted(label.name for label in pr.labels) == [GL_APPROVED_LABEL, GL_SUPERSEDED_LABEL, "triaged"]
    pr.calls.clear()
    verdict_labels.sync_labels(pr, desired, number=7)
    assert pr.calls == []


@pytest.mark.parametrize("held", ["gl/approved", "GL/APPROVED", "Gl/Approved"])
def test_sync_counts_a_differently_cased_label_as_present(held):
    pr = _FakePR([held, "ciflow/trunk"])

    verdict_labels.sync_labels(pr, frozenset({GL_APPROVED_LABEL}), number=7)

    assert pr.calls == []


def test_sync_removes_a_differently_cased_extra_by_the_name_it_read():
    pr = _FakePR(["gl/Human"])

    verdict_labels.sync_labels(pr, frozenset({GL_APPROVED_LABEL}), number=7)

    assert pr.calls == [("remove", "gl/Human"), ("add", GL_APPROVED_LABEL)]


def test_sync_never_touches_a_label_that_is_not_one_of_greenlights():
    others = ["Stale", "Reverted", "ciflow/trunk", "GL/other", "release notes: dynamo"]
    pr = _FakePR([*others, GL_HUMAN_LABEL])

    verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls == [("remove", GL_HUMAN_LABEL), ("add", GL_SUPERSEDED_LABEL)]
    assert [label.name for label in pr.labels] == [*others, GL_SUPERSEDED_LABEL]


def test_sync_writes_and_logs_nothing_when_the_labels_already_match(caplog):
    pr = _FakePR([GL_SUPERSEDED_LABEL, "triaged", GL_APPROVED_LABEL])

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict_labels.sync_labels(pr, frozenset({GL_APPROVED_LABEL, GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls == []
    assert caplog.records == []


def test_sync_logs_the_labels_it_changed(caplog):
    pr = _FakePR([GL_APPROVED_LABEL])

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    [record] = caplog.records
    assert record.levelno == logging.INFO
    assert "PR #7" in record.getMessage()
    assert GL_APPROVED_LABEL in record.getMessage()
    assert GL_SUPERSEDED_LABEL in record.getMessage()


def test_sync_counts_a_label_already_gone_as_removed_and_goes_on():
    pr = _FakePR([GL_APPROVED_LABEL], fail={"remove": _label_gone()})

    verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls == [("remove", GL_APPROVED_LABEL), ("add", GL_SUPERSEDED_LABEL)]


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(UnknownObjectException(404, {"message": "Not Found"}), id="not-found"),
        pytest.param(GithubException(404, None), id="404-without-a-body"),
        pytest.param(GithubException(404, "Label does not exist"), id="404-with-a-non-json-body"),
        pytest.param(GithubException(422, {"message": "Label does not exist"}), id="label-gone-message-on-a-422"),
        pytest.param(GithubException(500, {"message": "Server Error"}), id="server-error"),
    ],
)
def test_sync_raises_any_other_removal_failure_before_adding(error):
    pr = _FakePR([GL_APPROVED_LABEL], fail={"remove": error})

    with pytest.raises(GithubException) as raised:
        verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    assert raised.value is error
    assert pr.calls == [("remove", GL_APPROVED_LABEL)]
