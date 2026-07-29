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
        def login(self) -> str | None: ...

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
        def login(self) -> str | None: ...
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


# Pin the request timeout so a future PyGithub default change can't let
# worst-case pagination outlast the per-iteration runtime watchdog.
_GITHUB_TIMEOUT_SECONDS: int = 15


def build_client(token: str) -> Github:
    from github import Auth, Github  # lazy: keeps this module importable without the dep

    return Github(auth=Auth.Token(token), per_page=100, timeout=_GITHUB_TIMEOUT_SECONDS)


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


def _actor_login(user: _PRActor | None, self_login: str | None) -> str | None:
    """Return the login to attribute an event to, or None if the actor is excluded.

    Excludes ghost/deleted actors (``user`` or its login missing), bots, and the
    greenlight account itself (``self_login``). The falsy-login guard runs before the
    ``self_login`` comparison so a null login never reaches ``.lower()``.
    """
    if user is None:
        return None
    login = user.login
    if is_bot(login, user.type):
        return None
    if not login:
        return None
    if self_login is not None and login.lower() == self_login.lower():
        return None
    return login


def build_pr_fingerprint(pr: _FingerprintPR, *, self_login: str | None = None) -> PRFingerprint:
    """Build the deterministic fingerprint for a PR.

    ``self_login`` MUST be exactly the greenlight bot account and identical on the
    writer and the verifier: the login passed here has its own events dropped, so a
    human login would exclude that human's reviews and open an approval-bypass.

    Coverage (a product decision, to finalize at wiring time): the fingerprint covers
    ``base_sha``, the changed files (with content-derived ``blob_sha``), and non-bot,
    non-self human events. It deliberately EXCLUDES ``head.sha``, file mode,
    base-branch drift, and the PR title/body.
    """
    changed_files = tuple(
        ChangedFile(path=f.filename, status=f.status, blob_sha=f.sha, previous_path=f.previous_filename)
        for f in pr.get_files()
    )

    human_events: list[HumanEvent] = []
    for comment in pr.get_issue_comments():
        login = _actor_login(comment.user, self_login)
        if login is None:
            continue
        human_events.append(
            HumanEvent("issue_comment", comment.id, login, comment.body, None, _iso(comment.updated_at))
        )

    for review_comment in pr.get_review_comments():
        login = _actor_login(review_comment.user, self_login)
        if login is None:
            continue
        human_events.append(
            HumanEvent(
                "review_comment",
                review_comment.id,
                login,
                review_comment.body,
                None,
                _iso(review_comment.updated_at),
            )
        )

    for review in pr.get_reviews():
        login = _actor_login(review.user, self_login)
        if login is None:
            continue
        human_events.append(
            HumanEvent("review", review.id, login, review.body, review.state, _iso(review.submitted_at))
        )

    return PRFingerprint(
        base_sha=pr.base.sha,
        changed_files=changed_files,
        human_events=tuple(human_events),
    )
