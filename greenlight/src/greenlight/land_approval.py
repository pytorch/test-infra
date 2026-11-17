"""GreenLight's approval of an authoritative LAND: pinned to the reviewed head, and withdrawn when the PR moved.

The approval is posted on the reviewed commit, never on whatever the head is by then. GreenLight's live approvals
stand as they are only when every one of them is on that commit and so is the review pytorchbot's trymerge counts
(``approvals.counted_review``), which must be an approval; otherwise they are dismissed and a pinned one is posted.
Right after posting, a fresh read of the PR must still find the reviewed head on a base the repo's rule accepts
(``merge_authz.accepts_base_for``), or GreenLight's approvals are dismissed. When that read fails, the approval
just posted is dismissed before the error propagates. Every dismissal and approval raises on failure: they are
what the merge gate reads.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight import approvals, github_client, merge_authz

if TYPE_CHECKING:
    from greenlight.github_types import DismissibleReview, VerdictClient, VerdictPR

logger = logging.getLogger(__name__)

# The APPROVE review is the merge gate; its body is intentionally empty so it adds no text on
# top of the canonical verdict comment, which already states the outcome.
LAND_REVIEW_BODY = ""
SUPERSEDED_MESSAGE = "Superseded by a newer greenlight verdict."
MOVED_MESSAGE = "The PR's head or base changed after greenlight approved it."
UNCONFIRMED_MESSAGE = "greenlight could not confirm the PR's head and base after approving it."


def dismiss_prior(pr: VerdictPR, *, repo: str, number: int, bot_login: str, message: str = SUPERSEDED_MESSAGE) -> None:
    """Dismiss every live greenlight approval on ``pr`` (``approvals.dismiss_prior_greenlight_approvals``)."""
    dismissed = approvals.dismiss_prior_greenlight_approvals(pr, bot_login=bot_login, message=message)
    if dismissed:
        logger.info("dismissed %d prior greenlight approval(s) on %s#%d", len(dismissed), repo, number)
    else:
        logger.info("no prior greenlight approval to dismiss on %s#%d", repo, number)


def approve(
    client: VerdictClient,
    pr: VerdictPR,
    *,
    repo: str,
    number: int,
    head_sha: str,
    bot_login: str,
    strict_base: bool,
) -> None:
    """Approve ``pr`` at ``head_sha`` unless greenlight's approval already stands there, then confirm it.

    It stands when greenlight's counted review is an approval on ``head_sha`` and so is every live one.
    ``strict_base`` is the ``gate`` repo's base rule (``merge_authz.accepts_base_for``).
    """
    reviews = list(pr.get_reviews())
    live = approvals.live_approvals(reviews, bot_login)
    counted = approvals.counted_review(reviews, bot_login)
    if (
        counted is not None
        and counted.state == approvals.REVIEW_STATE_APPROVED
        and approvals.on_commit(counted, head_sha)
        and all(approvals.on_commit(review, head_sha) for review in live)
    ):
        logger.info("already approved %s#%d at %s; skipping re-approval", repo, number, head_sha)
        return
    if live:
        dismissed = approvals.dismiss_approvals(live, SUPERSEDED_MESSAGE)
        logger.info("dismissed %d prior greenlight approval(s) on %s#%d", len(dismissed), repo, number)
    review = github_client.post_review(
        pr,
        event=github_client.REVIEW_EVENT_APPROVE,
        body=LAND_REVIEW_BODY,
        commit=client.get_repo(repo).get_commit(head_sha),
    )
    logger.info("approved %s#%d at %s", repo, number, head_sha)
    _confirm(client, pr, review, repo=repo, number=number, head_sha=head_sha, bot_login=bot_login, strict=strict_base)


def _confirm(
    client: VerdictClient,
    pr: VerdictPR,
    review: DismissibleReview,
    *,
    repo: str,
    number: int,
    head_sha: str,
    bot_login: str,
    strict: bool,
) -> None:
    try:
        fresh = github_client.get_pr(client, repo, number)
        fresh_head = fresh.head.sha
        fresh_base = fresh.base.ref
        accepted = merge_authz.accepts_base_for(fresh, strict=strict)
    except Exception:
        _withdraw(review, repo=repo, number=number)
        raise
    if fresh_head == head_sha and accepted:
        return
    logger.warning(
        "%s#%d moved after greenlight approved it: head %s -> %s, base %r -> %r; dismissing greenlight's approvals",
        repo,
        number,
        head_sha,
        fresh_head,
        pr.base.ref,
        fresh_base,
    )
    dismiss_prior(fresh, repo=repo, number=number, bot_login=bot_login, message=MOVED_MESSAGE)


def _withdraw(review: DismissibleReview, *, repo: str, number: int) -> None:
    try:
        review.dismiss(UNCONFIRMED_MESSAGE)
    except Exception:
        logger.error("cannot dismiss the approval just posted on %s#%d", repo, number, exc_info=True)
    else:
        logger.warning("dismissed the approval just posted on %s#%d: the PR could not be read after it", repo, number)
