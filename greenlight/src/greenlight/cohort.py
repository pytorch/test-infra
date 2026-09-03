"""Whose PRs greenlight reviews, and whose word can point it at one.

``TRUSTED_AUTHORS`` answers both today: the listing scan matches on it, and both authz gates --
the ``--pr`` target author and the ``@greenlight recheck`` requester -- are checked against it.
It sits in a module of its own rather than inside the scan, so a caller that needs the membership
answer does not have to import the scan to get it.
"""

from __future__ import annotations

__all__ = ["TRUSTED_AUTHORS", "is_trusted"]

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
