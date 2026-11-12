"""Who greenlight evaluates, and whose evaluation carries authority.

``evaluation_cohort`` answers the first: pytorch/pytorch's merge_rules approver set, minus bots and
greenlight itself. ``assess_rules`` answers the second, for the scan and the verdict alike: a valid
merge rule must name the author, whatever files the PR changes; the callers also require a base
trymerge accepts (``merge_authz.accepts_base``). Every other evaluation is shadow: recorded as usual,
but never approved and never rendered by Dr. CI.

``pr_hash`` is the only greenlight import, and deliberately so -- its ``is_bot`` is the one bot
predicate the fingerprint already relies on, and a second list here would drift from it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, NamedTuple, Protocol

from greenlight.pr_hash import is_bot

if TYPE_CHECKING:
    from collections.abc import Sequence

__all__ = ["GREENLIGHT_APP_SLUG", "Eligibility", "EligibilityRule", "assess_rules", "evaluation_cohort"]

# greenlight's own App slug. merge_rules.yaml names bare logins, so an entry for greenlight
# resolves to this bare form -- which ``is_bot`` does not match: it is absent from BOT_LOGINS and
# carries no ``[bot]`` suffix. Only the REST-side ``pytorchgreenlight[bot]`` login is bot-shaped,
# so without this guard greenlight enters its own cohort and reviews its own pull requests.
GREENLIGHT_APP_SLUG = "pytorchgreenlight"


def _is_evaluable(login: str) -> bool:
    return bool(login) and not is_bot(login) and login.lower() != GREENLIGHT_APP_SLUG


def evaluation_cohort(authorized_logins: frozenset[str]) -> frozenset[str]:
    """Lowercase the merge-authorized logins greenlight evaluates: approvers, minus bots and itself."""
    return frozenset(login.lower() for login in authorized_logins if _is_evaluable(login))


class EligibilityRule(Protocol):
    """Structural merge rule for ``assess_rules``; ``merge_authz.MergeRule`` satisfies it."""

    @property
    def approvers(self) -> frozenset[str]: ...
    @property
    def valid(self) -> bool: ...


class Eligibility(NamedTuple):
    rule: EligibilityRule | None
    reason: str


def assess_rules(login: str | None, rules: Sequence[EligibilityRule]) -> Eligibility:
    """Return a valid merge rule that names ``login``, or None, with a reason.

    Rule membership is exact-case, as trymerge compares approvers. Any valid rule qualifies, whatever
    its paths: whether the PR's changes need a human is the review's call. A rule whose patterns
    trymerge rejects matches no file, so it is ignored and qualifies nobody. The reason names no rule,
    and an eligible one is plain "eligible": the kind of rule that matched could reveal a concealed
    team membership.
    """
    if not login:
        return Eligibility(None, "no author")
    if not _is_evaluable(login):
        return Eligibility(None, "excluded (bot or greenlight)")
    valid = [rule for rule in rules if rule.valid]
    for rule in valid:
        if login in rule.approvers:
            return Eligibility(rule, "eligible")
    return Eligibility(None, _unnamed_reason(login, valid))


def _unnamed_reason(login: str, rules: Sequence[EligibilityRule]) -> str:
    reason = f"no merge rule names {login!r} in exact case"
    lowered = login.lower()
    variants = {approver for rule in rules for approver in rule.approvers if approver.lower() == lowered}
    if variants:
        # min(): approvers are frozensets, whose iteration order changes from one process to the next.
        reason += f"; a rule names {min(variants)!r}"
    return reason
