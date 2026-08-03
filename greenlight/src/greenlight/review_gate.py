"""Detect PRs already decided by a human so the scan can skip fingerprinting + dispatch.

Pure logic: no PyGithub import and no GitHub I/O. ``github_client.fingerprint_pr`` feeds
this the already-materialized ``get_reviews()`` list, so a skip costs only that one call.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from greenlight.pr_hash import is_bot

if TYPE_CHECKING:
    from collections.abc import Iterable
    from typing import Protocol

    class _ReviewUser(Protocol):
        @property
        def login(self) -> str | None: ...
        @property
        def type(self) -> str | None: ...

    class _Review(Protocol):
        @property
        def user(self) -> _ReviewUser | None: ...
        @property
        def state(self) -> str: ...


HUMAN_APPROVED = "human_approved"
CHANGES_REQUESTED = "changes_requested"

_STATE_APPROVED = "APPROVED"
_STATE_CHANGES_REQUESTED = "CHANGES_REQUESTED"
_STATE_COMMENTED = "COMMENTED"


@dataclass(frozen=True)
class ReviewSkip:
    reason: str
    detail: str


def human_review_skip_reason(
    reviews: Iterable[_Review],
    authorized_logins: frozenset[str],
    *,
    skip_on_approval: bool,
) -> ReviewSkip | None:
    """Return why the scan may skip this PR's fingerprint, or None to fingerprint normally.

    ``authorized_logins`` is the lowercased merge-authorized set; it MAY include greenlight's
    own bot login, which the bot check (never set membership) excludes from both rules.
    """
    # Mirrors mergebot trymerge.py: the latest non-COMMENTED review per login wins (COMMENTED
    # never overwrites a prior decision); input order is preserved so the last decision wins.
    latest: dict[str, tuple[str, str | None]] = {}
    for review in reviews:
        user = review.user
        if user is None:
            continue
        login = user.login
        if not login:
            continue
        if review.state == _STATE_COMMENTED:
            continue
        latest[login] = (review.state, user.type)

    for login, (review_state, user_type) in latest.items():
        if review_state == _STATE_CHANGES_REQUESTED and not is_bot(login, user_type):
            return ReviewSkip(CHANGES_REQUESTED, f"changes requested by {login}")

    if skip_on_approval:
        for login, (review_state, user_type) in latest.items():
            if review_state == _STATE_APPROVED and not is_bot(login, user_type) and login.lower() in authorized_logins:
                return ReviewSkip(HUMAN_APPROVED, f"approved by {login}")

    return None
