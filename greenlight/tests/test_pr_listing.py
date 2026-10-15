from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta, timezone
from typing import TYPE_CHECKING, cast

import pytest

from greenlight import pr_listing
from greenlight.constants import TARGET_REPO
from greenlight.pr_listing import OpenPR

if TYPE_CHECKING:
    from collections.abc import Iterator

    from github import Github

_NOW = datetime(2026, 10, 13, 12, 0, 0)
_CUTOFF = _NOW - timedelta(hours=24)


class _FakeUser:
    def __init__(self, login: str) -> None:
        self.login = login


class _FakeLabel:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakeBase:
    def __init__(self, sha: str) -> None:
        self.sha = sha


class _FakePull:
    def __init__(
        self,
        number: int,
        login: str | None,
        title: str = "fix",
        html_url: str = "",
        head_sha: str = "head-sha",
        updated_at: datetime | None = None,
        labels: list[str] | None = None,
        draft: bool = False,
    ) -> None:
        self.number = number
        self.user = _FakeUser(login) if login is not None else None
        self.title = title
        self.html_url = html_url or f"https://example.test/{number}"
        self.head = _FakeBase(head_sha)
        self.updated_at = updated_at
        self.labels = [_FakeLabel(name) for name in (labels or [])]
        self.draft = draft


class _FakeIssue:
    """An issues-endpoint item: a PR carries a pull_request link, a plain issue carries None."""

    def __init__(
        self,
        number: int,
        login: str | None,
        *,
        is_pr: bool = True,
        updated_at: datetime | None = None,
        labels: list[str] | None = None,
        draft: bool = False,
    ) -> None:
        self.number = number
        self.user = _FakeUser(login) if login is not None else None
        self.title = f"fix {number}"
        self.html_url = f"https://example.test/{number}"
        self.updated_at = updated_at
        self.labels = [_FakeLabel(name) for name in (labels or ["Reverted"])]
        self.draft = draft
        self.pull_request: object | None = object() if is_pr else None


class _Pages:
    """Hands out pulls one page at a time, as PyGithub's PaginatedList does, recording each page reached."""

    def __init__(self, pages: list[list[_FakePull]]) -> None:
        self._pages = pages
        self.fetched: list[int] = []

    def __iter__(self) -> Iterator[_FakePull]:
        for index, page in enumerate(self._pages):
            self.fetched.append(index)
            yield from page


class _FakeRepo:
    def __init__(
        self,
        pages: list[list[_FakePull]] | None = None,
        *,
        issues: list[_FakeIssue] | None = None,
        issues_by_label: dict[str, list[_FakeIssue]] | None = None,
    ) -> None:
        self.pages = _Pages(pages or [])
        self._issues = issues or []
        self._issues_by_label = issues_by_label
        self.get_pulls_calls: list[dict[str, str | None]] = []
        self.get_issues_calls: list[dict[str, object]] = []

    def get_pulls(self, state: str = "", sort: str = "", direction: str = "") -> _Pages:
        self.get_pulls_calls.append({"state": state, "sort": sort or None, "direction": direction or None})
        return self.pages

    def get_issues(self, *, state: str, labels: list[str]) -> list[_FakeIssue]:
        self.get_issues_calls.append({"state": state, "labels": labels})
        if self._issues_by_label is not None:
            return self._issues_by_label.get(labels[0], [])
        return self._issues


class _RaisingRepo(_FakeRepo):
    def get_pulls(self, state: str = "", sort: str = "", direction: str = "") -> _Pages:
        raise RuntimeError("boom")


class _FakeClient:
    def __init__(self, repo: _FakeRepo) -> None:
        self.repo = repo
        self.get_repo_names: list[str] = []

    def get_repo(self, full_name_or_id: str) -> _FakeRepo:
        self.get_repo_names.append(full_name_or_id)
        return self.repo


def _client(*pulls: _FakePull) -> _FakeClient:
    return _FakeClient(_FakeRepo([list(pulls)]))


def _numbers(prs: list[OpenPR]) -> list[int]:
    return [pr.number for pr in prs]


def test_full_listing_maps_pull_fields():
    client = _client(
        _FakePull(
            42,
            "jeanschmidt",
            "fix flaky test",
            "https://github.com/pytorch/pytorch/pull/42",
            head_sha="abc123",
            updated_at=datetime(2026, 7, 30, 9, 0, 0),
        )
    )

    prs = pr_listing.list_open_prs_by_authors(client, "pytorch/pytorch", ["jeanschmidt"])

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


def test_full_listing_maps_labels():
    client = _client(_FakePull(1, "alice", labels=["Stale", "ci-no-td"]))

    prs = pr_listing.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    # Each label's name is carried onto OpenPR.labels in listing order, read from the get_pulls
    # payload with no extra API call.
    assert prs[0].labels == ("Stale", "ci-no-td")


def test_full_listing_normalizes_tz_aware_updated_at():
    client = _client(_FakePull(1, "alice", updated_at=datetime(2026, 7, 30, 9, 0, 0, tzinfo=UTC)))

    prs = pr_listing.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    # A tz-aware updated_at is normalized to naive UTC (via state.naive_utc) so it can be
    # compared against the naive scan clock without raising.
    assert prs[0].updated_at == datetime(2026, 7, 30, 9, 0, 0)
    assert prs[0].updated_at.tzinfo is None


def test_full_listing_updated_at_none_stays_none():
    client = _client(_FakePull(1, "alice", updated_at=None))

    prs = pr_listing.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    assert prs[0].updated_at is None


def test_full_listing_returns_only_the_cohort_in_one_default_traversal():
    client = _client(_FakePull(1, "alice"), _FakePull(2, "carol"), _FakePull(3, "bob"))

    prs = pr_listing.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice", "bob"])

    assert {pr.author for pr in prs} == {"alice", "bob"}
    assert client.get_repo_names == ["pytorch/pytorch"]
    # The full listing keeps GitHub's default order and walks every page.
    assert client.repo.get_pulls_calls == [{"state": "open", "sort": None, "direction": None}]


def test_full_listing_matches_authors_case_insensitively():
    client = _client(_FakePull(1, "JeanSchmidt"), _FakePull(2, "ALICE"))

    prs = pr_listing.list_open_prs_by_authors(client, "pytorch/pytorch", ["jeanschmidt", "Alice"])

    assert _numbers(prs) == [1, 2]
    assert [pr.author for pr in prs] == ["JeanSchmidt", "ALICE"]


def test_full_listing_skips_pulls_with_no_user():
    client = _client(_FakePull(1, None), _FakePull(2, "alice"))

    prs = pr_listing.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    assert _numbers(prs) == [2]
    assert [pr.author for pr in prs] == ["alice"]


def test_full_listing_skips_draft_pulls():
    client = _client(_FakePull(1, "alice", draft=True), _FakePull(2, "alice", draft=False))

    prs = pr_listing.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    assert _numbers(prs) == [2]
    assert [pr.author for pr in prs] == ["alice"]


def test_full_listing_sorts_output_by_pr_number():
    client = _client(_FakePull(30, "alice"), _FakePull(10, "bob"), _FakePull(20, "alice"))

    prs = pr_listing.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice", "bob"])

    assert _numbers(prs) == [10, 20, 30]


def test_full_listing_lists_a_pull_repeated_across_pages_once():
    repeated = _FakePull(20, "alice")
    client = _FakeClient(_FakeRepo([[_FakePull(30, "alice"), repeated], [repeated, _FakePull(10, "alice")]]))

    prs = pr_listing.list_open_prs_by_authors(client, "pytorch/pytorch", ["alice"])

    assert _numbers(prs) == [10, 20, 30]


def test_full_listing_empty_results():
    assert pr_listing.list_open_prs_by_authors(_client(), "pytorch/pytorch", ["alice"]) == []


def test_full_listing_propagates_errors():
    with pytest.raises(RuntimeError, match="boom"):
        pr_listing.list_open_prs_by_authors(_FakeClient(_RaisingRepo()), "pytorch/pytorch", ["alice"])


def test_updated_listing_walks_most_recently_updated_first_and_stops_at_the_cutoff():
    repo = _FakeRepo(
        [
            [_FakePull(5, "alice", updated_at=_NOW - timedelta(hours=1))],
            [_FakePull(3, "alice", updated_at=_NOW - timedelta(hours=23)), _FakePull(9, "alice", updated_at=_CUTOFF)],
            [_FakePull(1, "alice", updated_at=_NOW - timedelta(hours=30))],
        ]
    )

    prs = pr_listing.list_recently_updated_prs(_FakeClient(repo), TARGET_REPO, ["alice"], cutoff=_CUTOFF)

    # GitHub sorts by updated ascending unless asked otherwise, so the direction must be explicit.
    assert repo.get_pulls_calls == [{"state": "open", "sort": "updated", "direction": "desc"}]
    # A PR updated exactly at the cutoff stops the walk and is not listed, and the page after it is
    # never requested.
    assert _numbers(prs) == [3, 5]
    assert repo.pages.fetched == [0, 1]


def test_updated_listing_lists_a_pull_repeated_across_pages_once_and_sorted_by_number():
    repeated = _FakePull(7, "alice", updated_at=_NOW - timedelta(hours=2))
    repo = _FakeRepo(
        [
            [_FakePull(8, "alice", updated_at=_NOW - timedelta(hours=1)), repeated],
            [repeated, _FakePull(2, "alice", updated_at=_NOW - timedelta(hours=3))],
        ]
    )

    prs = pr_listing.list_recently_updated_prs(_FakeClient(repo), TARGET_REPO, ["alice"], cutoff=_CUTOFF)

    assert _numbers(prs) == [2, 7, 8]


def test_updated_listing_never_stops_at_a_pull_with_no_updated_at():
    repo = _FakeRepo(
        [
            [_FakePull(4, "alice", updated_at=None), _FakePull(6, "alice", updated_at=_NOW - timedelta(hours=5))],
            [_FakePull(1, "alice", updated_at=_NOW - timedelta(days=3))],
        ]
    )

    prs = pr_listing.list_recently_updated_prs(_FakeClient(repo), TARGET_REPO, ["alice"], cutoff=_CUTOFF)

    assert _numbers(prs) == [4, 6]
    assert prs[0].updated_at is None


def test_updated_listing_compares_a_tz_aware_updated_at_in_utc():
    plus_two = timezone(timedelta(hours=2))
    # 13:30 at UTC+2 is 11:30 UTC, half an hour before the cutoff: read as a naive 13:30 it would not
    # stop the walk.
    in_window = datetime(2026, 10, 13, 13, 0, 0, tzinfo=plus_two)
    past_cutoff = datetime(2026, 10, 12, 13, 30, 0, tzinfo=plus_two)
    repo = _FakeRepo(
        [
            [_FakePull(2, "alice", updated_at=in_window), _FakePull(1, "alice", updated_at=past_cutoff)],
            [_FakePull(3, "alice", updated_at=None)],
        ]
    )

    prs = pr_listing.list_recently_updated_prs(_FakeClient(repo), TARGET_REPO, ["alice"], cutoff=_CUTOFF)

    assert _numbers(prs) == [2]
    assert prs[0].updated_at == datetime(2026, 10, 13, 11, 0, 0)
    assert repo.pages.fetched == [0]


def test_updated_listing_applies_the_cohort_and_draft_predicate_without_stopping_the_walk():
    repo = _FakeRepo(
        [
            [
                _FakePull(1, "carol", updated_at=_NOW - timedelta(hours=1)),
                _FakePull(2, "alice", updated_at=_NOW - timedelta(hours=2), draft=True),
                _FakePull(3, None, updated_at=_NOW - timedelta(hours=3)),
                _FakePull(4, "Alice", updated_at=_NOW - timedelta(hours=4)),
            ]
        ]
    )

    prs = pr_listing.list_recently_updated_prs(_FakeClient(repo), TARGET_REPO, ["alice"], cutoff=_CUTOFF)

    assert _numbers(prs) == [4]


def test_reverted_listing_asks_the_issues_endpoint_once_for_open_reverted_prs():
    old = _NOW - timedelta(days=40)
    repo = _FakeRepo(
        issues=[
            _FakeIssue(30, "alice", updated_at=old, labels=["Merged", "Reverted"]),
            _FakeIssue(10, "bob", updated_at=old),
            _FakeIssue(20, "alice", is_pr=False),
            _FakeIssue(40, "carol"),
            _FakeIssue(50, "alice", draft=True),
            _FakeIssue(60, None),
        ]
    )

    prs = pr_listing.list_reverted_prs(_FakeClient(repo), TARGET_REPO, ["alice", "bob"])

    assert repo.get_issues_calls == [{"state": "open", "labels": ["Reverted"]}]
    # A plain issue, an author outside the cohort, a draft and a ghost author are all dropped; the
    # payload carries no head, so head_sha stays None.
    assert _numbers(prs) == [10, 30]
    assert prs[1] == OpenPR(
        repo=TARGET_REPO,
        number=30,
        author="alice",
        title="fix 30",
        url="https://example.test/30",
        head_sha=None,
        updated_at=old,
        labels=("Merged", "Reverted"),
    )


def test_reverted_listing_asks_once_per_label_the_revert_guard_matches_and_lists_each_pr_once(monkeypatch):
    monkeypatch.setattr(pr_listing, "REVERTED_LABELS", frozenset({"Reverted", "auto-reverted"}))
    repo = _FakeRepo(
        issues_by_label={
            "Reverted": [_FakeIssue(20, "alice"), _FakeIssue(10, "alice")],
            "auto-reverted": [_FakeIssue(30, "alice", labels=["auto-reverted"]), _FakeIssue(20, "alice")],
        }
    )

    prs = pr_listing.list_reverted_prs(_FakeClient(repo), TARGET_REPO, ["alice"])

    assert repo.get_issues_calls == [
        {"state": "open", "labels": ["Reverted"]},
        {"state": "open", "labels": ["auto-reverted"]},
    ]
    assert _numbers(prs) == [10, 20, 30]


def test_default_fetch_lists_the_target_repo_for_the_cohort(monkeypatch):
    captured: dict[str, object] = {}
    expected = [OpenPR(TARGET_REPO, 1, "alice", "fix", "url", "sha", None)]

    def fake_list(client, repo, authors):
        captured["client"] = client
        captured["repo"] = repo
        captured["authors"] = set(authors)
        return expected

    monkeypatch.setattr(pr_listing, "list_open_prs_by_authors", fake_list)
    client = cast("Github", object())

    result = pr_listing.default_fetch(client, frozenset({"alice", "bob"}))

    assert result is expected
    assert captured["client"] is client
    assert captured["repo"] == TARGET_REPO
    # The author set is the caller's, not a module constant: the listing follows whatever author set
    # the scan resolved for this pass.
    assert captured["authors"] == {"alice", "bob"}


def _fast_repo() -> _FakeRepo:
    old = _NOW - timedelta(days=10)
    return _FakeRepo(
        [
            [
                _FakePull(5, "alice", head_sha="sha5", updated_at=_NOW - timedelta(hours=1)),
                _FakePull(6, "alice", head_sha="sha6", updated_at=_NOW - timedelta(hours=2)),
                _FakePull(1, "alice", updated_at=old),
            ]
        ],
        issues=[_FakeIssue(6, "alice", updated_at=_NOW - timedelta(hours=2)), _FakeIssue(2, "alice", updated_at=old)],
    )


def test_default_fetch_updated_adds_the_open_reverted_prs_the_walk_missed(caplog):
    repo = _fast_repo()

    with caplog.at_level(logging.INFO, logger="greenlight"):
        prs = pr_listing.default_fetch_updated(cast("Github", _FakeClient(repo)), frozenset({"alice"}), _CUTOFF)

    # 5 and 6 come from the walk and 2 from the Reverted supplement; 1, past the cutoff and
    # unlabelled, is not listed. 6 was labelled after the walk read it: the supplement's later copy
    # wins, so the revert guard sees the label (and 6 has no head, like every issues-endpoint copy).
    assert _numbers(prs) == [2, 5, 6]
    assert [pr.labels for pr in prs] == [("Reverted",), (), ("Reverted",)]
    assert [pr.head_sha for pr in prs] == [None, "sha5", None]
    assert "fast tick: 2 PR(s) updated since the cutoff, plus 1 labelled Reverted" in caplog.text
    assert repo.get_issues_calls == [{"state": "open", "labels": ["Reverted"]}]
    assert repo.pages.fetched == [0]


def test_default_fetch_updated_with_nothing_to_add_reports_zero_supplements(caplog):
    repo = _FakeRepo([[_FakePull(5, "alice", updated_at=_NOW - timedelta(hours=1))]])

    with caplog.at_level(logging.INFO, logger="greenlight"):
        prs = pr_listing.default_fetch_updated(cast("Github", _FakeClient(repo)), frozenset({"alice"}), _CUTOFF)

    assert _numbers(prs) == [5]
    assert "fast tick: 1 PR(s) updated since the cutoff, plus 0 labelled Reverted" in caplog.text


def _open_pr(number: int, head_sha: str | None = None) -> OpenPR:
    return OpenPR(TARGET_REPO, number, "alice", f"fix {number}", f"https://example.test/{number}", head_sha, None)


def _candidates(
    *,
    pr: int | None = None,
    cutoff: datetime | None = None,
    full: list[OpenPR] | None = None,
    fast: list[OpenPR] | None = None,
) -> tuple[tuple[object, ...], list[str]]:
    calls: list[str] = []

    def fetch(_client, _authors):
        calls.append("fetch")
        return list(full or [])

    def fetch_updated(_client, _authors, cutoff_seen):
        calls.append(f"fetch_updated:{cutoff_seen.isoformat()}")
        return list(fast or [])

    result = pr_listing.candidate_numbers(
        cast("Github", object()),
        pr=pr,
        authors=frozenset({"alice"}),
        fetch=fetch,
        cutoff=cutoff,
        fetch_updated=fetch_updated,
    )
    return result, calls


def test_candidate_numbers_without_a_cutoff_runs_the_full_listing(caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        (numbers, updated, labels, authors, heads), calls = _candidates(full=[_open_pr(2, "sha2"), _open_pr(1)])

    assert calls == ["fetch"]
    assert numbers == [2, 1]
    assert updated == {1: None, 2: None}
    assert labels == {1: (), 2: ()}
    assert authors == {1: "alice", 2: "alice"}
    assert heads == {1: None, 2: "sha2"}
    assert "found 2 open PR(s) from 1 author(s) in pytorch/pytorch (full tick)" in caplog.text


def test_candidate_numbers_with_a_cutoff_runs_the_fast_listing(caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        (numbers, *_), calls = _candidates(cutoff=_CUTOFF, fast=[_open_pr(4), _open_pr(8)])

    assert calls == [f"fetch_updated:{_CUTOFF.isoformat()}"]
    assert numbers == [4, 8]
    assert (
        "found 2 open PR(s) from 1 author(s) in pytorch/pytorch (fast tick, updated since 2026-10-12 12:00:00 UTC)"
        in caplog.text
    )


def test_candidate_numbers_for_a_single_pr_lists_nothing():
    result, calls = _candidates(pr=7, cutoff=_CUTOFF)

    assert result == ([7], {}, {}, {}, {})
    assert calls == []
