"""GreenLight's approval of an authoritative LAND: pinned to the reviewed head, and withdrawn when the PR moved.

The approval is posted on the reviewed commit, never on whatever the head is by then. On a ``pytorchbot`` repo
GreenLight's live approvals stand as they are only when every one of them is on that commit and so is the review
pytorchbot's trymerge counts (``approvals.counted_review``), which must be an approval; on a ``gate`` repo they never
do, so the approval always postdates the review it records. Otherwise they are dismissed and a pinned one is posted.
Right after posting, a fresh read of the PR must still find the reviewed head on a base the repo's rule accepts
(``merge_authz.accepts_base_for``). When it does not, the approval just posted is dismissed, then every other live
GreenLight approval not on the freshly read head, so a newer record job's approval of that head stands; on a base
the rule refuses, those on the fresh head go too. When that read fails, the approval just posted is dismissed
before the error propagates. When the approval itself fails, a fresh read clears the approvals the same way before
the error propagates. Every dismissal and approval raises on failure: they are what the merge gate reads.

``gate_backs`` decides whether a ``gate`` repo's LAND may be approved at all: given as ``approvals.GREENLIGHT_LOGIN``,
the account the merge gate and the scan judge, on a repo whose branch rules enforce the gate (``gate_rules``).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight import approvals, github_client, merge_authz
from greenlight.gate_rules import read_gate_rules

if TYPE_CHECKING:
    from greenlight.github_types import DismissibleReview, PostedReview, VerdictClient, VerdictPR, _VerdictReview

logger = logging.getLogger(__name__)

# The APPROVE review is the merge gate; its body is intentionally empty so it adds no text on
# top of the canonical verdict comment, which already states the outcome.
LAND_REVIEW_BODY = ""
SUPERSEDED_MESSAGE = "Superseded by a newer greenlight verdict."
MOVED_MESSAGE = "The PR's head or base changed after greenlight approved it."
UNCONFIRMED_MESSAGE = "greenlight could not confirm the PR's head and base after approving it."
UNPOSTED_MESSAGE = "greenlight could not approve the PR's reviewed head; this approval is off its current head or base."


def dismiss_prior(pr: VerdictPR, *, repo: str, number: int, bot_login: str, message: str = SUPERSEDED_MESSAGE) -> None:
    """Dismiss every live greenlight approval on ``pr`` (``approvals.dismiss_prior_greenlight_approvals``)."""
    dismissed = approvals.dismiss_prior_greenlight_approvals(pr, bot_login=bot_login, message=message)
    if dismissed:
        logger.info("dismissed %d prior greenlight approval(s) on %s#%d", len(dismissed), repo, number)
    else:
        logger.info("no prior greenlight approval to dismiss on %s#%d", repo, number)


def gate_backs(token: str, repo: str, *, bot_login: str) -> bool:
    """Whether a ``gate`` repo's LAND by ``bot_login`` can take its approval; a failed rules read raises."""
    if bot_login != approvals.GREENLIGHT_LOGIN:
        logger.warning(
            "%s: --bot-login %r is not %s, whom the gate judges", repo, bot_login, approvals.GREENLIGHT_LOGIN
        )
        return False
    client = github_client.build_authz_client(token)
    try:
        rules = read_gate_rules(client, repo)
    finally:
        github_client.close_client(client)
    if not rules.enforced:
        logger.warning("%s does not enforce the gate: %s", repo, "; ".join(rules.problems))
    return rules.enforced


def approve(
    client: VerdictClient,
    pr: VerdictPR,
    *,
    repo: str,
    number: int,
    head_sha: str,
    bot_login: str,
    strict_base: bool,
    keep_standing: bool,
) -> None:
    """Approve ``pr`` at ``head_sha``, then confirm it.

    ``keep_standing`` (a ``pytorchbot`` repo) leaves greenlight's approval as it is when its counted review is an
    approval on ``head_sha`` and so is every live one. ``strict_base`` is the ``gate`` repo's base rule
    (``merge_authz.accepts_base_for``).
    """
    reviews = list(pr.get_reviews())
    live = approvals.live_approvals(reviews, bot_login)
    if keep_standing and _stands(reviews, live, bot_login, head_sha):
        logger.info("already approved %s#%d at %s; skipping re-approval", repo, number, head_sha)
        return
    if live:
        dismissed = approvals.dismiss_approvals(live, SUPERSEDED_MESSAGE)
        logger.info("dismissed %d prior greenlight approval(s) on %s#%d", len(dismissed), repo, number)
    commit = client.get_repo(repo).get_commit(head_sha)
    try:
        review = github_client.post_review(
            pr, event=github_client.REVIEW_EVENT_APPROVE, body=LAND_REVIEW_BODY, commit=commit
        )
    except Exception:
        _clear_after_failed_post(client, repo=repo, number=number, bot_login=bot_login, strict=strict_base)
        raise
    logger.info("approved %s#%d at %s", repo, number, head_sha)
    _confirm(client, pr, review, repo=repo, number=number, head_sha=head_sha, bot_login=bot_login, strict=strict_base)


def _stands(reviews: list[_VerdictReview], live: list[_VerdictReview], bot_login: str, head_sha: str) -> bool:
    counted = approvals.counted_review(reviews, bot_login)
    return (
        counted is not None
        and counted.state == approvals.REVIEW_STATE_APPROVED
        and approvals.on_commit(counted, head_sha)
        and all(approvals.on_commit(review, head_sha) for review in live)
    )


def _dismiss_off_head(fresh: VerdictPR, *, bot_login: str, keep_on: str | None, skip: int | None, message: str) -> int:
    """Dismiss ``bot_login``'s live approvals on ``fresh`` but those on ``keep_on`` (None: keep none) and ``skip``."""
    stale = [
        review
        for review in approvals.live_approvals(fresh.get_reviews(), bot_login)
        if review.id != skip and (keep_on is None or not approvals.on_commit(review, keep_on))
    ]
    return len(approvals.dismiss_approvals(stale, message))


def _clear_after_failed_post(client: VerdictClient, *, repo: str, number: int, bot_login: str, strict: bool) -> None:
    try:
        fresh = github_client.get_pr(client, repo, number)
        keep_on = fresh.head.sha if merge_authz.accepts_base_for(fresh, strict=strict) else None
        dismissed = _dismiss_off_head(fresh, bot_login=bot_login, keep_on=keep_on, skip=None, message=UNPOSTED_MESSAGE)
    except Exception:
        logger.error(
            "cannot clear greenlight's approvals on %s#%d after its approval failed", repo, number, exc_info=True
        )
    else:
        logger.warning(
            "greenlight's approval of %s#%d failed; dismissed %d approval(s) off its current head or base",
            repo,
            number,
            dismissed,
        )


def _confirm(
    client: VerdictClient,
    pr: VerdictPR,
    review: PostedReview,
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
    if approvals.same_sha(fresh_head, head_sha) and accepted:
        return
    logger.warning(
        "%s#%d moved after greenlight approved it: head %s -> %s, base %r -> %r (%s)",
        repo,
        number,
        head_sha,
        fresh_head,
        pr.base.ref,
        fresh_base,
        "accepted" if accepted else "refused",
    )
    review.dismiss(MOVED_MESSAGE)
    keep_on = fresh_head if accepted else None
    try:
        dismissed = _dismiss_off_head(
            fresh, bot_login=bot_login, keep_on=keep_on, skip=review.id, message=MOVED_MESSAGE
        )
    except Exception:
        logger.error(
            "dismissed the approval just posted on %s#%d, but not every other one", repo, number, exc_info=True
        )
        raise
    logger.info(
        "dismissed the approval just posted on %s#%d and %d other greenlight approval(s) %s",
        repo,
        number,
        dismissed,
        f"not on its new head {fresh_head}" if accepted else "on a base its rule refuses",
    )


def _withdraw(review: DismissibleReview, *, repo: str, number: int) -> None:
    try:
        review.dismiss(UNCONFIRMED_MESSAGE)
    except Exception:
        logger.error("cannot dismiss the approval just posted on %s#%d", repo, number, exc_info=True)
    else:
        logger.warning("dismissed the approval just posted on %s#%d: the PR could not be read after it", repo, number)
