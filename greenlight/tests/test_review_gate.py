from dataclasses import dataclass

import pytest

from greenlight.review_gate import (
    CHANGES_REQUESTED,
    HUMAN_APPROVED,
    ReviewSkip,
    human_review_skip_reason,
)


@dataclass
class _User:
    login: str | None
    type: str | None = "User"


@dataclass
class _Review:
    state: str
    user: _User | None


def _rev(login: str | None, state: str, *, user_type: str | None = "User") -> _Review:
    return _Review(state=state, user=_User(login=login, type=user_type))


_AUTH = frozenset({"alice", "bob"})


def test_approved_by_authorized_human_returns_human_approved():
    result = human_review_skip_reason([_rev("alice", "APPROVED")], _AUTH, skip_on_approval=True)

    assert result == ReviewSkip(HUMAN_APPROVED, "approved by alice")


def test_approved_by_non_authorized_returns_none():
    assert human_review_skip_reason([_rev("mallory", "APPROVED")], _AUTH, skip_on_approval=True) is None


@pytest.mark.parametrize(
    ("login", "user_type"),
    [
        ("alice", "Bot"),  # authorized login, but a Bot account
        ("alice[bot]", "User"),  # authorized-shaped login, but a [bot] suffix
    ],
)
def test_approved_by_bot_returns_none_even_if_in_authorized(login: str, user_type: str) -> None:
    authorized = frozenset({login.lower()})

    result = human_review_skip_reason([_rev(login, "APPROVED", user_type=user_type)], authorized, skip_on_approval=True)

    assert result is None


def test_changes_requested_by_anyone_returns_changes_requested():
    # carol need not be authorized: a change request from any human blocks.
    result = human_review_skip_reason([_rev("carol", "CHANGES_REQUESTED")], _AUTH, skip_on_approval=True)

    assert result == ReviewSkip(CHANGES_REQUESTED, "changes requested by carol")


def test_changes_requested_takes_priority_over_approval():
    reviews = [_rev("alice", "APPROVED"), _rev("bob", "CHANGES_REQUESTED")]

    result = human_review_skip_reason(reviews, _AUTH, skip_on_approval=True)

    assert result == ReviewSkip(CHANGES_REQUESTED, "changes requested by bob")


def test_approval_then_commented_keeps_approval():
    reviews = [_rev("alice", "APPROVED"), _rev("alice", "COMMENTED")]

    result = human_review_skip_reason(reviews, _AUTH, skip_on_approval=True)

    assert result == ReviewSkip(HUMAN_APPROVED, "approved by alice")


def test_approval_then_changes_requested_latest_wins():
    reviews = [_rev("alice", "APPROVED"), _rev("alice", "CHANGES_REQUESTED")]

    result = human_review_skip_reason(reviews, _AUTH, skip_on_approval=True)

    assert result == ReviewSkip(CHANGES_REQUESTED, "changes requested by alice")


def test_dismissed_approval_returns_none():
    assert human_review_skip_reason([_rev("alice", "DISMISSED")], _AUTH, skip_on_approval=True) is None


def test_approval_then_dismissed_returns_none():
    reviews = [_rev("alice", "APPROVED"), _rev("alice", "DISMISSED")]

    assert human_review_skip_reason(reviews, _AUTH, skip_on_approval=True) is None


def test_empty_reviews_returns_none():
    assert human_review_skip_reason([], _AUTH, skip_on_approval=True) is None


def test_skip_on_approval_false_suppresses_approval_but_not_changes_requested():
    approved = [_rev("alice", "APPROVED")]
    assert human_review_skip_reason(approved, _AUTH, skip_on_approval=False) is None

    changes = [_rev("bob", "CHANGES_REQUESTED")]
    assert human_review_skip_reason(changes, _AUTH, skip_on_approval=False) == ReviewSkip(
        CHANGES_REQUESTED, "changes requested by bob"
    )


def test_review_with_no_user_is_skipped():
    reviews = [_Review(state="APPROVED", user=None), _Review(state="CHANGES_REQUESTED", user=None)]

    assert human_review_skip_reason(reviews, _AUTH, skip_on_approval=True) is None


@pytest.mark.parametrize("login", [None, ""])
def test_review_with_null_or_empty_login_is_skipped(login: str | None) -> None:
    assert human_review_skip_reason([_rev(login, "APPROVED")], _AUTH, skip_on_approval=True) is None
    assert human_review_skip_reason([_rev(login, "CHANGES_REQUESTED")], _AUTH, skip_on_approval=True) is None


def test_changes_requested_by_bot_does_not_block():
    result = human_review_skip_reason([_rev("ci[bot]", "CHANGES_REQUESTED")], _AUTH, skip_on_approval=True)

    assert result is None


def test_authorized_membership_is_case_insensitive_and_detail_keeps_original_login():
    result = human_review_skip_reason([_rev("Alice", "APPROVED")], frozenset({"alice"}), skip_on_approval=True)

    assert result == ReviewSkip(HUMAN_APPROVED, "approved by Alice")


def test_commented_only_reviews_return_none():
    reviews = [_rev("alice", "COMMENTED"), _rev("bob", "COMMENTED")]

    assert human_review_skip_reason(reviews, _AUTH, skip_on_approval=True) is None


def test_multiple_approvers_only_authorized_one_triggers_skip():
    reviews = [_rev("mallory", "APPROVED"), _rev("bob", "APPROVED")]

    result = human_review_skip_reason(reviews, _AUTH, skip_on_approval=True)

    assert result == ReviewSkip(HUMAN_APPROVED, "approved by bob")


def test_own_bot_login_in_authorized_set_is_excluded_from_approval():
    authorized = frozenset({"pytorchgreenlight[bot]"})
    reviews = [_rev("pytorchgreenlight[bot]", "APPROVED")]

    assert human_review_skip_reason(reviews, authorized, skip_on_approval=True) is None


def test_approved_by_denylist_bot_login_in_authorized_returns_none():
    # pytorchbot is a User-type account with no [bot] suffix, but it sits in pr_hash.BOT_LOGINS
    # and appears in merge_rules approved_by, so it enters authorized_logins; the shared denylist
    # must still keep its approval from counting as a human sign-off.
    authorized = frozenset({"pytorchbot"})

    result = human_review_skip_reason([_rev("pytorchbot", "APPROVED")], authorized, skip_on_approval=True)

    assert result is None


def test_changes_requested_by_denylist_bot_login_returns_none():
    authorized = frozenset({"pytorchbot"})

    result = human_review_skip_reason([_rev("pytorchbot", "CHANGES_REQUESTED")], authorized, skip_on_approval=True)

    assert result is None
