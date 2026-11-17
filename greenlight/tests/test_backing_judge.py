from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest

from greenlight import backing_judge
from greenlight.approvals import ReviewActor, ReviewRecord
from greenlight.backing_judge import BACKED, WAITING, Judgement, judge
from greenlight.constants import (
    BACKING_WAIT_MAX,
    LEDGER_MARGIN,
    STATUS_AI_REVIEW_DISPATCHED,
    STATUS_AI_REVIEW_STARTED,
    STATUS_CANCELLED,
    STATUS_FAILED,
    STATUS_LAND,
    STATUS_NO_LAND,
    STATUS_REVERTED,
)
from greenlight.gate_rules import GateRules
from greenlight.state import PRState

_REPO = "pytorch/vision"
_HEAD = "a" * 40
_OLD = "b" * 40
_NOW = datetime(2026, 11, 17, 12, 0, 0)
_SUBMITTED = _NOW - timedelta(minutes=5)
_ENFORCED = GateRules(enforced=True)


def _approval(commit: str | None = _HEAD, submitted: datetime | None = _SUBMITTED) -> ReviewRecord:
    return ReviewRecord(
        id=1,
        user=ReviewActor(login="greenlight-app[bot]", type="Bot"),
        state="APPROVED",
        commit_id=commit,
        submitted_at=None if submitted is None else submitted.replace(tzinfo=UTC),
    )


def _row(status: str, *, head: str = _HEAD, version: datetime = _SUBMITTED - timedelta(minutes=1)) -> PRState:
    return PRState(pr_number=7, status=status, eval_hash="e" * 64, head_sha=head, version=version, run_id=3)


def _judge(approval: ReviewRecord | None = None, **overrides: Any) -> Judgement:
    kwargs: dict[str, Any] = {
        "repo": _REPO,
        "head": _HEAD,
        "base": "main",
        "gate": None,
        "rules": _ENFORCED,
        "ledger_newest": _SUBMITTED,
        "now": _NOW,
    }
    kwargs.update(overrides)
    return judge(approval or _approval(), **kwargs)


def _unbacked(reason: str) -> Judgement:
    return Judgement("unbacked", reason)


def test_a_land_row_on_the_head_backs_the_approval():
    assert _judge(gate=_row(STATUS_LAND)) == BACKED


def test_a_land_row_backs_the_approval_whatever_the_case_of_the_shas():
    assert _judge(_approval(_HEAD.upper()), gate=_row(STATUS_LAND, head=_HEAD.upper())) == BACKED


def test_unenforced_rules_unback_even_a_backed_approval():
    rules = GateRules(enforced=False, problems=("a merge_queue rule applies", "no pull_request rule"))

    assert _judge(gate=_row(STATUS_LAND), rules=rules) == _unbacked(
        "GreenLight's gate is not enforced on pytorch/vision: a merge_queue rule applies; no pull_request rule"
    )


def test_unknown_rules_skip_the_rules_rule():
    assert _judge(gate=_row(STATUS_LAND), rules=None) == BACKED


@pytest.mark.parametrize(
    ("commit", "named"), [pytest.param(_OLD, _OLD, id="older"), pytest.param(None, "an unknown commit", id="unknown")]
)
def test_an_approval_on_another_commit_is_unbacked(commit, named):
    assert _judge(_approval(commit), gate=_row(STATUS_LAND)) == _unbacked(
        f"it was given on {named}, not on the head {_HEAD}"
    )


def test_an_approval_on_a_base_other_than_main_is_unbacked():
    assert _judge(gate=_row(STATUS_LAND), base="release/2.9") == _unbacked("the base is release/2.9, not main")


@pytest.mark.parametrize("status", [STATUS_NO_LAND, STATUS_REVERTED, STATUS_CANCELLED, STATUS_FAILED])
def test_a_denying_latest_row_unbacks_the_approval(status):
    assert _judge(gate=_row(status)) == _unbacked(f"GreenLight's latest verdict row for the head is {status}")


@pytest.mark.parametrize("status", [STATUS_AI_REVIEW_STARTED, STATUS_LAND])
def test_a_row_newer_than_the_approval_unbacks_it(status):
    gate = _row(status, head=_OLD if status == STATUS_LAND else _HEAD, version=_SUBMITTED + timedelta(seconds=1))

    assert _judge(gate=gate) == _unbacked(f"a newer {status} row")


@pytest.mark.parametrize(
    "gate",
    [
        pytest.param(None, id="no-row"),
        pytest.param(_row(STATUS_AI_REVIEW_STARTED), id="started"),
        pytest.param(_row(STATUS_AI_REVIEW_DISPATCHED), id="dispatched"),
        pytest.param(_row(STATUS_LAND, head=_OLD), id="land-for-another-head"),
    ],
)
@pytest.mark.parametrize("ledger", [None, _SUBMITTED + LEDGER_MARGIN - timedelta(milliseconds=1)])
def test_an_approval_whose_row_may_not_be_ingested_yet_waits(gate, ledger):
    assert _judge(gate=gate, ledger_newest=ledger) == WAITING


def test_an_approval_waits_until_the_ledger_moves_a_margin_past_it():
    assert _judge(ledger_newest=_SUBMITTED + LEDGER_MARGIN) == _unbacked("no LAND row backs it on the head")


def test_an_approval_waits_no_longer_than_the_wait_max():
    old = _NOW - BACKING_WAIT_MAX

    assert _judge(_approval(submitted=old), ledger_newest=None) == _unbacked("no LAND row backs it on the head")
    assert _judge(_approval(submitted=old + timedelta(seconds=1)), ledger_newest=None) == WAITING


def test_an_approval_without_a_time_never_waits():
    assert _judge(_approval(submitted=None), gate=_row(STATUS_AI_REVIEW_STARTED)) == _unbacked(
        "no LAND row backs it on the head"
    )


def test_a_row_of_an_unknown_status_never_lets_an_approval_wait():
    assert _judge(gate=_row("SOMETHING_NEW")) == _unbacked("no LAND row backs it on the head")


class _Result:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows

    def named_results(self) -> list[dict[str, object]]:
        return self.rows


class _ClickHouse:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows
        self.queries: list[tuple[str, object]] = []
        self.closed = 0

    def query(self, query: str, parameters: object = None, settings: object = None) -> _Result:
        self.queries.append((query, parameters))
        return _Result(self.rows)

    def close(self) -> None:
        self.closed += 1


@pytest.mark.parametrize(
    ("rows", "newest"),
    [
        pytest.param([{"newest": datetime(2026, 11, 17, 11, 0)}], datetime(2026, 11, 17, 11, 0), id="naive"),
        pytest.param(
            [{"newest": datetime(2026, 11, 17, 13, 0, tzinfo=timezone(timedelta(hours=2)))}],
            datetime(2026, 11, 17, 11, 0),
            id="aware",
        ),
        pytest.param([{"newest": None}], None, id="empty-ledger"),
        pytest.param([], None, id="no-row"),
    ],
)
def test_the_ledgers_newest_version_is_read_in_one_query_over_every_repo(rows, newest):
    client = _ClickHouse(rows)

    assert backing_judge.read_newest_version(connect=lambda: client) == newest  # type: ignore[arg-type,return-value]
    assert client.queries == [("SELECT maxOrNull(version) AS newest FROM misc.greenlight_pr_state", {})]
    assert client.closed == 1
