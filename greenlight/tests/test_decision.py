import dataclasses
from datetime import UTC, datetime, timedelta

import pytest

from greenlight import constants
from greenlight.decision import Decision, Outcome, decide

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=UTC)
TIMEOUT = timedelta(minutes=30)
HASH_A = "a" * 64
HASH_B = "b" * 64

FRESH = NOW - timedelta(minutes=10)
AT_BOUNDARY = NOW - TIMEOUT
STALE = NOW - timedelta(minutes=45)


def _decide(
    latest_status: str | None,
    *,
    current: str = HASH_A,
    latest: str | None = HASH_A,
    version: datetime | None = None,
    now: datetime = NOW,
    timeout: timedelta = TIMEOUT,
) -> Outcome:
    return decide(
        current_eval_hash=current,
        latest_status=latest_status,
        latest_eval_hash=latest,
        latest_version=version,
        now=now,
        timeout=timeout,
    )


def test_decision_members_are_dispatch_skip_wait():
    assert [member.name for member in Decision] == ["DISPATCH", "SKIP", "WAIT"]


def test_outcome_is_frozen():
    outcome = Outcome(Decision.WAIT, "in_flight")
    with pytest.raises(dataclasses.FrozenInstanceError):
        outcome.reason = "changed"  # type: ignore[misc]


def test_none_status_dispatches_never_reviewed():
    assert _decide(None) == Outcome(Decision.DISPATCH, "never_reviewed")


@pytest.mark.parametrize("status", [constants.STATUS_LAND, constants.STATUS_NO_LAND])
def test_terminal_same_hash_skips_decided(status):
    assert _decide(status, latest=HASH_A, current=HASH_A) == Outcome(Decision.SKIP, "decided")


@pytest.mark.parametrize("status", [constants.STATUS_LAND, constants.STATUS_NO_LAND])
def test_terminal_changed_hash_dispatches_changed(status):
    assert _decide(status, latest=HASH_A, current=HASH_B) == Outcome(Decision.DISPATCH, "changed")


def test_in_flight_changed_hash_dispatches_changed():
    outcome = _decide(constants.STATUS_AI_REVIEW_STARTED, latest=HASH_A, current=HASH_B, version=FRESH)
    assert outcome == Outcome(Decision.DISPATCH, "changed")


def test_in_flight_same_hash_within_timeout_waits():
    outcome = _decide(constants.STATUS_AI_REVIEW_STARTED, version=FRESH)
    assert outcome == Outcome(Decision.WAIT, "in_flight")


def test_in_flight_same_hash_at_timeout_boundary_dispatches_timed_out():
    outcome = _decide(constants.STATUS_AI_REVIEW_STARTED, version=AT_BOUNDARY)
    assert outcome == Outcome(Decision.DISPATCH, "timed_out")


def test_in_flight_same_hash_past_timeout_dispatches_timed_out():
    outcome = _decide(constants.STATUS_AI_REVIEW_STARTED, version=STALE)
    assert outcome == Outcome(Decision.DISPATCH, "timed_out")


def test_in_flight_missing_version_dispatches_timed_out():
    outcome = _decide(constants.STATUS_AI_REVIEW_STARTED, version=None)
    assert outcome == Outcome(Decision.DISPATCH, "timed_out")


@pytest.mark.parametrize("status", [constants.STATUS_CANCELLED, constants.STATUS_FAILED])
def test_retry_within_timeout_waits_backoff(status):
    assert _decide(status, version=FRESH) == Outcome(Decision.WAIT, "retry_backoff")


@pytest.mark.parametrize("status", [constants.STATUS_CANCELLED, constants.STATUS_FAILED])
def test_retry_at_timeout_boundary_dispatches_retry(status):
    assert _decide(status, version=AT_BOUNDARY) == Outcome(Decision.DISPATCH, "retry")


@pytest.mark.parametrize("status", [constants.STATUS_CANCELLED, constants.STATUS_FAILED])
def test_retry_past_timeout_dispatches_retry(status):
    assert _decide(status, version=STALE) == Outcome(Decision.DISPATCH, "retry")


def test_unknown_status_dispatches_unknown_status():
    assert _decide("SOMETHING_WEIRD", version=FRESH) == Outcome(Decision.DISPATCH, "unknown_status")
