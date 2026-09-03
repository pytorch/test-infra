"""Who greenlight evaluates, and whose evaluation carries authority.

Two independent questions, single-sourced here so the scan, the verdict path and the state
writers cannot drift apart on either. ``evaluation_cohort`` answers the first: pytorch/pytorch's
merge_rules approver set, minus bots and minus greenlight itself. ``is_trusted`` / ``is_shadow``
answer the second: a shadow author's PR is still fingerprinted, dispatched and recorded, but is
never approved and never rendered by Dr. CI.

``pr_hash`` is the only greenlight import, and deliberately so -- its ``is_bot`` is the one bot
predicate the fingerprint already relies on, and a second list here would drift from it.
"""

from __future__ import annotations

from greenlight.pr_hash import is_bot

__all__ = ["GREENLIGHT_APP_SLUG", "TRUSTED_AUTHORS", "evaluation_cohort", "is_shadow", "is_trusted"]

TRUSTED_AUTHORS: set[str] = {
    "albanD",  # Alban Desmaison
    "jathu",  # Jathu Satkunarajah
    "atalman",  # Andrey Talman
    "huydhn",  # Huy Do
    "izaitsevfb",  # Ivan Zaitsev
    "georgehong",  # George Hong
    "jeanschmidt",  # Jean Schmidt
    "ezyang",  # Edward Yang
    "drisspg",  # Driss Guessous
    "janeyx99",  # Jane Xu
    "bobrenjc93",  # Bob Ren
}

# Case-insensitive membership for the two authz gates (target-PR author and recheck requester);
# GitHub logins are case-insensitive, so gate on the lowercased login against this derived set.
_TRUSTED_LOWER: frozenset[str] = frozenset(author.lower() for author in TRUSTED_AUTHORS)

# greenlight's own App slug. merge_rules.yaml names bare logins, so an entry for greenlight
# resolves to this bare form -- which ``is_bot`` does not match: it is absent from BOT_LOGINS and
# carries no ``[bot]`` suffix. Only the REST-side ``pytorchgreenlight[bot]`` login is bot-shaped,
# so without this guard greenlight enters its own cohort and reviews its own pull requests.
GREENLIGHT_APP_SLUG = "pytorchgreenlight"


def is_trusted(login: str | None) -> bool:
    return login is not None and login.lower() in _TRUSTED_LOWER


def is_shadow(login: str | None) -> bool:
    """True when ``login``'s evaluation carries no authority: no approval, no Dr. CI render.

    An unidentified author (``None``) is shadow. Shadow is the safe answer under uncertainty:
    getting it wrong withholds an approval, whereas defaulting to non-shadow would let a failed
    author lookup authorize a merge on behalf of someone greenlight could not name.
    """
    return not is_trusted(login)


def evaluation_cohort(authorized_logins: frozenset[str]) -> frozenset[str]:
    """Lowercase the merge-authorized logins greenlight evaluates: approvers, minus bots and itself."""
    return frozenset(
        login.lower()
        for login in authorized_logins
        if login and not is_bot(login) and login.lower() != GREENLIGHT_APP_SLUG
    )
