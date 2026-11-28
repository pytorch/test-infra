"""Revoke greenlight's approval on a listed PR that is no longer eligible for a greenlight review."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight import github_client
from greenlight.constants import BOT_LOGIN_SUFFIX, STATUS_LAND, is_app_login
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    import threading
    from collections.abc import Callable, Mapping, Sequence

    from github import Github

    from greenlight.github_types import VerdictPR
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

_NO_LONGER_ELIGIBLE_MESSAGE = (
    "This pull request is no longer eligible for a greenlight review: merge_rules.yaml does not name "
    "its author, or trymerge does not accept its base branch; greenlight's approval no longer applies."
)


def dismiss_each(
    client: Github,
    numbers: Sequence[int],
    *,
    repo: str,
    bot_login: str,
    message: str,
    why: str,
    get_pr: Callable[[Github, str, int], VerdictPR],
    dismiss: Callable[..., list[int]],
    failed: list[int],
    cancel_event: threading.Event,
) -> dict[int, int]:
    """Dismiss greenlight's live approval on each PR in ``numbers``; return how many each PR that was read had.

    ``why`` completes the log lines ("PR #N, <why>"). An empty or non-App ``bot_login`` matches no
    review, so it would dismiss nothing while reporting success: it raises before any write. A
    failure on a PR is logged and the PR appended to ``failed``; a rate limit also trips
    ``cancel_event``. ``IterationTimeout`` propagates.
    """
    if not numbers:
        return {}
    if not is_app_login(bot_login):
        raise ValueError(
            f"BOT_LOGIN must be the greenlight App login (<app-slug>{BOT_LOGIN_SUFFIX}) to revoke approvals "
            f"on PR(s) {list(numbers)}, {why}; got {bot_login!r}"
        )
    outcomes: dict[int, int] = {}
    for number in numbers:
        try:
            dismissed = dismiss(get_pr(client, repo, number), bot_login=bot_login, message=message)
        except IterationTimeout:
            raise
        except Exception as exc:
            if github_client.is_rate_limit_error(exc):
                cancel_event.set()
            logger.error("failed to revoke greenlight approval on PR #%d, %s: %s", number, why, exc, exc_info=True)
            failed.append(number)
            continue
        outcomes[number] = len(dismissed)
        if dismissed:
            logger.info("dismissed %d greenlight approval(s) on PR #%d, %s", len(dismissed), number, why)
    return outcomes


def revoke_ineligible_approvals(
    client: Github,
    ineligible: Sequence[int],
    *,
    repo: str,
    states: Mapping[int, PRState],
    bot_login: str,
    get_pr: Callable[[Github, str, int], VerdictPR],
    dismiss: Callable[..., list[int]],
    failed: list[int],
    cancel_event: threading.Event,
) -> None:
    """Dismiss greenlight's approval on each PR in ``ineligible`` whose latest recorded row is a LAND.

    A PR is ineligible when no valid merge rule names its author or it was listed on a base trymerge
    refuses. Under merge_rules.yaml's wildcard Greenlight Review Bot rule, an approval greenlight gave
    while the PR was eligible still authorizes a merge, and the scan dispatches no review that would
    revoke it.
    Nothing is recorded, dispatched or poked. A failure is accounted as the revert guard accounts its
    own: a rate limit trips ``cancel_event``, and the PR fails the pass.
    """
    due = [number for number in ineligible if (row := states.get(number)) is not None and row.status == STATUS_LAND]
    dismiss_each(
        client,
        due,
        repo=repo,
        bot_login=bot_login,
        message=_NO_LONGER_ELIGIBLE_MESSAGE,
        why="which is no longer eligible",
        get_pr=get_pr,
        dismiss=dismiss,
        failed=failed,
        cancel_event=cancel_event,
    )
