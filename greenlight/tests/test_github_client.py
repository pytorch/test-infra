from datetime import UTC, datetime

import pytest
from github import Github

from greenlight import github_client
from greenlight.github_client import OpenPR
from greenlight.pr_hash import ChangedFile, HumanEvent


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


class _FakeActor:
    def __init__(self, login: str, type: str = "User") -> None:
        self.login = login
        self.type = type


class _FakeFile:
    def __init__(self, filename: str, status: str, sha: str, previous_filename: str | None = None) -> None:
        self.filename = filename
        self.status = status
        self.sha = sha
        self.previous_filename = previous_filename


class _FakeComment:
    def __init__(self, id: int, user: _FakeActor | None, body: str, updated_at: datetime | None) -> None:
        self.id = id
        self.user = user
        self.body = body
        self.updated_at = updated_at


class _FakeReview:
    def __init__(self, id: int, user: _FakeActor | None, body: str, state: str, submitted_at: datetime | None) -> None:
        self.id = id
        self.user = user
        self.body = body
        self.state = state
        self.submitted_at = submitted_at


class _FakeBase:
    def __init__(self, sha: str) -> None:
        self.sha = sha


class _FakePR:
    def __init__(
        self,
        base_sha: str,
        files: list[_FakeFile],
        issue_comments: list[_FakeComment],
        review_comments: list[_FakeComment],
        reviews: list[_FakeReview],
    ) -> None:
        self.base = _FakeBase(base_sha)
        self._files = files
        self._issue_comments = issue_comments
        self._review_comments = review_comments
        self._reviews = reviews

    def get_files(self) -> list[_FakeFile]:
        return self._files

    def get_issue_comments(self) -> list[_FakeComment]:
        return self._issue_comments

    def get_review_comments(self) -> list[_FakeComment]:
        return self._review_comments

    def get_reviews(self) -> list[_FakeReview]:
        return self._reviews


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


def test_build_pr_fingerprint_maps_files_and_filters_bots_by_type_suffix_and_denylist():
    pr = _FakePR(
        base_sha="base-sha-123",
        files=[
            _FakeFile(filename="a.py", status="modified", sha="sha-a"),
            _FakeFile(filename="new_name.py", status="renamed", sha="sha-b", previous_filename="old_name.py"),
        ],
        issue_comments=[
            _FakeComment(1, _FakeActor("alice", "User"), "please fix", datetime(2026, 1, 1, tzinfo=UTC)),
            _FakeComment(2, _FakeActor("ci-bot", "Bot"), "build failed", datetime(2026, 1, 2, tzinfo=UTC)),
            _FakeComment(3, None, "ghost comment", None),
        ],
        review_comments=[
            _FakeComment(4, _FakeActor("bob", "User"), "nit: rename this", datetime(2026, 1, 3, tzinfo=UTC)),
            _FakeComment(5, _FakeActor("some-app[bot]", "User"), "automated nit", datetime(2026, 1, 4, tzinfo=UTC)),
        ],
        reviews=[
            _FakeReview(6, _FakeActor("carol", "User"), "lgtm", "APPROVED", datetime(2026, 1, 5, tzinfo=UTC)),
            _FakeReview(7, _FakeActor("dependabot", "User"), "auto-approve", "APPROVED", None),
        ],
    )

    fingerprint = github_client.build_pr_fingerprint(pr)

    assert fingerprint.base_sha == "base-sha-123"
    assert fingerprint.changed_files == (
        ChangedFile(path="a.py", status="modified", blob_sha="sha-a"),
        ChangedFile(path="new_name.py", status="renamed", blob_sha="sha-b", previous_path="old_name.py"),
    )
    assert fingerprint.human_events == (
        HumanEvent("issue_comment", 1, "alice", "please fix", None, "2026-01-01T00:00:00+00:00"),
        HumanEvent("review_comment", 4, "bob", "nit: rename this", None, "2026-01-03T00:00:00+00:00"),
        HumanEvent("review", 6, "carol", "lgtm", "APPROVED", "2026-01-05T00:00:00+00:00"),
    )


def test_build_pr_fingerprint_excludes_self_login():
    pr = _FakePR(
        base_sha="sha",
        files=[],
        issue_comments=[_FakeComment(1, _FakeActor("jeanschmidt", "User"), "self note", None)],
        review_comments=[],
        reviews=[_FakeReview(2, _FakeActor("jeanschmidt", "User"), "self review", "APPROVED", None)],
    )

    fingerprint = github_client.build_pr_fingerprint(pr, self_login="jeanschmidt")

    assert fingerprint.human_events == ()


def test_build_pr_fingerprint_keeps_others_when_self_login_does_not_match():
    pr = _FakePR(
        base_sha="sha",
        files=[],
        issue_comments=[_FakeComment(1, _FakeActor("alice", "User"), "note", None)],
        review_comments=[],
        reviews=[],
    )

    fingerprint = github_client.build_pr_fingerprint(pr, self_login="jeanschmidt")

    assert fingerprint.human_events == (HumanEvent("issue_comment", 1, "alice", "note", None, ""),)


def test_build_pr_fingerprint_uses_empty_string_timestamp_when_missing():
    pr = _FakePR(
        base_sha="sha",
        files=[],
        issue_comments=[],
        review_comments=[],
        reviews=[_FakeReview(1, _FakeActor("carol", "User"), "pending review", "PENDING", None)],
    )

    fingerprint = github_client.build_pr_fingerprint(pr)

    assert fingerprint.human_events == (HumanEvent("review", 1, "carol", "pending review", "PENDING", ""),)


def test_build_pr_fingerprint_with_no_activity_returns_empty_tuples():
    pr = _FakePR(base_sha="sha", files=[], issue_comments=[], review_comments=[], reviews=[])

    fingerprint = github_client.build_pr_fingerprint(pr)

    assert fingerprint.changed_files == ()
    assert fingerprint.human_events == ()
