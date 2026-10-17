from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, cast

import pytest
from github import BadCredentialsException, GithubException, RateLimitExceededException, UnknownObjectException
from requests.exceptions import ConnectionError as RequestsConnectionError
from requests.exceptions import RetryError

from greenlight import verdict_labels
from greenlight.constants import (
    DEFAULT_TIMEOUT_MINUTES,
    GL_APPROVED_LABEL,
    GL_HUMAN_LABEL,
    GL_SUPERSEDED_LABEL,
    LABEL_PASS_DEADLINE,
    STATUS_AI_REVIEW_DISPATCHED,
    STATUS_AI_REVIEW_STARTED,
    STATUS_CANCELLED,
    STATUS_FAILED,
    STATUS_LAND,
    STATUS_NO_LAND,
    STATUS_REVERTED,
    TARGET_REPO,
)
from greenlight.guards import IterationTimeout
from greenlight.review_gate import HUMAN_APPROVED, ReviewSkip
from greenlight.state import PRState

if TYPE_CHECKING:
    from collections.abc import Callable, Collection, Mapping, Sequence

    from greenlight.github_types import VerdictPR

_LISTED_AT = datetime(2026, 10, 15, 12, 0, 0)
_IN_TIME = timedelta(seconds=10)
_NOW = _LISTED_AT + _IN_TIME
_TIMEOUT = timedelta(minutes=DEFAULT_TIMEOUT_MINUTES)
_HEAD = "a" * 40
_REWORKED = "b" * 40
_EARLIER = "c" * 40
_HUMAN_DECIDED = ReviewSkip(HUMAN_APPROVED, "approved by alice")


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
    """A PR's state and labels and the label writes made to it, one entry per write call.

    ``fail`` makes reading the state or the labels, a removal or an add raise.
    """

    def __init__(
        self, labels: Sequence[str] = (), *, state: str = "open", fail: Mapping[str, Exception] | None = None
    ) -> None:
        self._labels = list(labels)
        self._state = state
        self._fail = dict(fail or {})
        self.calls: list[tuple[str, ...]] = []

    @property
    def state(self) -> str:
        self._raise_if_failing("state")
        return self._state

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


@dataclass(frozen=True)
class _FakeHead:
    sha: str


class _FakeVerdictPR(_FakePR):
    def __init__(
        self,
        labels: Sequence[str] = (),
        *,
        head_sha: str = _HEAD,
        state: str = "open",
        fail: Mapping[str, Exception] | None = None,
    ) -> None:
        super().__init__(labels, state=state, fail=fail)
        self._head_sha = head_sha

    @property
    def head(self) -> _FakeHead:
        self._raise_if_failing("head")
        return _FakeHead(self._head_sha)


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


def _label_verdict(pr: _FakeVerdictPR, status: str, *, reviewed_head: str = _HEAD) -> None:
    verdict_labels.label_verdict(cast("VerdictPR", pr), status, reviewed_head=reviewed_head, number=7)


@dataclass
class _Scan:
    """One listing tick's label pass, with its row read, PR fetches and clock faked.

    ``rows`` maps a PR to the gate row and verdict the reader returns for it, ``fresh`` the labels a
    fetched PR carries (its listed ones by default), ``closed`` the PRs a fetch finds closed,
    ``elapsed`` the successive clock reads after ``_LISTED_AT`` (the last one repeats), and ``fail`` a
    PR's failing step: ``fetch``, ``state``, ``labels``, ``remove`` or ``add``.
    """

    labels: Mapping[int, Sequence[str]]
    rows: Mapping[int, tuple[PRState, PRState | None]] = field(default_factory=dict)
    reverted: Collection[int] = ()
    recent: Collection[int] = ()
    eligible: Collection[int] = ()
    ineligible: Collection[int] = ()
    skips: Collection[int] = ()
    fresh: Mapping[int, Sequence[str]] | None = None
    closed: Collection[int] = ()
    heads: Mapping[int, str | None] | None = None
    elapsed: Sequence[timedelta] = (_IN_TIME,)
    timeout: timedelta = _TIMEOUT
    fail: Mapping[int, Mapping[str, Exception]] = field(default_factory=dict)
    read_error: Exception | None = None
    reads: list[tuple[str, list[int]]] = field(default_factory=list)
    fetched: list[int] = field(default_factory=list)
    prs: dict[int, _FakePR] = field(default_factory=dict)
    clock_reads: int = 0

    def run(self) -> None:
        verdict_labels.label_listed_prs(
            verdict_labels.LabelPass(
                fetch_pr=self._fetch,
                reverted=self.reverted,
                recent=self.recent,
                eligible=self.eligible,
                ineligible=self.ineligible,
                skips=[(number, _HUMAN_DECIDED) for number in self.skips],
                labels=self.labels,
                heads=dict.fromkeys(self.labels, _HEAD) if self.heads is None else self.heads,
                listed_at=_LISTED_AT,
                clock=self._clock,
                timeout=self.timeout,
            ),
            read_gate_rows=self._read,
        )

    def _read(self, repo: str, numbers: Sequence[int]) -> tuple[dict[int, PRState], dict[int, PRState]]:
        self.reads.append((repo, list(numbers)))
        if self.read_error is not None:
            raise self.read_error
        asked = [number for number in numbers if number in self.rows]
        gates = {number: self.rows[number][0] for number in asked}
        verdicts = {number: verdict for number in asked if (verdict := self.rows[number][1]) is not None}
        return gates, verdicts

    def _fetch(self, number: int) -> _FakePR:
        self.fetched.append(number)
        fail = self.fail.get(number, {})
        if "fetch" in fail:
            raise fail["fetch"]
        fresh = self.labels if self.fresh is None else self.fresh
        state = "closed" if number in self.closed else "open"
        pr = self.prs[number] = _FakePR(fresh.get(number, ()), state=state, fail=fail)
        return pr

    def _clock(self) -> datetime:
        offset = self.elapsed[min(self.clock_reads, len(self.elapsed) - 1)]
        self.clock_reads += 1
        return _LISTED_AT + offset


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


def test_a_land_leaves_gl_approved_as_the_prs_only_greenlight_label():
    pr = _FakeVerdictPR([GL_HUMAN_LABEL, "triaged", GL_SUPERSEDED_LABEL])

    _label_verdict(pr, STATUS_LAND)

    assert pr.calls[-1] == ("add", GL_APPROVED_LABEL)
    assert sorted(pr.calls[:-1]) == [("remove", GL_HUMAN_LABEL), ("remove", GL_SUPERSEDED_LABEL)]
    assert sorted(label.name for label in pr.labels) == [GL_APPROVED_LABEL, "triaged"]


def test_a_no_land_leaves_gl_human_as_the_prs_only_greenlight_label():
    pr = _FakeVerdictPR([GL_APPROVED_LABEL])

    _label_verdict(pr, STATUS_NO_LAND)

    assert pr.calls == [("remove", GL_APPROVED_LABEL), ("add", GL_HUMAN_LABEL)]


def test_a_verdict_already_labelled_writes_nothing():
    pr = _FakeVerdictPR(["gl/approved", "triaged"])

    _label_verdict(pr, STATUS_LAND)

    assert pr.calls == []


def test_a_verdict_on_a_pr_that_moved_off_the_reviewed_head_is_left_to_the_scan():
    pr = _FakeVerdictPR([GL_SUPERSEDED_LABEL], head_sha=_REWORKED)

    _label_verdict(pr, STATUS_LAND)

    assert pr.calls == []


def test_a_verdict_whose_reviewed_head_differs_from_the_prs_only_in_case_is_labelled():
    pr = _FakeVerdictPR([GL_SUPERSEDED_LABEL])

    _label_verdict(pr, STATUS_LAND, reviewed_head=_HEAD.upper())

    assert pr.calls == [("remove", GL_SUPERSEDED_LABEL), ("add", GL_APPROVED_LABEL)]


@pytest.mark.parametrize("label", ["Reverted", "reverted", "REVERTED"])
def test_a_verdict_on_a_reverted_pr_is_left_to_the_scan(label):
    pr = _FakeVerdictPR([label, GL_HUMAN_LABEL])

    _label_verdict(pr, STATUS_LAND)

    assert pr.calls == []


def test_a_verdict_on_a_closed_pr_writes_nothing():
    pr = _FakeVerdictPR([GL_HUMAN_LABEL], state="closed")

    _label_verdict(pr, STATUS_LAND)

    assert pr.calls == []


@pytest.mark.parametrize("step", ["state", "head", "labels", "remove", "add"])
@pytest.mark.parametrize(
    "error",
    [
        pytest.param(GithubException(500, {"message": "Server Error"}), id="server-error"),
        pytest.param(RateLimitExceededException(403, {"message": "API rate limit exceeded"}), id="rate-limit"),
        pytest.param(UnknownObjectException(404, {"message": "Not Found"}), id="not-found"),
        pytest.param(RequestsConnectionError("connection reset"), id="connection"),
        pytest.param(RuntimeError("unexpected"), id="unexpected"),
    ],
)
def test_a_failed_verdict_label_write_is_logged_and_swallowed(step, error, caplog):
    pr = _FakeVerdictPR([GL_HUMAN_LABEL], fail={step: error})

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        _label_verdict(pr, STATUS_LAND)

    [record] = caplog.records
    assert record.levelno == logging.ERROR
    assert record.exc_info is not None
    assert "PR #7" in record.getMessage()


def test_a_tick_with_no_pr_to_judge_reads_and_writes_nothing():
    scan = _Scan(labels={11: [GL_APPROVED_LABEL], 13: ["stale", GL_HUMAN_LABEL]})

    scan.run()

    assert scan.reads == []
    assert scan.fetched == []


def test_the_pass_reads_the_rows_of_its_reverted_recent_and_stale_skipped_prs_in_one_query():
    scan = _Scan(
        labels={1: [], 3: ["Stale"], 5: [], 7: ["Stale"], 9: ["Reverted", "Stale"], 11: [], 13: ["stale"]},
        reverted=[9],
        recent=[5, 3],
        eligible=[5, 3],
    )

    scan.run()

    assert scan.reads == [(TARGET_REPO, [3, 5, 7, 9])]


def test_an_idle_pr_keeps_its_labels_whatever_its_rows_say():
    scan = _Scan(
        labels={4: [GL_APPROVED_LABEL], 5: [GL_APPROVED_LABEL]},
        rows={4: (_LAND_EARLIER, _LAND_EARLIER), 5: (_LAND_EARLIER, _LAND_EARLIER)},
        recent=[5],
        eligible=[5],
        skips=[5],
    )

    scan.run()

    assert scan.reads == [(TARGET_REPO, [5])]
    assert scan.fetched == [5]


def test_a_pr_the_reader_returns_no_verdict_for_keeps_its_labels():
    scan = _Scan(
        labels={5: [GL_APPROVED_LABEL], 6: [GL_APPROVED_LABEL], 8: [GL_HUMAN_LABEL]},
        rows={5: (_LAND, _LAND), 6: (_row(STATUS_FAILED, run_id=2), None)},
        recent=[5, 6, 8],
        ineligible=[5, 6, 8],
    )

    scan.run()

    assert scan.fetched == [5]
    assert scan.prs[5].calls == [("remove", GL_APPROVED_LABEL), ("add", GL_SUPERSEDED_LABEL)]


@pytest.mark.parametrize("listed", [[GL_APPROVED_LABEL], ["gl/approved", "triaged"]])
def test_a_pr_whose_listed_labels_already_match_is_not_fetched(listed):
    scan = _Scan(labels={5: listed}, rows={5: (_LAND, _LAND)}, recent=[5], eligible=[5])

    scan.run()

    assert scan.reads == [(TARGET_REPO, [5])]
    assert scan.fetched == []


def test_the_writes_follow_the_fetched_prs_labels_rather_than_the_listed_ones():
    scan = _Scan(
        labels={5: [GL_HUMAN_LABEL], 6: []},
        fresh={5: [GL_SUPERSEDED_LABEL, "triaged"], 6: [GL_APPROVED_LABEL]},
        rows={5: (_LAND, _LAND), 6: (_LAND, _LAND)},
        recent=[5, 6],
        eligible=[5, 6],
    )

    scan.run()

    assert scan.prs[5].calls == [("remove", GL_SUPERSEDED_LABEL), ("add", GL_APPROVED_LABEL)]
    assert scan.prs[6].calls == []


def test_a_pr_whose_labels_stay_as_they_are_is_never_fetched():
    in_progress = _row(STATUS_AI_REVIEW_STARTED, run_id=2, age=timedelta(minutes=5))
    scan = _Scan(
        labels={5: [GL_APPROVED_LABEL], 6: [GL_HUMAN_LABEL], 7: [GL_HUMAN_LABEL], 8: []},
        rows={5: (_LAND_EARLIER, _LAND_EARLIER), 7: (in_progress, _NO_LAND), 8: (_LAND, _LAND)},
        recent=[5, 6, 7, 8],
        eligible=[5, 6, 7],
        skips=[7],
    )

    scan.run()

    assert scan.fetched == []


def test_an_active_pr_gets_back_the_label_of_its_current_verdict():
    scan = _Scan(labels={5: ["triaged"]}, rows={5: (_NO_LAND, _NO_LAND)}, recent=[5], eligible=[5])

    scan.run()

    assert scan.prs[5].calls == [("add", GL_HUMAN_LABEL)]


def test_a_determined_ineligible_pr_is_superseded_whether_or_not_its_verdict_is_current():
    scan = _Scan(
        labels={3: [GL_APPROVED_LABEL], 5: [GL_HUMAN_LABEL]},
        rows={3: (_LAND, _LAND), 5: (_NO_LAND_EARLIER, _NO_LAND_EARLIER)},
        recent=[3, 5],
        ineligible=[3, 5],
    )

    scan.run()

    assert scan.prs[3].calls == [("remove", GL_APPROVED_LABEL), ("add", GL_SUPERSEDED_LABEL)]
    assert scan.prs[5].calls == [("remove", GL_HUMAN_LABEL), ("add", GL_SUPERSEDED_LABEL)]


def test_a_human_decided_pr_is_superseded_once_a_newer_run_ends_its_verdicts_currency():
    scan = _Scan(
        labels={5: [GL_HUMAN_LABEL]},
        rows={5: (_row(STATUS_CANCELLED, run_id=2), _NO_LAND)},
        recent=[5],
        eligible=[5],
        skips=[5],
    )

    scan.run()

    assert scan.prs[5].calls == [("remove", GL_HUMAN_LABEL), ("add", GL_SUPERSEDED_LABEL)]


def test_a_stale_skipped_pr_is_superseded_once_its_verdict_is_no_longer_current():
    scan = _Scan(labels={7: ["Stale", GL_APPROVED_LABEL]}, rows={7: (_LAND_EARLIER, _LAND_EARLIER)})

    scan.run()

    assert scan.prs[7].calls == [("remove", GL_APPROVED_LABEL), ("add", GL_SUPERSEDED_LABEL)]


def test_a_stale_skipped_pr_with_a_current_verdict_keeps_its_labels():
    scan = _Scan(labels={7: ["Stale"]}, rows={7: (_LAND, _LAND)})

    scan.run()

    assert scan.reads == [(TARGET_REPO, [7])]
    assert scan.fetched == []


def test_a_stale_labelled_pr_the_review_window_keeps_is_not_superseded_as_stale_skipped():
    scan = _Scan(
        labels={7: ["Stale", GL_APPROVED_LABEL]},
        rows={7: (_row(STATUS_FAILED, run_id=2), _LAND)},
        recent=[7],
        eligible=[7],
    )

    scan.run()

    assert scan.reads == [(TARGET_REPO, [7])]
    assert scan.fetched == []


def test_an_in_flight_review_stops_counting_as_in_progress_at_the_ticks_own_timeout():
    scan = _Scan(
        labels={5: [GL_APPROVED_LABEL]},
        rows={5: (_row(STATUS_AI_REVIEW_STARTED, run_id=2, age=timedelta(minutes=20)), _LAND)},
        recent=[5],
        eligible=[5],
        skips=[5],
        timeout=timedelta(minutes=10),
    )

    scan.run()

    assert scan.prs[5].calls == [("remove", GL_APPROVED_LABEL), ("add", GL_SUPERSEDED_LABEL)]


def test_a_reverted_pr_gains_superseded_beside_the_label_of_the_verdict_on_its_reverted_head():
    scan = _Scan(
        labels={9: ["Reverted", GL_APPROVED_LABEL]},
        rows={9: (_row(STATUS_REVERTED, run_id=2), _LAND)},
        reverted=[9],
        heads={9: None},
    )

    scan.run()

    assert scan.prs[9].calls == [("add", GL_SUPERSEDED_LABEL)]


def test_a_pr_excluded_by_its_recorded_reverted_row_alone_is_labelled_as_reverted():
    scan = _Scan(
        labels={9: [GL_HUMAN_LABEL]},
        rows={9: (_row(STATUS_REVERTED, run_id=2), _NO_LAND)},
        reverted=[9],
    )

    scan.run()

    assert scan.prs[9].calls == [("add", GL_SUPERSEDED_LABEL)]


def test_a_reverted_pr_keeps_its_labels_until_its_reverted_row_is_recorded():
    scan = _Scan(labels={9: ["Reverted", GL_APPROVED_LABEL]}, rows={9: (_LAND, _LAND)}, reverted=[9])

    scan.run()

    assert scan.fetched == []


def test_a_pr_closed_since_the_listing_keeps_its_labels_and_the_pass_moves_on(caplog):
    scan = _Scan(
        labels={3: [GL_HUMAN_LABEL], 5: [GL_HUMAN_LABEL]},
        rows={3: (_LAND, _LAND), 5: (_LAND, _LAND)},
        recent=[3, 5],
        eligible=[3, 5],
        closed=[3],
    )

    with caplog.at_level(logging.INFO, logger="greenlight"):
        scan.run()

    assert scan.prs[3].calls == []
    assert scan.prs[5].calls == [("remove", GL_HUMAN_LABEL), ("add", GL_APPROVED_LABEL)]
    assert "PR #3 is now closed; its labels stay as they are" in caplog.text
    assert all(record.levelno < logging.ERROR for record in caplog.records)


@pytest.mark.parametrize("elapsed", [LABEL_PASS_DEADLINE, LABEL_PASS_DEADLINE + timedelta(minutes=1)])
def test_a_tick_past_the_label_deadline_skips_the_pass_without_reading_clickhouse(elapsed):
    scan = _Scan(labels={5: []}, rows={5: (_LAND, _LAND)}, recent=[5], eligible=[5], elapsed=[elapsed])

    scan.run()

    assert scan.reads == []
    assert scan.fetched == []


def test_a_tick_just_inside_the_label_deadline_runs_the_pass():
    scan = _Scan(
        labels={5: []},
        rows={5: (_LAND, _LAND)},
        recent=[5],
        eligible=[5],
        elapsed=[LABEL_PASS_DEADLINE - timedelta(microseconds=1)],
    )

    scan.run()

    assert scan.reads == [(TARGET_REPO, [5])]
    assert scan.prs[5].calls == [("add", GL_APPROVED_LABEL)]


def test_the_pass_starts_no_pr_once_the_label_deadline_has_passed():
    scan = _Scan(
        labels={3: [], 5: [], 7: []},
        rows={3: (_LAND, _LAND), 5: (_LAND, _LAND), 7: (_LAND, _LAND)},
        recent=[3, 5, 7],
        eligible=[3, 5, 7],
        elapsed=[_IN_TIME, LABEL_PASS_DEADLINE - timedelta(microseconds=1), LABEL_PASS_DEADLINE],
    )

    scan.run()

    assert scan.fetched == [3]
    assert scan.prs[3].calls == [("add", GL_APPROVED_LABEL)]


def test_the_pass_ends_at_the_first_pr_it_reaches_past_the_deadline_even_if_the_clock_steps_back():
    scan = _Scan(
        labels={3: [], 5: []},
        rows={3: (_LAND, _LAND), 5: (_LAND, _LAND)},
        recent=[3, 5],
        eligible=[3, 5],
        elapsed=[_IN_TIME, LABEL_PASS_DEADLINE, _IN_TIME],
    )

    scan.run()

    assert scan.fetched == []


def _failing_scan(step: str, error: Exception) -> _Scan:
    return _Scan(
        labels={3: [GL_HUMAN_LABEL], 5: [GL_HUMAN_LABEL]},
        rows={3: (_LAND, _LAND), 5: (_LAND, _LAND)},
        recent=[3, 5],
        eligible=[3, 5],
        fail={3: {step: error}},
    )


@pytest.mark.parametrize("step", ["fetch", "state", "labels", "remove", "add"])
@pytest.mark.parametrize(
    "error",
    [
        pytest.param(BadCredentialsException(401, {"message": "Bad credentials"}), id="401"),
        pytest.param(GithubException(403, {"message": "Resource not accessible by integration"}), id="403"),
        pytest.param(UnknownObjectException(404, {"message": "Not Found"}), id="404"),
        pytest.param(GithubException(410, {"message": "Issues are disabled for this repo"}), id="410"),
        pytest.param(GithubException(422, {"message": "Validation Failed"}), id="422"),
        pytest.param(GithubException(500, {"message": "Server Error"}), id="500"),
        pytest.param(GithubException(502, None), id="502"),
        pytest.param(RequestsConnectionError("connection reset"), id="connection"),
        pytest.param(RetryError("too many 5xx responses"), id="retries-exhausted"),
        pytest.param(RuntimeError("unexpected"), id="unexpected"),
    ],
)
def test_a_failure_other_than_a_rate_limit_is_logged_and_the_pass_moves_on(step, error, caplog):
    scan = _failing_scan(step, error)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        scan.run()

    assert scan.fetched == [3, 5]
    assert scan.prs[5].calls == [("remove", GL_HUMAN_LABEL), ("add", GL_APPROVED_LABEL)]
    [record] = caplog.records
    assert record.exc_info is not None
    assert record.exc_info[1] is error
    assert "PR #3" in record.getMessage()


@pytest.mark.parametrize("step", ["fetch", "state", "labels", "remove", "add"])
@pytest.mark.parametrize(
    "error",
    [
        pytest.param(RateLimitExceededException(403, {"message": "API rate limit exceeded"}), id="rate-limit"),
        pytest.param(GithubException(429, {"message": "secondary rate limit"}), id="429"),
        pytest.param(
            GithubException(403, {"message": "secondary rate limit"}, headers={"retry-after": "60"}),
            id="403-with-retry-after",
        ),
        pytest.param(
            GithubException(403, {"message": "quota exhausted"}, headers={"x-ratelimit-remaining": "0"}),
            id="403-with-no-quota-left",
        ),
    ],
)
def test_a_rate_limit_is_logged_and_stops_the_pass(step, error, caplog):
    scan = _failing_scan(step, error)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        scan.run()

    assert scan.fetched == [3]
    [record] = caplog.records
    assert record.exc_info is not None
    assert record.exc_info[1] is error
    assert "PR #3" in record.getMessage()


@pytest.mark.parametrize("step", ["fetch", "state", "labels", "remove", "add"])
def test_an_iteration_timeout_propagates_out_of_the_pass(step):
    scan = _failing_scan(step, IterationTimeout("iteration exceeded 300 seconds"))

    with pytest.raises(IterationTimeout):
        scan.run()

    assert scan.fetched == [3]


_OUTCOME_ERRORS: dict[str, Callable[[], Exception]] = {
    "F": lambda: GithubException(500, {"message": "Server Error"}),
    "R": lambda: RateLimitExceededException(403, {"message": "API rate limit exceeded"}),
    "T": lambda: IterationTimeout("iteration exceeded 300 seconds"),
}


def _breaker_scan(outcomes: str) -> _Scan:
    """A tick whose PRs 1, 2, ... each need ``GL/approved``, one per letter of ``outcomes``.

    ``S`` syncs; ``F`` fails, ``R`` hits a rate limit and ``T`` times out on the add; ``C`` is found
    closed; ``U`` already carries the label, so it is not fetched.
    """
    by_number = dict(enumerate(outcomes, start=1))
    return _Scan(
        labels={number: [GL_APPROVED_LABEL] if outcome == "U" else [] for number, outcome in by_number.items()},
        rows=dict.fromkeys(by_number, (_LAND, _LAND)),
        recent=list(by_number),
        eligible=list(by_number),
        closed=[number for number, outcome in by_number.items() if outcome == "C"],
        fail={
            number: {"add": _OUTCOME_ERRORS[outcome]()}
            for number, outcome in by_number.items()
            if outcome in _OUTCOME_ERRORS
        },
    )


@pytest.mark.parametrize(
    ("outcomes", "fetched"),
    [
        pytest.param("FFFS", [1, 2, 3], id="in-a-row"),
        pytest.param("FCFFS", [1, 2, 3, 4], id="around-a-closed-pr"),
        pytest.param("FUFFS", [1, 3, 4], id="around-a-pr-not-fetched"),
    ],
)
def test_three_failures_with_no_pr_synced_between_them_stop_the_pass(outcomes, fetched, caplog):
    scan = _breaker_scan(outcomes)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        scan.run()

    assert scan.fetched == fetched
    *failures, summary = caplog.records
    assert len(failures) == 3
    assert all(record.exc_info is not None for record in failures)
    assert summary.exc_info is None
    assert f"label pass stopped at PR #{fetched[-1]} after 3 failures in a row" in summary.getMessage()


@pytest.mark.parametrize("outcomes", ["FFSFS", "FFSFFS"])
def test_a_pr_synced_between_failures_starts_their_count_again(outcomes, caplog):
    scan = _breaker_scan(outcomes)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        scan.run()

    assert scan.fetched == list(range(1, len(outcomes) + 1))
    assert scan.prs[len(outcomes)].calls == [("add", GL_APPROVED_LABEL)]
    assert len(caplog.records) == outcomes.count("F")


def test_a_rate_limit_after_two_failures_stops_the_pass_as_a_rate_limit(caplog):
    scan = _breaker_scan("FFRS")

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        scan.run()

    assert scan.fetched == [1, 2, 3]
    assert len(caplog.records) == 3
    assert "label pass stopped at PR #3 by a rate limit" in caplog.records[-1].getMessage()


def test_an_iteration_timeout_after_two_failures_still_propagates():
    scan = _breaker_scan("FFTS")

    with pytest.raises(IterationTimeout):
        scan.run()

    assert scan.fetched == [1, 2, 3]


def test_a_failed_row_read_fails_the_scan():
    error = OSError("ClickHouse unreachable")
    scan = _Scan(labels={5: []}, recent=[5], eligible=[5], read_error=error)

    with pytest.raises(OSError) as raised:
        scan.run()

    assert raised.value is error
    assert scan.fetched == []
