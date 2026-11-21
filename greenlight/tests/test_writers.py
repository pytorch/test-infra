from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING

import pytest
from github import GithubException

from greenlight import cohort, writers
from greenlight.cohort import GREENLIGHT_APP_SLUG

if TYPE_CHECKING:
    from collections.abc import Iterator


def _user(login: str, type: str = "User") -> SimpleNamespace:
    return SimpleNamespace(login=login, type=type)


class _Pages:
    """Yields its pages one after another, as PyGithub's PaginatedList fetches them, counting the fetches."""

    def __init__(self, *pages: list[SimpleNamespace]) -> None:
        self._pages = pages
        self.fetched = 0

    def __iter__(self) -> Iterator[SimpleNamespace]:
        for page in self._pages:
            self.fetched += 1
            yield from page


class _FakeRepo:
    def __init__(self, collaborators: _Pages, permission: str | Exception = "write") -> None:
        self._collaborators = collaborators
        self._permission = permission
        self.collaborator_queries: list[dict[str, str]] = []
        self.permission_reads: list[str] = []

    def get_collaborators(self, affiliation: str = "", permission: str = "") -> _Pages:
        self.collaborator_queries.append({"affiliation": affiliation, "permission": permission})
        return self._collaborators

    def get_collaborator_permission(self, collaborator: str) -> str:
        self.permission_reads.append(collaborator)
        if isinstance(self._permission, Exception):
            raise self._permission
        return self._permission


class _FakeClient:
    def __init__(self, repo: _FakeRepo) -> None:
        self.repo = repo
        self.repo_names: list[str] = []

    def get_repo(self, full_name_or_id: str) -> _FakeRepo:
        self.repo_names.append(full_name_or_id)
        return self.repo


def _client(*pages: list[SimpleNamespace], permission: str | Exception = "write") -> _FakeClient:
    return _FakeClient(_FakeRepo(_Pages(*pages), permission))


def test_resolve_writers_lists_every_push_collaborator_of_the_repo_across_every_page():
    client = _client([_user("Alice"), _user("bob")], [_user("CAROL")])

    snapshot = writers.resolve_writers(client, "pytorch/vision")

    assert client.repo_names == ["pytorch/vision"]
    assert client.repo.collaborator_queries == [{"affiliation": "all", "permission": "push"}]
    assert client.repo._collaborators.fetched == 2
    assert snapshot.authorized == frozenset({"alice", "bob", "carol"})
    (rule,) = snapshot.rules
    assert rule.name == writers.WRITE_PERMISSION_RULE
    assert rule.approvers == frozenset({"Alice", "bob", "CAROL"})
    assert rule.valid
    assert rule.patterns == ()


def test_resolve_writers_keeps_only_user_accounts():
    client = _client(
        [_user("alice"), _user("dependabot[bot]", "Bot"), _user("some-app", "Bot"), _user("org", "Organization")]
    )

    snapshot = writers.resolve_writers(client, "pytorch/vision")

    assert snapshot.authorized == frozenset({"alice"})
    assert snapshot.rules[0].approvers == frozenset({"alice"})


@pytest.mark.parametrize(
    "pages",
    [
        pytest.param([], id="no-collaborators"),
        pytest.param([[_user("renovate[bot]", "Bot")]], id="only-bots"),
        pytest.param([[_user("", "User")]], id="blank-login"),
    ],
)
def test_resolve_writers_raises_on_no_user_writer(pages):
    with pytest.raises(ValueError, match="resolved no User account with push access to pytorch/vision"):
        writers.resolve_writers(_client(*pages), "pytorch/vision")


def test_resolve_writers_raises_a_listing_failure():
    class _Failing(_Pages):
        def __iter__(self) -> Iterator[SimpleNamespace]:
            raise GithubException(502)

    with pytest.raises(GithubException):
        writers.resolve_writers(_FakeClient(_FakeRepo(_Failing())), "pytorch/vision")


@pytest.mark.parametrize("files", [(), ("README.md",), ("torch/csrc/autograd/engine.cpp", ".github/workflows/x.yml")])
def test_the_writers_rule_qualifies_any_author_it_names_in_exact_case_whatever_the_files(files):
    (rule,) = writers.resolve_writers(_client([_user("Alice")]), "pytorch/vision").rules

    assert rule.covers(files)
    assert cohort.assess_rules("Alice", (rule,)).rule is rule
    assert cohort.assess_rules("alice", (rule,)).rule is None
    assert cohort.assess_rules("mallory", (rule,)).rule is None


@pytest.mark.parametrize("permission", ["admin", "write"])
def test_author_has_write_accepts_admin_and_write_with_one_permission_read(permission):
    client = _client(permission=permission)

    rule, reason = writers.author_has_write(client, "pytorch/vision", "Alice", "User")

    assert rule is not None
    assert rule.approvers == frozenset({"Alice"})
    assert rule.valid
    assert reason == "eligible"
    assert client.repo_names == ["pytorch/vision"]
    assert client.repo.permission_reads == ["Alice"]
    assert client.repo.collaborator_queries == []


@pytest.mark.parametrize("permission", ["read", "none"])
def test_author_has_write_refuses_read_and_none_without_naming_the_level(permission):
    rule, reason = writers.author_has_write(_client(permission=permission), "pytorch/vision", "Alice", "User")

    assert rule is None
    assert reason == "no write permission"


@pytest.mark.parametrize("author_type", ["Bot", "Organization", None])
def test_author_has_write_refuses_any_account_but_a_user_without_reading_its_permission(author_type):
    client = _client()

    rule, reason = writers.author_has_write(client, "pytorch/vision", "Alice", author_type)

    assert rule is None
    assert reason == f"account type {author_type!r} is not 'User'"
    assert client.repo.permission_reads == []


@pytest.mark.parametrize("author", [None, ""])
def test_author_has_write_refuses_a_pr_with_no_author_without_reading(author):
    client = _client()

    assert writers.author_has_write(client, "pytorch/vision", author, "User") == (None, "no author")
    assert client.repo.permission_reads == []


@pytest.mark.parametrize("author", [GREENLIGHT_APP_SLUG, "PyTorchGreenLight", "pytorchbot"])
def test_author_has_write_refuses_greenlight_and_bots_through_assess_rules(author):
    rule, reason = writers.author_has_write(_client(permission="admin"), "pytorch/vision", author, "User")

    assert rule is None
    assert reason == "excluded (bot or greenlight)"


def test_author_has_write_raises_a_permission_read_failure():
    with pytest.raises(GithubException):
        writers.author_has_write(_client(permission=GithubException(404)), "pytorch/vision", "Alice", "User")
