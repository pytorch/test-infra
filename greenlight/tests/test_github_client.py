from datetime import UTC, datetime

import pytest
from github import Github

from greenlight import github_client
from greenlight.github_client import OpenPR
from greenlight.pr_hash import ChangedFile, HumanEvent, compute_pr_hash


class _FakeUser:
    def __init__(self, login: str) -> None:
        self.login = login


class _FakePull:
    def __init__(self, number: int, login: str | None, title: str, html_url: str) -> None:
        self.number = number
        self.user = _FakeUser(login) if login is not None else None
        self.title = title
        self.html_url = html_url


class _FakeRepo:
    """Records the state passed to get_pulls and returns a preset list of open pulls."""

    def __init__(self, pulls: list[_FakePull]) -> None:
        self._pulls = pulls
        self.get_pulls_states: list[str] = []

    def get_pulls(self, state: str) -> list[_FakePull]:
        self.get_pulls_states.append(state)
        return self._pulls


class _RaisingRepo(_FakeRepo):
    """A repo whose get_pulls always fails, to assert errors are not swallowed."""

    def __init__(self) -> None:
        super().__init__([])

    def get_pulls(self, state: str) -> list[_FakePull]:
        raise RuntimeError("boom")


class _FakeRepoClient:
    """Records every repo name it is asked for and hands back one preset repo."""

    def __init__(self, repo: _FakeRepo) -> None:
        self._repo = repo
        self.get_repo_names: list[str] = []

    def get_repo(self, full_name_or_id: str) -> _FakeRepo:
        self.get_repo_names.append(full_name_or_id)
        return self._repo


def _client_with_pulls(pulls: list[_FakePull]) -> _FakeRepoClient:
    return _FakeRepoClient(_FakeRepo(pulls))


class _FakeActor:
    def __init__(self, login: str | None, type: str = "User") -> None:
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


def test_list_open_prs_by_authors_maps_pull_fields():
    client = _client_with_pulls(
        [_FakePull(42, "jeanschmidt", "fix flaky test", "https://github.com/pytorch/pytorch/pull/42")]
    )

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


def test_list_open_prs_by_authors_returns_only_trusted_in_one_traversal():
    repo = _FakeRepo(
        [
            _FakePull(1, "alice", "alice's fix", "https://example.test/1"),
            _FakePull(2, "carol", "carol's fix", "https://example.test/2"),
            _FakePull(3, "bob", "bob's fix", "https://example.test/3"),
        ]
    )
    client = _FakeRepoClient(repo)
    authors = ["alice", "bob"]

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", authors)

    assert {pr.author for pr in prs} == set(authors)
    assert client.get_repo_names == ["pytorch/pytorch"]
    assert repo.get_pulls_states == ["open"]


def test_list_open_prs_by_authors_matches_authors_case_insensitively():
    client = _client_with_pulls(
        [
            _FakePull(1, "JeanSchmidt", "mixed-case login", "https://example.test/1"),
            _FakePull(2, "ALICE", "upper-case login", "https://example.test/2"),
        ]
    )

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["jeanschmidt", "Alice"])

    assert [pr.number for pr in prs] == [1, 2]
    assert [pr.author for pr in prs] == ["JeanSchmidt", "ALICE"]


def test_list_open_prs_by_authors_skips_pulls_with_no_user():
    client = _client_with_pulls(
        [
            _FakePull(1, None, "ghost author PR", "https://example.test/1"),
            _FakePull(2, "alice", "alice's fix", "https://example.test/2"),
        ]
    )

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    assert [pr.number for pr in prs] == [2]
    assert [pr.author for pr in prs] == ["alice"]


def test_list_open_prs_by_authors_sorts_output_by_pr_number():
    client = _client_with_pulls(
        [
            _FakePull(30, "alice", "third", "https://example.test/30"),
            _FakePull(10, "bob", "first", "https://example.test/10"),
            _FakePull(20, "alice", "second", "https://example.test/20"),
        ]
    )

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice", "bob"])

    assert [pr.number for pr in prs] == [10, 20, 30]


def test_list_open_prs_by_authors_empty_results():
    client = _client_with_pulls([])

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    assert prs == []


def test_list_open_prs_by_authors_propagates_errors():
    client = _FakeRepoClient(_RaisingRepo())

    with pytest.raises(RuntimeError, match="boom"):
        github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])


def test_build_client_returns_github_instance_with_per_page_100():
    client = github_client.build_client("x")

    assert isinstance(client, Github)
    assert client.per_page == 100


def test_build_client_pins_request_timeout():
    client = github_client.build_client("x")

    # PyGithub exposes no public timeout accessor; read the mangled requester internals.
    requester = client.__dict__["_Github__requester"]
    assert requester.__dict__["_Requester__timeout"] == 15


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


def _golden_pr() -> _FakePR:
    """Fixture for the end-to-end golden.

    Mixes a human, a BOT_LOGINS bot, the self account, a ``[bot]``-suffixed actor, a
    None-user, and a human review; only the two humans (alice, carol) survive.
    """
    return _FakePR(
        base_sha="golden-base-sha",
        files=[_FakeFile(filename="x.py", status="modified", sha="blob-x")],
        issue_comments=[
            _FakeComment(1, _FakeActor("alice", "User"), "please fix", datetime(2026, 1, 1, tzinfo=UTC)),
            _FakeComment(2, _FakeActor("dependabot", "User"), "bump dep", datetime(2026, 1, 2, tzinfo=UTC)),
            _FakeComment(3, _FakeActor("greenlight", "User"), "self note", datetime(2026, 1, 3, tzinfo=UTC)),
            _FakeComment(4, None, "ghost comment", None),
        ],
        review_comments=[
            _FakeComment(5, _FakeActor("some-app[bot]", "User"), "automated nit", datetime(2026, 1, 4, tzinfo=UTC)),
        ],
        reviews=[
            _FakeReview(6, _FakeActor("carol", "User"), "lgtm", "APPROVED", datetime(2026, 1, 5, tzinfo=UTC)),
        ],
    )


def test_build_pr_fingerprint_golden_hash_scheme_v2():
    """End-to-end golden: build_pr_fingerprint -> compute_pr_hash pins the scheme-v2 digest.

    Guards against drift in is_bot / BOT_LOGINS / self_login exclusion and the
    PR-field mapping. Uses the default scheme_version (2); a future
    HASH_SCHEME_VERSION bump regenerates this literal.
    """
    fingerprint = github_client.build_pr_fingerprint(_golden_pr(), self_login="greenlight")

    assert fingerprint.human_events == (
        HumanEvent("issue_comment", 1, "alice", "please fix", None, "2026-01-01T00:00:00+00:00"),
        HumanEvent("review", 6, "carol", "lgtm", "APPROVED", "2026-01-05T00:00:00+00:00"),
    )
    assert compute_pr_hash(fingerprint) == "d856345ee246471315379f43926be55954f23f0af76df81475f0809ece4db9fb"


@pytest.mark.parametrize("null_login", [None, ""])
@pytest.mark.parametrize("self_login", [None, "greenlight"])
def test_build_pr_fingerprint_excludes_actor_with_missing_login(null_login: str | None, self_login: str | None) -> None:
    pr = _FakePR(
        base_sha="sha",
        files=[],
        issue_comments=[_FakeComment(1, _FakeActor(null_login, "User"), "ghost note", None)],
        review_comments=[],
        reviews=[_FakeReview(2, _FakeActor(null_login, "User"), "ghost review", "APPROVED", None)],
    )

    fingerprint = github_client.build_pr_fingerprint(pr, self_login=self_login)

    assert fingerprint.human_events == ()
