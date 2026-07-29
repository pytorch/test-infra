"""Read-only GitHub pull-request access for the greenlight service."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from greenlight.pr_hash import ChangedFile, HumanEvent, PRFingerprint, is_bot

if TYPE_CHECKING:
    from collections.abc import Iterable
    from datetime import datetime
    from typing import Protocol

    from github import Github

    class _PRUser(Protocol):
        @property
        def login(self) -> str: ...

    class _PullRequest(Protocol):
        @property
        def number(self) -> int: ...
        @property
        def user(self) -> _PRUser | None: ...
        @property
        def title(self) -> str: ...
        @property
        def html_url(self) -> str: ...

    class _Repo(Protocol):
        def get_pulls(self, state: str) -> Iterable[_PullRequest]: ...

    class _RepoClient(Protocol):
        def get_repo(self, full_name_or_id: str) -> _Repo: ...

    class _PRActor(Protocol):
        @property
        def login(self) -> str: ...
        @property
        def type(self) -> str: ...

    class _PRFile(Protocol):
        @property
        def filename(self) -> str: ...
        @property
        def status(self) -> str: ...
        @property
        def sha(self) -> str: ...
        @property
        def previous_filename(self) -> str | None: ...

    class _PRComment(Protocol):
        @property
        def id(self) -> int: ...
        @property
        def user(self) -> _PRActor | None: ...
        @property
        def body(self) -> str: ...
        @property
        def updated_at(self) -> datetime | None: ...

    class _PRReview(Protocol):
        @property
        def id(self) -> int: ...
        @property
        def user(self) -> _PRActor | None: ...
        @property
        def body(self) -> str: ...
        @property
        def state(self) -> str: ...
        @property
        def submitted_at(self) -> datetime | None: ...

    class _PRBase(Protocol):
        @property
        def sha(self) -> str: ...

    class _FingerprintPR(Protocol):
        @property
        def base(self) -> _PRBase: ...
        def get_files(self) -> Iterable[_PRFile]: ...
        def get_issue_comments(self) -> Iterable[_PRComment]: ...
        def get_review_comments(self) -> Iterable[_PRComment]: ...
        def get_reviews(self) -> Iterable[_PRReview]: ...


@dataclass(frozen=True, slots=True)
class OpenPR:
    repo: str
    number: int
    author: str
    title: str
    url: str


def build_client(token: str) -> Github:
    from github import Auth, Github  # lazy: keeps this module importable without the dep

    return Github(auth=Auth.Token(token), per_page=100)


def list_open_prs_by_authors(client: _RepoClient, repo: str, authors: Iterable[str]) -> list[OpenPR]:
    trusted = {a.lower() for a in authors}
    repo_obj = client.get_repo(repo)
    prs: list[OpenPR] = []
    for pr in repo_obj.get_pulls(state="open"):
        user = pr.user
        if user is None:
            continue
        login = user.login
        if login and login.lower() in trusted:
            prs.append(
                OpenPR(
                    repo=repo,
                    number=pr.number,
                    author=login,
                    title=pr.title,
                    url=pr.html_url,
                )
            )
    return sorted(prs, key=lambda p: p.number)


def _iso(value: datetime | None) -> str:
    return "" if value is None else value.isoformat()


def _should_exclude_actor(user: _PRActor, self_login: str | None) -> bool:
    if is_bot(user.login, user.type):
        return True
    return self_login is not None and user.login.lower() == self_login.lower()


def build_pr_fingerprint(pr: _FingerprintPR, *, self_login: str | None = None) -> PRFingerprint:
    changed_files = tuple(
        ChangedFile(path=f.filename, status=f.status, blob_sha=f.sha, previous_path=f.previous_filename)
        for f in pr.get_files()
    )

    human_events: list[HumanEvent] = []
    for comment in pr.get_issue_comments():
        user = comment.user
        if user is None or _should_exclude_actor(user, self_login):
            continue
        human_events.append(
            HumanEvent("issue_comment", comment.id, user.login, comment.body, None, _iso(comment.updated_at))
        )

    for review_comment in pr.get_review_comments():
        user = review_comment.user
        if user is None or _should_exclude_actor(user, self_login):
            continue
        human_events.append(
            HumanEvent(
                "review_comment",
                review_comment.id,
                user.login,
                review_comment.body,
                None,
                _iso(review_comment.updated_at),
            )
        )

    for review in pr.get_reviews():
        user = review.user
        if user is None or _should_exclude_actor(user, self_login):
            continue
        human_events.append(
            HumanEvent("review", review.id, user.login, review.body, review.state, _iso(review.submitted_at))
        )

    return PRFingerprint(
        base_sha=pr.base.sha,
        changed_files=changed_files,
        human_events=tuple(human_events),
    )
