"""The record job's eligibility check: whose verdict carries authority, decided live for one PR."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, assert_never

from greenlight import cohort, github_client, merge_authz, writers

if TYPE_CHECKING:
    from greenlight.repo_config import Eligibility, MinimumRole

__all__ = ["has_eligible_author"]

logger = logging.getLogger(__name__)


def has_eligible_author(
    token: str,
    repo: str,
    pr_number: int,
    head_sha: str,
    author: str | None,
    *,
    eligibility: Eligibility,
    minimum_role: MinimumRole,
    author_type: str | None,
) -> bool:
    """True when ``repo``'s eligibility source qualifies ``author`` and the PR is still as reviewed.

    Every failure raises.

    ``merge_rules``: ``cohort.assess_rules`` decides on the author against ``repo``'s merge rules.
    ``write_permission``: ``writers.author_holds_role`` decides on the author's live permission against
    ``minimum_role`` and on ``author_type``, the account type on the PR the caller read. One fresh read of
    the PR must then find its head still at ``head_sha``, the reviewed commit, on a base
    ``merge_authz.accepts_base`` accepts, so a PR reviewed for its native stack on main must still be in
    one. A push to the base branch is not caught.
    """
    client = github_client.build_authz_client(token)
    try:
        match eligibility:
            case "write_permission":
                label = f"{minimum_role}-permission"
                rule, reason = writers.author_holds_role(client, repo, author, author_type, minimum_role=minimum_role)
            case "merge_rules":
                label = "merge-rule"
                rule, reason = cohort.assess_rules(author, merge_authz.resolve_merge_rules(client, repo).rules)
            case _:
                assert_never(eligibility)
        if rule is not None:
            pull = client.get_repo(repo).get_pull(pr_number)
            if pull.head.sha != head_sha:
                rule, reason = None, "head moved"
            elif not merge_authz.accepts_base(pull):
                rule, reason = None, "base not accepted"
    finally:
        github_client.close_client(client)
    # The record job's log is public: the reason names no rule, team or file, and none may be added.
    logger.info(
        "%s eligibility on %s#%d: author %r is %s",
        label,
        repo,
        pr_number,
        author,
        "eligible" if rule is not None else f"not eligible: {reason}",
    )
    return rule is not None
