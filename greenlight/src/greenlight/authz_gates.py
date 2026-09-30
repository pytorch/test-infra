"""The review scan's two authz gates: who may request a review, and whose PR ``--pr`` may name.

Both run once the trusted-authors issue and the merge rules are resolved. The ``@greenlight
recheck`` requester must be listed in the issue and in the evaluation cohort; the ``--pr`` target's
author must be eligible for that PR. The cohort widens who greenlight looks at on its own schedule,
never who can point it at a PR. A refusal is logged and dispatches nothing, but a listed author's
refused PR still goes through the revert guard, and a failure there fails the pass.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight.authority import Target, covering_rule, is_listed
from greenlight.constants import TARGET_REPO
from greenlight.merge_authz import changed_files

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from github import Github

    from greenlight.cohort import EligibilityRule
    from greenlight.github_types import VerdictPR

logger = logging.getLogger(__name__)


def requester_allowed(requester: str, listed: frozenset[str], evaluable: frozenset[str]) -> bool:
    if requester.lower() not in (listed & evaluable):
        logger.warning("refusing review: requester %r is not a trusted author", requester)
        return False
    logger.info("review requested by trusted author %s", requester)
    return True


def admit_target(
    client: Github,
    pr: int,
    *,
    listed: frozenset[str],
    rules: Sequence[EligibilityRule],
    get_pr: Callable[[Github, str, int], VerdictPR],
    allow_untrusted_author: bool,
) -> Target | None:
    """Judge the ``--pr`` target, or return None when the run must refuse it outright.

    ``--pr`` names an arbitrary PR, so it is refused unless its author is eligible for that PR, or
    greenlight would review/approve any PR on request. A listed author's refused PR comes back as a
    ``refused`` target instead, for the revert guard alone: an author outside every merge rule is
    outside the cohort the scheduled scan lists, so nothing else would revoke it. ``allow_untrusted_author``
    (local iteration; never a workflow input) waives ONLY the refusal, never the lookup: a shadow LAND
    dismisses greenlight's live approval, so a skipped lookup would let a local flag revoke a real one.
    A failed read propagates, failing the pass before the revert guard runs for the target.
    """
    target = get_pr(client, TARGET_REPO, pr)
    user = target.user
    author = user.login if user is not None else None
    read_at: str | None = None

    def files() -> tuple[str, ...] | None:
        nonlocal read_at
        read_at = target.head.sha
        return changed_files(target)

    rule = covering_rule(pr, author, listed, rules, files)
    if rule is not None:
        return Target(pr, author, False, read_at)
    if allow_untrusted_author:
        logger.warning("--allow-untrusted-author: reviewing --pr %d by ineligible %r in shadow", pr, author)
        return Target(pr, author, True, read_at)
    logger.warning("refusing --pr %d: author %r is not eligible for it", pr, author)
    return Target(pr, author, True, read_at, refused=True) if is_listed(author, listed) else None
