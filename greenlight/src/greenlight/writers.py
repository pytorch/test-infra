"""Resolve write_permission eligibility: who holds a repo's minimum role, as one synthetic merge rule.

The minimum role is ``write`` (push access) or ``maintain`` (the maintain or admin role), per the repo's
``minimum_role``. ``resolve_writers`` feeds the scan (``repo_scan``): every collaborator with that role,
of any affiliation, User accounts only, compiled into one valid rule with no paths, so the evaluation
cohort, the fingerprint's comment filter, the "a human already decided" skip and ``cohort.assess_rules``
treat it as they treat merge_rules.yaml. ``author_holds_role`` answers the record job's question for one
author with one live read.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol, assert_never

from greenlight import cohort, merge_authz

if TYPE_CHECKING:
    from collections.abc import Iterable

    from greenlight.repo_config import MinimumRole

    class _Collaborator(Protocol):
        @property
        def login(self) -> str: ...
        @property
        def type(self) -> str: ...

    class _WritersRepo(Protocol):
        def get_collaborators(self, affiliation: str = ..., permission: str = ...) -> Iterable[_Collaborator]: ...
        def get_collaborator_permission(self, collaborator: str) -> str: ...

    class _Requester(Protocol):
        def requestJsonAndCheck(self, verb: str, url: str) -> tuple[dict[str, Any], Any]: ...


__all__ = ["REPO_ROLE_RULE", "WritersClient", "author_holds_role", "resolve_writers"]

_USER_TYPE = "User"
REPO_ROLE_RULE = "repo role"

# The legacy ``permission`` field of GET /repos/{repo}/collaborators/{user}/permission, which maps
# maintain to write and triage to read.
_WRITE_PERMISSIONS = frozenset({"admin", "write"})
_MAINTAIN_ROLE_NAMES = frozenset({"maintain", "admin"})


class WritersClient(Protocol):
    """Structural GitHub client for write_permission eligibility; the real ``github.Github`` satisfies it."""

    def get_repo(self, full_name_or_id: str) -> _WritersRepo: ...

    @property
    def requester(self) -> _Requester: ...


def _role_rule(logins: frozenset[str]) -> merge_authz.MergeRule:
    return merge_authz.compile_rule(REPO_ROLE_RULE, (), logins)


def _listed_permission(minimum_role: MinimumRole) -> str:
    """The collaborators listing's ``permission`` filter for ``minimum_role``: it returns that role and above."""
    match minimum_role:
        case "write":
            return "push"
        case "maintain":
            return "maintain"
        case _:
            assert_never(minimum_role)


def resolve_writers(client: WritersClient, repo: str, *, minimum_role: MinimumRole) -> merge_authz.MergeRulesSnapshot:
    """Every User account holding ``minimum_role`` on ``repo``, as one rule naming them in GitHub's exact case.

    Raises ``ValueError`` on an empty result, as ``merge_authz.resolve_merge_rules`` does on an empty
    union: an empty allowlist would silently blank every comment from the fingerprint.
    """
    permission = _listed_permission(minimum_role)
    collaborators = client.get_repo(repo).get_collaborators(affiliation="all", permission=permission)
    logins = frozenset(user.login for user in collaborators if user.type == _USER_TYPE and user.login)
    if not logins:
        raise ValueError(f"resolved no User account with {permission} access to {repo}")
    return merge_authz.MergeRulesSnapshot(
        authorized=frozenset(login.lower() for login in logins), rules=(_role_rule(logins),)
    )


def _holds_maintain(client: WritersClient, repo: str, author: str) -> bool:
    """Whether ``author`` holds the maintain or admin role on ``repo``.

    The legacy ``permission`` field reports maintain as write, so it cannot tell the two apart; GitHub's
    schema marks ``user.permissions`` optional, so ``role_name`` answers when it is absent. Raises
    ``ValueError`` on a response with neither.
    """
    url = f"/repos/{repo}/collaborators/{author}/permission"
    _headers, data = client.requester.requestJsonAndCheck("GET", url)
    body = data if isinstance(data, dict) else {}
    user = body.get("user")
    permissions = user.get("permissions") if isinstance(user, dict) else None
    if isinstance(permissions, dict) and isinstance(maintain := permissions.get("maintain"), bool):
        return maintain
    if isinstance(role_name := body.get("role_name"), str):
        return role_name in _MAINTAIN_ROLE_NAMES
    raise ValueError(f"GET {url} returned an unexpected shape")


def _holds(client: WritersClient, repo: str, author: str, minimum_role: MinimumRole) -> bool:
    match minimum_role:
        case "write":
            return client.get_repo(repo).get_collaborator_permission(author) in _WRITE_PERMISSIONS
        case "maintain":
            return _holds_maintain(client, repo, author)
        case _:
            assert_never(minimum_role)


def author_holds_role(
    client: WritersClient, repo: str, author: str | None, author_type: str | None, *, minimum_role: MinimumRole
) -> cohort.Eligibility:
    """Whether ``author``, a User account, holds ``minimum_role`` on ``repo`` now: a rule naming only them, or None.

    One read, of the author's permission; ``cohort.assess_rules`` then applies the bot and greenlight
    exclusions. The reason names no rule or team, only the role it requires.
    """
    if not author:
        return cohort.Eligibility(None, "no author")
    if author_type != _USER_TYPE:
        return cohort.Eligibility(None, f"account type {author_type!r} is not {_USER_TYPE!r}")
    if not _holds(client, repo, author, minimum_role):
        return cohort.Eligibility(None, f"no {minimum_role} permission")
    return cohort.assess_rules(author, (_role_rule(frozenset({author})),))
