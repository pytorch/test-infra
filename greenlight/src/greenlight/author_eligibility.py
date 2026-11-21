"""The record job's eligibility check: whose verdict carries authority, decided live for one PR."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight import cohort, github_client, merge_authz, writers

if TYPE_CHECKING:
    from greenlight.repo_config import Eligibility

__all__ = ["has_eligible_author"]

logger = logging.getLogger(__name__)

_LOG_LABEL: dict[Eligibility, str] = {"merge_rules": "merge-rule", "write_permission": "write-permission"}


def has_eligible_author(
    token: str,
    repo: str,
    pr_number: int,
    head_sha: str,
    author: str | None,
    *,
    eligibility: Eligibility,
    author_type: str | None,
) -> bool:
    """True when ``repo``'s eligibility source qualifies ``author`` and the PR is still as reviewed.

    Every failure raises.

    ``merge_rules``: ``cohort.assess_rules`` decides on the author against ``repo``'s merge rules.
    ``write_permission``: ``writers.author_has_write`` decides on the author's live permission and
    ``author_type``, the account type on the PR the caller read. One fresh read of the PR must then find
    its head still at ``head_sha``, the reviewed commit, on a base ``merge_authz.accepts_base`` accepts,
    so a PR reviewed for its native stack on main must still be in one. A push to the base branch is not
    caught.
    """
    client = github_client.build_authz_client(token)
    try:
        if eligibility == "write_permission":
            rule, reason = writers.author_has_write(client, repo, author, author_type)
        else:
            rule, reason = cohort.assess_rules(author, merge_authz.resolve_merge_rules(client, repo).rules)
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
        _LOG_LABEL[eligibility],
        repo,
        pr_number,
        author,
        "eligible" if rule is not None else f"not eligible: {reason}",
    )
    return rule is not None
