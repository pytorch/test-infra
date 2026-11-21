"""Resolve write_permission eligibility: who may push to a repo, as one synthetic merge rule.

``resolve_writers`` feeds the scan (``repo_scan``): every collaborator with push access, of any
affiliation, User accounts only, compiled into one valid rule with no paths, so the evaluation cohort,
the fingerprint's comment filter, the "a human already decided" skip and ``cohort.assess_rules`` treat it
as they treat merge_rules.yaml. ``author_has_write`` answers the record job's question for one author
with one live read.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from greenlight import cohort, merge_authz

if TYPE_CHECKING:
    from collections.abc import Iterable

    class _Collaborator(Protocol):
        @property
        def login(self) -> str: ...
        @property
        def type(self) -> str: ...

    class _WritersRepo(Protocol):
        def get_collaborators(self, affiliation: str = ..., permission: str = ...) -> Iterable[_Collaborator]: ...
        def get_collaborator_permission(self, collaborator: str) -> str: ...


__all__ = ["WRITE_PERMISSION_RULE", "WritersClient", "author_has_write", "resolve_writers"]

_USER_TYPE = "User"
WRITE_PERMISSION_RULE = "write permission"

# The legacy ``permission`` field of GET /repos/{repo}/collaborators/{user}/permission, which maps
# maintain to write and triage to read.
_WRITE_PERMISSIONS = frozenset({"admin", "write"})


class WritersClient(Protocol):
    """Structural GitHub client for write_permission eligibility; the real ``github.Github`` satisfies it."""

    def get_repo(self, full_name_or_id: str) -> _WritersRepo: ...


def _write_rule(logins: frozenset[str]) -> merge_authz.MergeRule:
    return merge_authz.compile_rule(WRITE_PERMISSION_RULE, (), logins)


def resolve_writers(client: WritersClient, repo: str) -> merge_authz.MergeRulesSnapshot:
    """Every User account with push access to ``repo``, as one rule naming them in GitHub's exact case.

    Raises ``ValueError`` on an empty result, as ``merge_authz.resolve_merge_rules`` does on an empty
    union: an empty allowlist would silently blank every comment from the fingerprint.
    """
    collaborators = client.get_repo(repo).get_collaborators(affiliation="all", permission="push")
    logins = frozenset(user.login for user in collaborators if user.type == _USER_TYPE and user.login)
    if not logins:
        raise ValueError(f"resolved no User account with push access to {repo}")
    return merge_authz.MergeRulesSnapshot(
        authorized=frozenset(login.lower() for login in logins), rules=(_write_rule(logins),)
    )


def author_has_write(
    client: WritersClient, repo: str, author: str | None, author_type: str | None
) -> cohort.Eligibility:
    """Whether ``author``, a User account, may push to ``repo`` now: a rule naming only them, or None, with a reason.

    One read, of the author's permission; ``cohort.assess_rules`` then applies the bot and greenlight
    exclusions. The reason names no rule, team or permission level.
    """
    if not author:
        return cohort.Eligibility(None, "no author")
    if author_type != _USER_TYPE:
        return cohort.Eligibility(None, f"account type {author_type!r} is not {_USER_TYPE!r}")
    if client.get_repo(repo).get_collaborator_permission(author) not in _WRITE_PERMISSIONS:
        return cohort.Eligibility(None, "no write permission")
    return cohort.assess_rules(author, (_write_rule(frozenset({author})),))
