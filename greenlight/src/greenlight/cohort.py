"""Whose PRs greenlight reviews, and whose evaluation carries authority.

Two independent questions, single-sourced here so the scan, the verdict path and the state
writers cannot drift apart on either. ``TRUSTED_AUTHORS`` answers the first: the listing scan
matches on it, and both authz gates -- the ``--pr`` target author and the ``@greenlight recheck``
requester -- are checked against it. ``is_shadow`` answers the second: a shadow author's PR is
fingerprinted, dispatched and recorded like any other, and its row is stamped ``shadow`` so the
result is never taken for an authoritative verdict.
"""

from __future__ import annotations

__all__ = ["TRUSTED_AUTHORS", "is_shadow", "is_trusted"]

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


def is_trusted(login: str | None) -> bool:
    return login is not None and login.lower() in _TRUSTED_LOWER


def is_shadow(login: str | None) -> bool:
    """True when ``login``'s evaluation carries no authority: no approval, no Dr. CI render.

    An unidentified author (``None``) is shadow. Shadow is the safe answer under uncertainty:
    getting it wrong withholds an approval, whereas defaulting to non-shadow would let a failed
    author lookup authorize a merge on behalf of someone greenlight could not name.
    """
    return not is_trusted(login)
