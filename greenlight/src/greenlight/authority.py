"""Whose evaluation in one scan carries authority, judged from the merge rules and the listing alone.

``eligible_rule`` asks ``cohort.assess_rules`` about one PR and logs the answer. ``Authority``
answers ``shadow_for_pr`` for one pass from what the listing already holds, so it makes no GitHub
call: a PR is shadow unless it was listed on a base trymerge accepts and a valid merge rule names its
author. It also answers the stamp for a REVERTED row, the one row that denies, keeping it visible on
every recorded PR.
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
    """The scan's ``shadow_for_pr``: a PR is shadow unless its author is eligible for it.

    ``authors`` maps each listed PR to its author, except a PR listed on a base trymerge refuses
    (``pr_listing.candidate_numbers``); a number outside it is shadow. ``target`` seeds the ``--pr``
    gate's answer, which is never re-judged. Each PR is judged at most once per pass.
    """

    def __init__(
        self,
        *,
        rules: Sequence[EligibilityRule],
        authors: Mapping[int, str | None],
        recorded: Collection[int],
        target: Target | None = None,
    ) -> None:
        self._rules = rules
        self._authors = dict(authors)
        self._recorded = recorded
        self._memo: dict[int, bool] = {}
        if target is not None:
            self._authors[target.number] = target.author
            self._memo[target.number] = target.shadow

    def shadow(self, number: int) -> bool:
        memoized = self._memo.get(number)
        if memoized is not None:
            return memoized
        if number not in self._authors:
            return True
        answer = eligible_rule(number, self._authors[number], self._rules) is None
        self._memo[number] = answer
        return answer

    def reverted_shadow(self, number: int) -> bool:
        """``shadow`` for a REVERTED row, which stays visible on every recorded PR.

        A shadow REVERTED row is invisible to Dr. CI and the land gate, which then keep reading any
        authoritative row beneath it, and a REVERTED row can only deny. A recorded PR therefore gets a
        non-shadow one whatever its author or base show now.
        """
        if number in self._recorded:
            return False
        return self.shadow(number)
