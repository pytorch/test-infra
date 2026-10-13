"""Revoke greenlight's approval on a listed PR whose author is no longer eligible for it."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight import github_client
from greenlight.constants import BOT_LOGIN_SUFFIX, STATUS_LAND, TARGET_REPO, is_app_login
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    import threading
    from collections.abc import Callable, Mapping, Sequence

    from github import Github

    from greenlight.github_types import VerdictPR
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

_NO_LONGER_ELIGIBLE_MESSAGE = (
    "This pull request is no longer eligible for a greenlight review under merge_rules.yaml; "
    "greenlight's approval no longer applies."
)


def revoke_ineligible_approvals(
    client: Github,
    ineligible: Sequence[int],
    *,
    states: Mapping[int, PRState],
    bot_login: str,
    get_pr: Callable[[Github, str, int], VerdictPR],
    dismiss: Callable[..., list[int]],
    failed: list[int],
    cancel_event: threading.Event,
) -> None:
    """Dismiss greenlight's approval on each PR in ``ineligible`` whose latest recorded row is a LAND.

    Under merge_rules.yaml's wildcard Greenlight Review Bot rule, an approval greenlight gave while the
    PR was eligible still authorizes a merge, and the scan dispatches no review that would revoke it.
    Nothing is recorded, dispatched or poked. A failure is accounted as the revert guard accounts its
    own: a rate limit trips ``cancel_event``, and the PR fails the pass.
    """
    due = [number for number in ineligible if (row := states.get(number)) is not None and row.status == STATUS_LAND]
    if not due:
        return
    # As in revert_guard: an empty or non-App login matches no review, so it would dismiss nothing
    # while reporting success.
    if not is_app_login(bot_login):
        raise ValueError(
            f"BOT_LOGIN must be the greenlight App login (<app-slug>{BOT_LOGIN_SUFFIX}) to revoke approvals "
            f"on PR(s) no longer eligible {due}; got {bot_login!r}"
        )
    for number in due:
        try:
            dismissed = dismiss(
                get_pr(client, TARGET_REPO, number), bot_login=bot_login, message=_NO_LONGER_ELIGIBLE_MESSAGE
            )
        except IterationTimeout:
            raise
        except Exception as exc:
            if github_client.is_rate_limit_error(exc):
                cancel_event.set()
            logger.error(
                "failed to revoke greenlight approval on PR #%d, which is no longer eligible: %s",
                number,
                exc,
                exc_info=True,
            )
            failed.append(number)
            continue
        if dismissed:
            logger.info(
                "dismissed %d greenlight approval(s) on PR #%d, which is no longer eligible", len(dismissed), number
            )
