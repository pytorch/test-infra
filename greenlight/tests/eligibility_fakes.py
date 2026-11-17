"""Offline GitHub fakes for the record job's eligibility check, shared by its tests and the verdict's."""

from __future__ import annotations

import textwrap
from types import SimpleNamespace
from typing import NoReturn

from greenlight import constants

REVIEWED = "b" * 40
_MERGE_RULES = textwrap.dedent(
    """
    - name: Superusers
      patterns: ["*"]
      approved_by: [CatchAll]
    - name: Docs Maintainers
      patterns: ["docs/**"]
      approved_by: [Scoped, pytorch/doc-writers]
    - name: Broken
      patterns: ["docs/{a,b}/**"]
      approved_by: [OnlyBroken]
    """
)


def permission_data(*, maintain: bool) -> dict[str, object]:
    """GET /repos/{repo}/collaborators/{user}/permission as GitHub answers it for an admin or a writer."""
    role = "admin" if maintain else "write"
    flags = {"admin": maintain, "maintain": maintain, "push": True, "triage": True, "pull": True}
    return {"permission": role, "role_name": role, "user": {"login": "Alice", "permissions": flags}}


class FakeRequester:
    """Answers GET /repos/{repo}/collaborators/{user}/permission with ``data`` (raised when an exception),
    recording each URL."""

    def __init__(self, data: object) -> None:
        self.data = data
        self.urls: list[str] = []

    def requestJsonAndCheck(self, verb: str, url: str) -> tuple[dict[str, str], object]:
        assert verb == "GET"
        self.urls.append(url)
        if isinstance(self.data, Exception):
            raise self.data
        return {}, self.data


class _FakeContent:
    def __init__(self, text: str) -> None:
        self.decoded_content = text.encode("utf-8")


class _FakeMember:
    def __init__(self, login: str) -> None:
        self.login = login


class _FakeTeam:
    def get_members(self) -> list[_FakeMember]:
        return [_FakeMember("TeamMember"), _FakeMember("Concealed")]


class _FakeOrg:
    def get_team_by_slug(self, slug: str) -> _FakeTeam:
        return _FakeTeam()


class _FakeLivePR:
    def __init__(self, head_sha: str, head_ref: str, base_ref: str, trunk: str | None) -> None:
        self.head = SimpleNamespace(sha=head_sha, ref=head_ref)
        self.base = SimpleNamespace(ref=base_ref)
        self.raw_data: dict[str, object] = {} if trunk is None else {"stack": {"base": {"ref": trunk}}}

    def get_files(self) -> NoReturn:
        raise AssertionError("eligibility never lists the PR's files")


class FakeRulesClient:
    """Serves merge_rules.yaml, one team, every author's ``permission`` and maintain flag, and PR #7 as it reads live.

    PR #7 reads at ``live_head`` with its refs and stack trunk; a ``None`` trunk is a PR in no native
    stack. ``pull_error`` replaces the PR read with that failure.
    """

    def __init__(
        self,
        *,
        merge_rules: str | Exception = _MERGE_RULES,
        pull_error: Exception | None = None,
        live_head: str = REVIEWED,
        head_ref: str = "feature",
        base_ref: str = constants.TARGET_BRANCH,
        trunk: str | None = None,
        permission: str = "write",
        maintain: bool = False,
    ) -> None:
        self.merge_rules = merge_rules
        self.pull_error = pull_error
        self.live = _FakeLivePR(live_head, head_ref, base_ref, trunk)
        self.permission = permission
        self.requester = FakeRequester(permission_data(maintain=maintain))
        self.pull_reads = 0
        self.permission_reads: list[str] = []
        self.contents_reads = 0

    def get_repo(self, full_name_or_id: str) -> FakeRulesClient:
        return self

    def get_contents(self, path: str) -> _FakeContent:
        self.contents_reads += 1
        if isinstance(self.merge_rules, Exception):
            raise self.merge_rules
        return _FakeContent(self.merge_rules)

    def get_pull(self, number: int) -> _FakeLivePR:
        self.pull_reads += 1
        if self.pull_error is not None:
            raise self.pull_error
        return self.live

    def get_organization(self, login: str) -> _FakeOrg:
        return _FakeOrg()

    def get_collaborator_permission(self, collaborator: str) -> str:
        self.permission_reads.append(collaborator)
        return self.permission
