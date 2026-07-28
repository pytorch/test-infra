import pytest
from github import Github

from greenlight import github_client
from greenlight.github_client import OpenPR


class _FakeUser:
    def __init__(self, login: str) -> None:
        self.login = login


class _FakeIssue:
    def __init__(self, number: int, login: str | None, title: str, html_url: str) -> None:
        self.number = number
        self.user = _FakeUser(login) if login is not None else None
        self.title = title
        self.html_url = html_url


class _FakeClient:
    """Records every query it is asked to search and returns a preset result list."""

    def __init__(self, results_by_query: dict[str, list[_FakeIssue]]) -> None:
        self._results_by_query = results_by_query
        self.queries: list[str] = []

    def search_issues(self, query: str) -> list[_FakeIssue]:
        self.queries.append(query)
        return self._results_by_query.get(query, [])


class _RaisingClient:
    """A client whose search call always fails, to assert errors are not swallowed."""

    def search_issues(self, query: str) -> list[_FakeIssue]:
        raise RuntimeError("boom")


def test_list_open_prs_by_authors_maps_issue_fields():
    issue = _FakeIssue(
        number=42,
        login="jeanschmidt",
        title="fix flaky test",
        html_url="https://github.com/pytorch/pytorch/pull/42",
    )
    client = _FakeClient({"repo:pytorch/pytorch is:open is:pr author:jeanschmidt": [issue]})

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["jeanschmidt"])

    assert prs == [
        OpenPR(
            repo="pytorch/pytorch",
            number=42,
            author="jeanschmidt",
            title="fix flaky test",
            url="https://github.com/pytorch/pytorch/pull/42",
        )
    ]


def test_list_open_prs_by_authors_queries_once_per_author_with_exact_query():
    client = _FakeClient({})

    github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice", "bob"])

    assert client.queries == [
        "repo:pytorch/pytorch is:open is:pr author:alice",
        "repo:pytorch/pytorch is:open is:pr author:bob",
    ]


def test_list_open_prs_by_authors_aggregates_across_authors():
    alice_issue = _FakeIssue(1, "alice", "alice's fix", "https://example.test/1")
    bob_issue = _FakeIssue(2, "bob", "bob's fix", "https://example.test/2")
    client = _FakeClient(
        {
            "repo:pytorch/pytorch is:open is:pr author:alice": [alice_issue],
            "repo:pytorch/pytorch is:open is:pr author:bob": [bob_issue],
        }
    )

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice", "bob"])

    assert [pr.number for pr in prs] == [1, 2]
    assert [pr.author for pr in prs] == ["alice", "bob"]


def test_list_open_prs_by_authors_empty_results():
    client = _FakeClient({})

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["nobody"])

    assert prs == []


def test_list_open_prs_by_authors_maps_multiple_issues_for_a_single_author():
    first = _FakeIssue(1, "alice", "alice's first fix", "https://example.test/1")
    second = _FakeIssue(2, "alice", "alice's second fix", "https://example.test/2")
    client = _FakeClient({"repo:pytorch/pytorch is:open is:pr author:alice": [first, second]})

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    assert [pr.number for pr in prs] == [1, 2]
    assert [pr.author for pr in prs] == ["alice", "alice"]


def test_list_open_prs_by_authors_falls_back_to_queried_author_when_user_is_none():
    issue = _FakeIssue(number=7, login=None, title="ghost author PR", html_url="https://example.test/7")
    client = _FakeClient({"repo:pytorch/pytorch is:open is:pr author:ghost": [issue]})

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["ghost"])

    assert prs == [
        OpenPR(
            repo="pytorch/pytorch",
            number=7,
            author="ghost",
            title="ghost author PR",
            url="https://example.test/7",
        )
    ]


def test_list_open_prs_by_authors_propagates_search_errors():
    client = _RaisingClient()

    with pytest.raises(RuntimeError, match="boom"):
        github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])


def test_build_client_returns_github_instance_without_network():
    client = github_client.build_client("x")

    assert isinstance(client, Github)
