"""Whose evaluation in one scan carries authority, judged from the merge rules and the listing alone.

``eligible_rule`` asks ``cohort.assess_rules`` about one PR and logs the answer. ``Authority``
answers for one pass from what the listing already holds, so it makes no GitHub call: a listed PR is
eligible when a valid merge rule names its author and the listing did not show a base trymerge
refuses. ``eligible`` picks who is fingerprinted and whose approval the ineligible revoke covers;
``shadow`` is the stamp, which a repo in shadow mode (``forced_shadow``) puts on every PR. It also
answers the stamp for a REVERTED row, the one row that denies, keeping it visible on every recorded
PR.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, NamedTuple

from greenlight import cohort

if TYPE_CHECKING:
    from collections.abc import Collection, Mapping, Sequence

    from greenlight.cohort import EligibilityRule

logger = logging.getLogger(__name__)


class Target(NamedTuple):
    """The ``--pr`` target as its gate judged it.

    A ``refused`` target is never fingerprinted or dispatched; it only reaches the revert guard.
    """

    number: int
    author: str | None
    shadow: bool
    refused: bool = False


def eligible_rule(number: int, login: str | None, rules: Sequence[EligibilityRule]) -> EligibilityRule | None:
    """``cohort.assess_rules`` for PR ``number``, logging its reason."""
    rule, reason = cohort.assess_rules(login, rules)
    logger.info("PR #%d by %s: %s", number, login, reason)
    return rule


class Authority:
    """The scan's eligibility and ``shadow_for_pr``: a PR is shadow when forced or when its author is not eligible.

    ``authors`` maps each listed PR to its author, except a PR listed on a base trymerge refuses
    (``pr_listing.candidate_numbers``); a number outside it is not eligible. ``target`` seeds the
    ``--pr`` gate's answer, which is never re-judged. Each PR is judged at most once per pass.
    """

    def __init__(
        self,
        *,
        rules: Sequence[EligibilityRule],
        authors: Mapping[int, str | None],
        recorded: Collection[int],
        target: Target | None = None,
        forced_shadow: bool = False,
    ) -> None:
        self._rules = rules
        self._forced_shadow = forced_shadow
        self._authors = dict(authors)
        self._recorded = recorded
        self._memo: dict[int, bool] = {}
        if target is not None:
            self._authors[target.number] = target.author
            self._memo[target.number] = target.shadow

    def eligible(self, number: int) -> bool:
        memoized = self._memo.get(number)
        if memoized is None:
            memoized = number not in self._authors or eligible_rule(number, self._authors[number], self._rules) is None
            self._memo[number] = memoized
        return not memoized

    def shadow(self, number: int) -> bool:
        return self._forced_shadow or not self.eligible(number)

    def reverted_shadow(self, number: int) -> bool:
        """``shadow`` for a REVERTED row, which stays visible on every recorded PR.

        A shadow REVERTED row is invisible to Dr. CI and the land gate, which then keep reading any
        authoritative row beneath it, and a REVERTED row can only deny. A recorded PR therefore gets a
        non-shadow one whatever its author or base show now.
        """
        if number in self._recorded:
            return False
        return self.shadow(number)
