from datetime import UTC, datetime

import pytest
from github import Github
from urllib3.util.retry import Retry

from greenlight import github_client
from greenlight.constants import EVAL_HASH_RE
from greenlight.github_client import OpenPR
from greenlight.pr_hash import HumanEvent, PRFingerprint, compute_pr_hash
from greenlight.review_gate import CHANGES_REQUESTED, HUMAN_APPROVED, ReviewSkip


class _FakeUser:
    def __init__(self, login: str) -> None:
        self.login = login


class _FakeLabel:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakePull:
    def __init__(
        self,
        number: int,
        login: str | None,
        title: str,
        html_url: str,
        head_sha: str = "head-sha",
        updated_at: datetime | None = None,
        labels: list[str] | None = None,
        draft: bool = False,
    ) -> None:
        self.number = number
        self.user = _FakeUser(login) if login is not None else None
        self.title = title
        self.html_url = html_url
        self.head = _FakeBase(head_sha)
        self.updated_at = updated_at
        self.labels = [_FakeLabel(name) for name in (labels or [])]
        self.draft = draft


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


class _FakeComment:
    def __init__(self, id: int, user: _FakeActor | None, body: str) -> None:
        self.id = id
        self.user = user
        self.body = body


class _FakeReview:
    def __init__(self, id: int, user: _FakeActor | None, body: str, state: str = "COMMENTED") -> None:
        self.id = id
        self.user = user
        self.body = body
        self.state = state


class _FakeBase:
    def __init__(self, sha: str) -> None:
        self.sha = sha


class _FakePR:
    def __init__(
        self,
        issue_comments: list[_FakeComment],
        review_comments: list[_FakeComment],
        reviews: list[_FakeReview],
        head_sha: str = "head-sha",
    ) -> None:
        self._head_sha = head_sha
        self._issue_comments = issue_comments
        self._review_comments = review_comments
        self._reviews = reviews
        self.calls: list[str] = []

    @property
    def head(self) -> _FakeBase:
        self.calls.append("head")
        return _FakeBase(self._head_sha)

    def get_issue_comments(self) -> list[_FakeComment]:
        self.calls.append("get_issue_comments")
        return self._issue_comments

    def get_review_comments(self) -> list[_FakeComment]:
        self.calls.append("get_review_comments")
        return self._review_comments

    def get_reviews(self) -> list[_FakeReview]:
        self.calls.append("get_reviews")
        return self._reviews


class _FakeScanRepo:
    def __init__(self, pr: _FakePR) -> None:
        self._pr = pr
        self.get_pull_numbers: list[int] = []

    def get_pull(self, number: int) -> _FakePR:
        self.get_pull_numbers.append(number)
        return self._pr


class _FakeScanClient:
    def __init__(self, repo: _FakeScanRepo) -> None:
        self._repo = repo
        self.get_repo_names: list[str] = []

    def get_repo(self, full_name_or_id: str) -> _FakeScanRepo:
        self.get_repo_names.append(full_name_or_id)
        return self._repo


def test_list_open_prs_by_authors_maps_pull_fields():
    client = _client_with_pulls(
        [
            _FakePull(
                42,
                "jeanschmidt",
                "fix flaky test",
                "https://github.com/pytorch/pytorch/pull/42",
                head_sha="abc123",
                updated_at=datetime(2026, 7, 30, 9, 0, 0),
            )
        ]
    )

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["jeanschmidt"])

    assert prs == [
        OpenPR(
            repo="pytorch/pytorch",
            number=42,
            author="jeanschmidt",
            title="fix flaky test",
            url="https://github.com/pytorch/pytorch/pull/42",
            head_sha="abc123",
            updated_at=datetime(2026, 7, 30, 9, 0, 0),
            labels=(),
        )
    ]


def test_list_open_prs_by_authors_maps_labels():
    client = _client_with_pulls([_FakePull(1, "alice", "fix", "https://example.test/1", labels=["Stale", "ci-no-td"])])

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    # Each label's name is carried onto OpenPR.labels in listing order, read from the get_pulls
    # payload with no extra API call.
    assert prs[0].labels == ("Stale", "ci-no-td")


def test_list_open_prs_by_authors_normalizes_tz_aware_updated_at():
    client = _client_with_pulls(
        [_FakePull(1, "alice", "fix", "https://example.test/1", updated_at=datetime(2026, 7, 30, 9, 0, 0, tzinfo=UTC))]
    )

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    # A tz-aware updated_at is normalized to naive UTC (via state.naive_utc) so it can be
    # compared against the naive scan clock without raising.
    assert prs[0].updated_at == datetime(2026, 7, 30, 9, 0, 0)
    assert prs[0].updated_at.tzinfo is None


def test_list_open_prs_by_authors_updated_at_none_stays_none():
    client = _client_with_pulls([_FakePull(1, "alice", "fix", "https://example.test/1", updated_at=None)])

    prs = github_client.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    assert prs[0].updated_at is None


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


def test_list_open_prs_by_authors_skips_draft_pulls():
    client = _client_with_pulls(
        [
            _FakePull(1, "alice", "draft in progress", "https://example.test/1", draft=True),
            _FakePull(2, "alice", "ready for review", "https://example.test/2", draft=False),
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


class _FakeAuthorPull:
    def __init__(self, user: _FakeUser | None) -> None:
        self.user = user


class _FakeAuthorRepo:
    def __init__(self, pull: _FakeAuthorPull) -> None:
        self._pull = pull
        self.get_pull_numbers: list[int] = []

    def get_pull(self, number: int) -> _FakeAuthorPull:
        self.get_pull_numbers.append(number)
        return self._pull


class _FakeAuthorClient:
    def __init__(self, repo: _FakeAuthorRepo) -> None:
        self._repo = repo
        self.get_repo_names: list[str] = []

    def get_repo(self, full_name_or_id: str) -> _FakeAuthorRepo:
        self.get_repo_names.append(full_name_or_id)
        return self._repo


def test_get_pr_author_returns_login():
    repo = _FakeAuthorRepo(_FakeAuthorPull(_FakeUser("albanD")))
    client = _FakeAuthorClient(repo)

    author = github_client.get_pr_author(client, "pytorch/pytorch", 42)

    assert author == "albanD"
    assert client.get_repo_names == ["pytorch/pytorch"]
    assert repo.get_pull_numbers == [42]


def test_get_pr_author_returns_none_when_user_missing():
    client = _FakeAuthorClient(_FakeAuthorRepo(_FakeAuthorPull(None)))

    assert github_client.get_pr_author(client, "pytorch/pytorch", 7) is None


def test_build_client_returns_github_instance_with_per_page_100():
    client = github_client.build_client("x")

    assert isinstance(client, Github)
    assert client.per_page == 100


def test_build_client_pins_request_timeout():
    client = github_client.build_client("x")

    # PyGithub exposes no public timeout accessor; read the mangled requester internals.
    requester = client.__dict__["_Github__requester"]
    assert requester.__dict__["_Requester__timeout"] == 15


def test_build_retry_is_bounded_and_omits_rate_limit_statuses():
    retry = github_client._build_retry()

    # GithubRetry subclasses urllib3.Retry, so assert the exact type -- isinstance would
    # pass for the GithubRetry we're rejecting.
    assert type(retry) is Retry
    assert 403 not in retry.status_forcelist
    assert 429 not in retry.status_forcelist
    assert 500 in retry.status_forcelist
    assert 503 in retry.status_forcelist
    assert retry.respect_retry_after_header is False
    assert retry.allowed_methods == frozenset({"GET", "HEAD", "PUT", "DELETE"})
    assert "PUT" in retry.allowed_methods
    assert "DELETE" in retry.allowed_methods
    assert "POST" not in retry.allowed_methods
    assert "PATCH" not in retry.allowed_methods
    assert retry.total == 2
    assert retry.backoff_factor == 0.5
    assert retry.backoff_max == 5.0


def test_build_client_wires_bounded_retry_into_github(monkeypatch):
    captured: dict[str, object] = {}

    def _fake_github(**kwargs: object) -> object:
        captured.update(kwargs)
        return object()

    # build_client re-runs `from github import ... Github` per call, so patching the attribute on
    # the github module is picked up; Auth is left real (Auth.Token is a pure, offline wrapper).
    monkeypatch.setattr("github.Github", _fake_github)

    github_client.build_client("tok")

    retry = captured["retry"]
    assert isinstance(retry, Retry)
    assert 403 not in retry.status_forcelist
    assert retry.respect_retry_after_header is False


def _build_fp(
    pr: _FakePR,
    *,
    self_login: str | None = None,
    authorized_logins: frozenset[str] | None = None,
) -> PRFingerprint:
    """Build a fingerprint from ``pr``, materializing its reviews as ``fingerprint_pr`` does."""
    return github_client.build_pr_fingerprint(
        pr, reviews=pr.get_reviews(), self_login=self_login, authorized_logins=authorized_logins
    )


def test_build_pr_fingerprint_maps_shas_and_filters_bots_by_type_suffix_and_denylist():
    pr = _FakePR(
        issue_comments=[
            _FakeComment(1, _FakeActor("alice", "User"), "please fix"),
            _FakeComment(2, _FakeActor("ci-bot", "Bot"), "build failed"),
            _FakeComment(3, None, "ghost comment"),
        ],
        review_comments=[
            _FakeComment(4, _FakeActor("bob", "User"), "nit: rename this"),
            _FakeComment(5, _FakeActor("some-app[bot]", "User"), "automated nit"),
        ],
        reviews=[
            _FakeReview(6, _FakeActor("carol", "User"), "lgtm"),
            _FakeReview(7, _FakeActor("dependabot", "User"), "auto-approve"),
        ],
        head_sha="head-sha-123",
    )

    fingerprint = _build_fp(pr)

    assert fingerprint.head_sha == "head-sha-123"
    assert fingerprint.human_events == (
        HumanEvent(id=1, body="please fix"),
        HumanEvent(id=4, body="nit: rename this"),
        HumanEvent(id=6, body="lgtm"),
    )


def test_build_pr_fingerprint_excludes_self_login():
    pr = _FakePR(
        issue_comments=[_FakeComment(1, _FakeActor("jeanschmidt", "User"), "self note")],
        review_comments=[],
        reviews=[_FakeReview(2, _FakeActor("jeanschmidt", "User"), "self review")],
    )

    fingerprint = _build_fp(pr, self_login="jeanschmidt")

    assert fingerprint.human_events == ()


def test_build_pr_fingerprint_keeps_others_when_self_login_does_not_match():
    pr = _FakePR(
        issue_comments=[_FakeComment(1, _FakeActor("alice", "User"), "note")],
        review_comments=[],
        reviews=[],
    )

    fingerprint = _build_fp(pr, self_login="jeanschmidt")

    assert fingerprint.human_events == (HumanEvent(id=1, body="note"),)


def test_build_pr_fingerprint_with_no_activity_returns_empty_human_events():
    pr = _FakePR(issue_comments=[], review_comments=[], reviews=[])

    fingerprint = _build_fp(pr)

    assert fingerprint.human_events == ()


def test_build_pr_fingerprint_keeps_only_authorized_humans():
    pr = _FakePR(
        issue_comments=[
            _FakeComment(1, _FakeActor("alice", "User"), "authorized"),
            _FakeComment(2, _FakeActor("mallory", "User"), "unauthorized"),
            _FakeComment(3, _FakeActor("ci-bot", "Bot"), "bot"),
        ],
        review_comments=[_FakeComment(4, _FakeActor("BOB", "User"), "authorized upper-case")],
        reviews=[_FakeReview(5, _FakeActor("eve", "User"), "unauthorized review")],
    )

    fingerprint = _build_fp(pr, authorized_logins=frozenset({"alice", "bob"}))

    # Only authorized humans survive, matched case-insensitively (BOB -> bob); the unauthorized
    # humans and the bot are all dropped.
    assert fingerprint.human_events == (
        HumanEvent(id=1, body="authorized"),
        HumanEvent(id=4, body="authorized upper-case"),
    )


def test_build_pr_fingerprint_none_authorized_keeps_all_non_bot_humans():
    pr = _FakePR(
        issue_comments=[
            _FakeComment(1, _FakeActor("alice", "User"), "keep"),
            _FakeComment(2, _FakeActor("mallory", "User"), "also keep"),
        ],
        review_comments=[],
        reviews=[],
    )

    # None (the default) applies no authorization filter: every non-bot human is kept.
    assert _build_fp(pr).human_events == (
        HumanEvent(id=1, body="keep"),
        HumanEvent(id=2, body="also keep"),
    )


def test_build_pr_fingerprint_empty_authorized_drops_every_comment():
    pr = _FakePR(
        issue_comments=[_FakeComment(1, _FakeActor("alice", "User"), "note")],
        review_comments=[],
        reviews=[],
    )

    # An empty (but not None) set authorizes nobody, so no human comment feeds the hash.
    assert _build_fp(pr, authorized_logins=frozenset()).human_events == ()


def test_build_pr_fingerprint_self_login_excluded_even_when_authorized():
    pr = _FakePR(
        issue_comments=[
            _FakeComment(1, _FakeActor("alice", "User"), "authorized other"),
            _FakeComment(2, _FakeActor("greenlight", "User"), "authorized self"),
        ],
        review_comments=[],
        reviews=[],
    )

    # greenlight is in the authorized set yet still excluded as self_login: authorization must not
    # bypass the self-exclusion approval-bypass guard.
    fingerprint = _build_fp(pr, self_login="greenlight", authorized_logins=frozenset({"alice", "greenlight"}))

    assert fingerprint.human_events == (HumanEvent(id=1, body="authorized other"),)


def test_fingerprint_pr_threads_authorized_logins():
    pr = _FakePR(
        issue_comments=[
            _FakeComment(1, _FakeActor("alice", "User"), "authorized"),
            _FakeComment(2, _FakeActor("mallory", "User"), "unauthorized"),
        ],
        review_comments=[],
        reviews=[],
        head_sha="deadbeef",
    )
    client = _FakeScanClient(_FakeScanRepo(pr))

    result = github_client.fingerprint_pr(client, "pytorch/pytorch", 3, authorized_logins=frozenset({"alice"}))
    assert not isinstance(result, ReviewSkip)
    head_sha, eval_hash = result

    assert head_sha == "deadbeef"
    # Equals the hash of the fingerprint built with the SAME filter (set threaded through), and
    # differs from the unfiltered hash (mallory would otherwise be included).
    assert eval_hash == compute_pr_hash(_build_fp(pr, authorized_logins=frozenset({"alice"})))
    assert eval_hash != compute_pr_hash(_build_fp(pr))


def _golden_pr() -> _FakePR:
    """Fixture for the end-to-end golden.

    Mixes a human, a BOT_LOGINS bot, the self account, a ``[bot]``-suffixed actor, a
    None-user, and a human review; only the two humans (alice, carol) survive.
    """
    return _FakePR(
        issue_comments=[
            _FakeComment(1, _FakeActor("alice", "User"), "please fix"),
            _FakeComment(2, _FakeActor("dependabot", "User"), "bump dep"),
            _FakeComment(3, _FakeActor("greenlight", "User"), "self note"),
            _FakeComment(4, None, "ghost comment"),
        ],
        review_comments=[
            _FakeComment(5, _FakeActor("some-app[bot]", "User"), "automated nit"),
        ],
        reviews=[
            _FakeReview(6, _FakeActor("carol", "User"), "lgtm"),
        ],
    )


def test_build_pr_fingerprint_golden_hash_scheme_v5():
    """End-to-end golden: build_pr_fingerprint -> compute_pr_hash pins the scheme-v5 digest.

    Guards against drift in is_bot / BOT_LOGINS / self_login exclusion and the
    PR-field mapping. Uses the default scheme_version (5); a future
    HASH_SCHEME_VERSION bump regenerates this literal.
    """
    pr = _golden_pr()
    fingerprint = _build_fp(pr, self_login="greenlight")

    assert fingerprint.human_events == (
        HumanEvent(id=1, body="please fix"),
        HumanEvent(id=6, body="lgtm"),
    )
    assert compute_pr_hash(fingerprint) == "9d0506bd3e887a00d858f49e653cab9f913f185674a475582706cc83fcae70d4"


@pytest.mark.parametrize("null_login", [None, ""])
@pytest.mark.parametrize("self_login", [None, "greenlight"])
def test_build_pr_fingerprint_excludes_actor_with_missing_login(null_login: str | None, self_login: str | None) -> None:
    pr = _FakePR(
        issue_comments=[_FakeComment(1, _FakeActor(null_login, "User"), "ghost note")],
        review_comments=[],
        reviews=[_FakeReview(2, _FakeActor(null_login, "User"), "ghost review")],
    )

    fingerprint = _build_fp(pr, self_login=self_login)

    assert fingerprint.human_events == ()


def test_fingerprint_pr_returns_head_sha_and_eval_hash():
    pr = _FakePR(
        issue_comments=[],
        review_comments=[],
        reviews=[],
        head_sha="deadbeef",
    )
    repo = _FakeScanRepo(pr)
    client = _FakeScanClient(repo)

    result = github_client.fingerprint_pr(client, "pytorch/pytorch", 99)
    assert not isinstance(result, ReviewSkip)
    head_sha, eval_hash = result

    assert head_sha == "deadbeef"
    assert EVAL_HASH_RE.fullmatch(eval_hash)
    assert eval_hash == compute_pr_hash(_build_fp(pr))
    assert client.get_repo_names == ["pytorch/pytorch"]
    assert repo.get_pull_numbers == [99]


def test_fingerprint_pr_hashes_golden_fixture():
    pr = _golden_pr()
    client = _FakeScanClient(_FakeScanRepo(pr))

    result = github_client.fingerprint_pr(client, "pytorch/pytorch", 7)
    assert not isinstance(result, ReviewSkip)
    head_sha, eval_hash = result

    assert head_sha == "head-sha"
    assert EVAL_HASH_RE.fullmatch(eval_hash)
    assert eval_hash == compute_pr_hash(_build_fp(pr))


def test_fingerprint_pr_rejects_non_hex_hash(monkeypatch):
    pr = _FakePR(issue_comments=[], review_comments=[], reviews=[])
    client = _FakeScanClient(_FakeScanRepo(pr))
    monkeypatch.setattr(github_client, "compute_pr_hash", lambda _fingerprint: "not-a-64-hex-digest")

    with pytest.raises(ValueError, match="64 lowercase hex"):
        github_client.fingerprint_pr(client, "pytorch/pytorch", 1)


def test_fingerprint_pr_skips_on_human_approval_without_fetching_comments():
    pr = _FakePR(
        issue_comments=[_FakeComment(1, _FakeActor("alice", "User"), "must not be read")],
        review_comments=[_FakeComment(2, _FakeActor("bob", "User"), "must not be read")],
        reviews=[_FakeReview(3, _FakeActor("alice", "User"), "lgtm", state="APPROVED")],
    )
    client = _FakeScanClient(_FakeScanRepo(pr))

    result = github_client.fingerprint_pr(
        client,
        "pytorch/pytorch",
        5,
        authorized_logins=frozenset({"alice"}),
        allow_skip=True,
        skip_on_approval=True,
    )

    assert result == ReviewSkip(HUMAN_APPROVED, "approved by alice")
    # Only the one reviews call is spent: no comments fetched, no head read.
    assert pr.calls == ["get_reviews"]


def test_fingerprint_pr_skips_on_changes_requested_without_fetching_comments():
    pr = _FakePR(
        issue_comments=[_FakeComment(1, _FakeActor("alice", "User"), "must not be read")],
        review_comments=[],
        reviews=[_FakeReview(2, _FakeActor("bob", "User"), "please change", state="CHANGES_REQUESTED")],
    )
    client = _FakeScanClient(_FakeScanRepo(pr))

    result = github_client.fingerprint_pr(
        client,
        "pytorch/pytorch",
        6,
        authorized_logins=frozenset(),
        allow_skip=True,
        skip_on_approval=False,
    )

    # Changes-requested short-circuits even when approval-skip is off.
    assert result == ReviewSkip(CHANGES_REQUESTED, "changes requested by bob")
    assert pr.calls == ["get_reviews"]


def test_fingerprint_pr_allow_skip_false_never_skips_even_when_approved():
    pr = _FakePR(
        issue_comments=[],
        review_comments=[],
        reviews=[_FakeReview(1, _FakeActor("alice", "User"), "lgtm", state="APPROVED")],
        head_sha="deadbeef",
    )
    client = _FakeScanClient(_FakeScanRepo(pr))

    result = github_client.fingerprint_pr(
        client,
        "pytorch/pytorch",
        7,
        authorized_logins=frozenset({"alice"}),
        allow_skip=False,
        skip_on_approval=True,
    )

    assert not isinstance(result, ReviewSkip)
    head_sha, eval_hash = result
    assert head_sha == "deadbeef"
    assert EVAL_HASH_RE.fullmatch(eval_hash)
    assert "get_issue_comments" in pr.calls
    assert "get_review_comments" in pr.calls


def test_fingerprint_pr_allow_skip_no_decision_builds_fingerprint_fetching_reviews_once():
    pr = _FakePR(
        issue_comments=[_FakeComment(1, _FakeActor("alice", "User"), "just a note")],
        review_comments=[],
        reviews=[_FakeReview(2, _FakeActor("bob", "User"), "just commenting", state="COMMENTED")],
        head_sha="cafe",
    )
    client = _FakeScanClient(_FakeScanRepo(pr))

    result = github_client.fingerprint_pr(
        client,
        "pytorch/pytorch",
        8,
        authorized_logins=frozenset({"alice", "bob"}),
        allow_skip=True,
        skip_on_approval=True,
    )

    assert not isinstance(result, ReviewSkip)
    # Reviews are materialized once and reused by the fingerprint builder, never re-fetched.
    assert pr.calls.count("get_reviews") == 1
    assert "get_issue_comments" in pr.calls
    assert "get_review_comments" in pr.calls


def test_fingerprint_pr_hash_is_byte_identical_to_pre_skip_scheme():
    """Characterization: a non-skipped PR's eval_hash equals the pre-refactor digest.

    Pins the digest produced before reviews were threaded through build_pr_fingerprint,
    proving the fingerprint payload is unchanged for PRs that are still fingerprinted.
    """
    pr = _golden_pr()
    client = _FakeScanClient(_FakeScanRepo(pr))

    result = github_client.fingerprint_pr(client, "pytorch/pytorch", 9)

    assert result == ("head-sha", "bcf6a1d21566873cd1da85fa724bd1e9996e213b869ed28544751c7e4e06a0f4")


class _FakeVerdictReview:
    def __init__(self, id: int, user: _FakeActor | None, state: str) -> None:
        self.id = id
        self.user = user
        self.state = state
        self.dismissed_with: str | None = None

    def dismiss(self, message: str) -> None:
        self.dismissed_with = message


class _FakeVerdictComment:
    def __init__(self, body: str, user: _FakeActor | None) -> None:
        self.body = body
        self.user = user
        self.edited_with: str | None = None

    def edit(self, body: str) -> None:
        self.body = body
        self.edited_with = body


class _FakeVerdictPR:
    def __init__(
        self,
        head_sha: str = "head",
        reviews: list[_FakeVerdictReview] | None = None,
        existing_comments: list[_FakeVerdictComment] | None = None,
    ) -> None:
        self.head = _FakeBase(head_sha)
        self._reviews = reviews or []
        self._existing_comments = existing_comments or []
        self.created_reviews: list[tuple[str, str]] = []
        self.issue_comments: list[str] = []

    def create_review(self, *, body: str, event: str) -> object:
        self.created_reviews.append((event, body))
        return object()

    def create_issue_comment(self, body: str) -> object:
        self.issue_comments.append(body)
        return object()

    def get_issue_comments(self) -> list[_FakeVerdictComment]:
        return self._existing_comments

    def get_reviews(self) -> list[_FakeVerdictReview]:
        return self._reviews


class _FakeVerdictRepo:
    def __init__(self, pr: _FakeVerdictPR) -> None:
        self._pr = pr
        self.get_pull_numbers: list[int] = []

    def get_pull(self, number: int) -> _FakeVerdictPR:
        self.get_pull_numbers.append(number)
        return self._pr


class _FakeVerdictClient:
    def __init__(self, repo: _FakeVerdictRepo) -> None:
        self._repo = repo
        self.get_repo_names: list[str] = []

    def get_repo(self, full_name_or_id: str) -> _FakeVerdictRepo:
        self.get_repo_names.append(full_name_or_id)
        return self._repo


def test_get_pr_fetches_repo_then_pull():
    pr = _FakeVerdictPR()
    repo = _FakeVerdictRepo(pr)
    client = _FakeVerdictClient(repo)

    result = github_client.get_pr(client, "pytorch/pytorch", 42)

    assert result is pr
    assert client.get_repo_names == ["pytorch/pytorch"]
    assert repo.get_pull_numbers == [42]


@pytest.mark.parametrize(
    "event",
    [
        github_client.REVIEW_EVENT_APPROVE,
        github_client.REVIEW_EVENT_REQUEST_CHANGES,
        github_client.REVIEW_EVENT_COMMENT,
    ],
)
def test_post_review_forwards_supported_events(event: str) -> None:
    pr = _FakeVerdictPR()

    github_client.post_review(pr, event=event, body="the body")

    assert pr.created_reviews == [(event, "the body")]


def test_post_review_rejects_unknown_event():
    pr = _FakeVerdictPR()

    with pytest.raises(ValueError, match="unsupported review event"):
        github_client.post_review(pr, event="MERGE", body="x")

    assert pr.created_reviews == []


def test_post_review_propagates_errors():
    class _BoomPR(_FakeVerdictPR):
        def create_review(self, *, body: str, event: str) -> object:
            raise RuntimeError("gh down")

    with pytest.raises(RuntimeError, match="gh down"):
        github_client.post_review(_BoomPR(), event=github_client.REVIEW_EVENT_APPROVE, body="x")


_MARKER = "<!-- mark -->"
_BOT_LOGIN = "greenlight-app[bot]"


def test_upsert_issue_comment_edits_bot_marked_comment():
    existing = _FakeVerdictComment(f"{_MARKER}\nold body", _FakeActor(_BOT_LOGIN))
    pr = _FakeVerdictPR(existing_comments=[existing])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="new body", author_login=_BOT_LOGIN)

    assert existing.edited_with == "new body"
    assert pr.issue_comments == []  # edited in place, not created


def test_upsert_issue_comment_creates_when_none_marked():
    existing = _FakeVerdictComment("unrelated comment", _FakeActor(_BOT_LOGIN))
    pr = _FakeVerdictPR(existing_comments=[existing])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="fresh body", author_login=_BOT_LOGIN)

    assert existing.edited_with is None
    assert pr.issue_comments == ["fresh body"]


def test_upsert_issue_comment_ignores_marked_comment_from_other_author():
    impostor = _FakeVerdictComment(f"{_MARKER} copied", _FakeActor("alice"))
    pr = _FakeVerdictPR(existing_comments=[impostor])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="fresh body", author_login=_BOT_LOGIN)

    assert impostor.edited_with is None  # a copied marker cannot hijack the upsert
    assert pr.issue_comments == ["fresh body"]


def test_upsert_issue_comment_matches_author_case_insensitively():
    existing = _FakeVerdictComment(f"{_MARKER} x", _FakeActor("GreenLight-App[Bot]"))
    pr = _FakeVerdictPR(existing_comments=[existing])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="new body", author_login=_BOT_LOGIN)

    assert existing.edited_with == "new body"


def test_upsert_issue_comment_handles_comment_with_no_user():
    ghost = _FakeVerdictComment(f"{_MARKER} ghost", None)
    pr = _FakeVerdictPR(existing_comments=[ghost])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="fresh body", author_login=_BOT_LOGIN)

    assert ghost.edited_with is None
    assert pr.issue_comments == ["fresh body"]


def test_upsert_issue_comment_handles_user_with_empty_login():
    ghost = _FakeVerdictComment(f"{_MARKER} x", _FakeActor(None))
    pr = _FakeVerdictPR(existing_comments=[ghost])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="fresh body", author_login=_BOT_LOGIN)

    assert ghost.edited_with is None
    assert pr.issue_comments == ["fresh body"]


@pytest.mark.parametrize("bad_login", ["", None])
def test_upsert_issue_comment_rejects_empty_author_login(bad_login: str | None) -> None:
    existing = _FakeVerdictComment(f"{_MARKER} anything", _FakeActor("alice"))
    pr = _FakeVerdictPR(existing_comments=[existing])

    with pytest.raises(ValueError, match="non-empty author_login"):
        github_client.upsert_issue_comment(
            pr,
            marker=_MARKER,
            body="new body",
            author_login=bad_login,  # type: ignore[arg-type]
        )

    assert existing.edited_with is None
    assert pr.issue_comments == []


def test_upsert_issue_comment_edits_first_matching_comment():
    first = _FakeVerdictComment(f"{_MARKER} first", _FakeActor(_BOT_LOGIN))
    second = _FakeVerdictComment(f"{_MARKER} second", _FakeActor(_BOT_LOGIN))
    pr = _FakeVerdictPR(existing_comments=[first, second])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="new body", author_login=_BOT_LOGIN)

    assert first.edited_with == "new body"
    assert second.edited_with is None
    assert pr.issue_comments == []


def test_format_and_parse_run_marker_round_trip():
    marker = github_client.format_run_marker(4567)

    assert marker == "<!-- greenlight-run: 4567 -->"
    assert github_client.parse_run_marker(f"header\n{marker}\nbody") == 4567


@pytest.mark.parametrize(
    "body",
    ["", "no marker here", "<!-- greenlight-run: abc -->", "<!-- greenlight-run:  -->"],
)
def test_parse_run_marker_returns_none_when_absent_or_garbled(body: str) -> None:
    assert github_client.parse_run_marker(body) is None


def test_parse_run_marker_reads_header_ignoring_stamp_in_message_body():
    body = (
        f"{_MARKER}\n{github_client.format_run_marker(5)}\n**headline**\n\n"
        "<details>\n<summary>Why</summary>\n\n"
        "```\ninjected <!-- greenlight-run: 999999 -->\n```\n</details>"
    )

    # The stamp is read from the controlled header, never from the untrusted message region.
    assert github_client.parse_run_marker(body) == 5


def test_parse_run_marker_none_when_only_message_body_has_stamp():
    body = (
        f"{_MARKER}\n**headline**\n\n<details>\n<summary>Why</summary>\n\n<!-- greenlight-run: 999999 -->\n</details>"
    )

    assert github_client.parse_run_marker(body) is None


def _run_stamped(run_id: int) -> str:
    return f"{_MARKER}\n{github_client.format_run_marker(run_id)}\nold"


def test_upsert_issue_comment_edits_when_existing_run_is_older():
    existing = _FakeVerdictComment(_run_stamped(5), _FakeActor(_BOT_LOGIN))
    pr = _FakeVerdictPR(existing_comments=[existing])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="new", author_login=_BOT_LOGIN, run_id=10)

    assert existing.edited_with == "new"


def test_upsert_issue_comment_edits_when_existing_run_equals_current():
    existing = _FakeVerdictComment(_run_stamped(10), _FakeActor(_BOT_LOGIN))
    pr = _FakeVerdictPR(existing_comments=[existing])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="new", author_login=_BOT_LOGIN, run_id=10)

    assert existing.edited_with == "new"


def test_upsert_issue_comment_edits_when_existing_has_no_run_stamp():
    existing = _FakeVerdictComment(f"{_MARKER}\nold", _FakeActor(_BOT_LOGIN))
    pr = _FakeVerdictPR(existing_comments=[existing])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="new", author_login=_BOT_LOGIN, run_id=10)

    assert existing.edited_with == "new"


def test_upsert_issue_comment_skips_when_existing_run_is_newer():
    existing = _FakeVerdictComment(_run_stamped(20), _FakeActor(_BOT_LOGIN))
    pr = _FakeVerdictPR(existing_comments=[existing])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="stale", author_login=_BOT_LOGIN, run_id=10)

    # A superseded (older) run must never regress the live run's comment.
    assert existing.edited_with is None
    assert pr.issue_comments == []


def test_upsert_issue_comment_creates_when_none_matched_even_with_run_id():
    pr = _FakeVerdictPR(existing_comments=[])

    github_client.upsert_issue_comment(pr, marker=_MARKER, body="fresh", author_login=_BOT_LOGIN, run_id=10)

    assert pr.issue_comments == ["fresh"]


def test_dismiss_prior_greenlight_approvals_only_dismisses_own_approved():
    reviews = [
        _FakeVerdictReview(1, _FakeActor("greenlight-app[bot]"), "APPROVED"),
        _FakeVerdictReview(2, _FakeActor("alice"), "APPROVED"),
        _FakeVerdictReview(3, _FakeActor("greenlight-app[bot]"), "COMMENTED"),
        _FakeVerdictReview(4, None, "APPROVED"),
        _FakeVerdictReview(5, _FakeActor(""), "APPROVED"),
        _FakeVerdictReview(6, _FakeActor("GreenLight-App[Bot]"), "APPROVED"),
    ]
    pr = _FakeVerdictPR(reviews=reviews)

    dismissed = github_client.dismiss_prior_greenlight_approvals(
        pr, bot_login="greenlight-app[bot]", message="superseded"
    )

    assert dismissed == [1, 6]
    assert reviews[0].dismissed_with == "superseded"
    assert reviews[5].dismissed_with == "superseded"
    assert [r.dismissed_with for r in reviews[1:5]] == [None, None, None, None]


def test_dismiss_prior_greenlight_approvals_when_none_match():
    reviews = [_FakeVerdictReview(1, _FakeActor("alice"), "APPROVED")]
    pr = _FakeVerdictPR(reviews=reviews)

    dismissed = github_client.dismiss_prior_greenlight_approvals(pr, bot_login="greenlight-app[bot]", message="x")

    assert dismissed == []
    assert reviews[0].dismissed_with is None
