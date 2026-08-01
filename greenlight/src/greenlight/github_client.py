"""GitHub pull-request access for the greenlight service.

Reads the open-PR list and the PR-fingerprint inputs, and performs the verdict write
actions: post an approving review, comment, and dismiss greenlight's own prior approvals.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from greenlight import constants
from greenlight.pr_hash import HumanEvent, PRFingerprint, compute_pr_hash, is_bot

if TYPE_CHECKING:
    from collections.abc import Iterable

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
        @property
        def head(self) -> _PRBase: ...

    class _Repo(Protocol):
        def get_pulls(self, state: str) -> Iterable[_PullRequest]: ...

    class _RepoClient(Protocol):
        def get_repo(self, full_name_or_id: str) -> _Repo: ...

    class _PRActor(Protocol):
        @property
        def login(self) -> str | None: ...
        @property
        def type(self) -> str: ...

    class _PRComment(Protocol):
        @property
        def id(self) -> int: ...
        @property
        def user(self) -> _PRActor | None: ...
        @property
        def body(self) -> str: ...

    class _PRReview(Protocol):
        @property
        def id(self) -> int: ...
        @property
        def user(self) -> _PRActor | None: ...
        @property
        def body(self) -> str: ...

    class _PRBase(Protocol):
        @property
        def sha(self) -> str: ...

    class _FingerprintPR(Protocol):
        @property
        def base(self) -> _PRBase: ...
        @property
        def head(self) -> _PRBase: ...
        def get_issue_comments(self) -> Iterable[_PRComment]: ...
        def get_review_comments(self) -> Iterable[_PRComment]: ...
        def get_reviews(self) -> Iterable[_PRReview]: ...

    class _ScanRepo(Protocol):
        def get_pull(self, number: int) -> _FingerprintPR: ...

    class _VerdictReview(Protocol):
        @property
        def id(self) -> int: ...
        @property
        def user(self) -> _PRUser | None: ...
        @property
        def state(self) -> str: ...
        def dismiss(self, message: str) -> None: ...

    class _VerdictComment(Protocol):
        @property
        def body(self) -> str: ...
        @property
        def user(self) -> _PRUser | None: ...
        def edit(self, body: str) -> None: ...

    class _VerdictPR(Protocol):
        @property
        def head(self) -> _PRBase: ...
        def create_review(self, *, body: str, event: str) -> object: ...
        def create_issue_comment(self, body: str) -> object: ...
        def get_issue_comments(self) -> Iterable[_VerdictComment]: ...
        def get_reviews(self) -> Iterable[_VerdictReview]: ...

    class _VerdictRepo(Protocol):
        def get_pull(self, number: int) -> _VerdictPR: ...


class VerdictClient(Protocol):
    """Structural GitHub client for the verdict path; the real ``github.Github`` satisfies it."""

    def get_repo(self, full_name_or_id: str) -> _VerdictRepo: ...


class ScanClient(Protocol):
    """Structural GitHub client for the scan/fingerprint path; the real ``github.Github`` satisfies it."""

    def get_repo(self, full_name_or_id: str) -> _ScanRepo: ...


@dataclass(frozen=True, slots=True)
class OpenPR:
    repo: str
    number: int
    author: str
    title: str
    url: str
    head_sha: str


# Pin the request timeout so a future PyGithub default change can't let
# worst-case pagination outlast the per-iteration runtime watchdog.
_GITHUB_TIMEOUT_SECONDS: int = 15


def build_client(token: str) -> Github:
    from github import Auth, Github  # lazy: keeps this module importable without the dep

    return Github(auth=Auth.Token(token), per_page=100, timeout=_GITHUB_TIMEOUT_SECONDS, lazy=True)


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
                    head_sha=pr.head.sha,
                )
            )
    return sorted(prs, key=lambda p: p.number)


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

    Coverage: the fingerprint covers ``base_sha``, ``head_sha``, and the ``id`` and
    ``body`` of non-bot, non-self human events (issue comments, review comments, and
    reviews). It deliberately EXCLUDES the changed files, event kind/author/state/
    timestamp, and the PR title/body.
    """
    human_events: list[HumanEvent] = []
    for comment in pr.get_issue_comments():
        if _actor_login(comment.user, self_login) is None:
            continue
        human_events.append(HumanEvent(id=comment.id, body=comment.body))

    for review_comment in pr.get_review_comments():
        if _actor_login(review_comment.user, self_login) is None:
            continue
        human_events.append(HumanEvent(id=review_comment.id, body=review_comment.body))

    for review in pr.get_reviews():
        if _actor_login(review.user, self_login) is None:
            continue
        human_events.append(HumanEvent(id=review.id, body=review.body))

    return PRFingerprint(
        base_sha=pr.base.sha,
        head_sha=pr.head.sha,
        human_events=tuple(human_events),
    )


def fingerprint_pr(client: ScanClient, repo: str, pr_number: int) -> tuple[str, str]:
    """Fetch the PR and return its ``(head_sha, eval_hash)``.

    Beyond the pull fetch this costs ~3 paginated GitHub calls: ``build_pr_fingerprint``
    reads issue comments, review comments, and reviews.
    """
    pr = client.get_repo(repo).get_pull(pr_number)
    head_sha = pr.head.sha
    eval_hash = compute_pr_hash(build_pr_fingerprint(pr))
    constants.validate_eval_hash(eval_hash)
    return head_sha, eval_hash


REVIEW_EVENT_APPROVE = "APPROVE"
REVIEW_EVENT_REQUEST_CHANGES = "REQUEST_CHANGES"
REVIEW_EVENT_COMMENT = "COMMENT"
_REVIEW_EVENTS: frozenset[str] = frozenset({REVIEW_EVENT_APPROVE, REVIEW_EVENT_REQUEST_CHANGES, REVIEW_EVENT_COMMENT})
_REVIEW_STATE_APPROVED = "APPROVED"


def get_pr(client: VerdictClient, repo: str, number: int) -> _VerdictPR:
    return client.get_repo(repo).get_pull(number)


def post_review(pr: _VerdictPR, *, event: str, body: str) -> None:
    if event not in _REVIEW_EVENTS:
        raise ValueError(f"unsupported review event {event!r}; expected one of {sorted(_REVIEW_EVENTS)}")
    pr.create_review(body=body, event=event)


def upsert_issue_comment(pr: _VerdictPR, *, marker: str, body: str, author_login: str) -> None:
    """Edit greenlight's own ``marker``-bearing comment in place, or create it if none exists.

    The author filter restricts edits to a comment authored by ``author_login`` so a copied
    ``marker`` in a third party's comment cannot hijack the canonical verdict comment.
    """
    if not author_login:
        raise ValueError("upsert_issue_comment requires a non-empty author_login")
    target = author_login.lower()
    for comment in pr.get_issue_comments():
        if marker not in comment.body:
            continue
        user = comment.user
        if user is None or not user.login or user.login.lower() != target:
            continue
        comment.edit(body)
        return
    pr.create_issue_comment(body)


def dismiss_prior_greenlight_approvals(pr: _VerdictPR, *, bot_login: str, message: str) -> list[int]:
    """Dismiss every prior APPROVED review authored by ``bot_login``.

    The login is passed in (the greenlight GitHub App's ``<slug>[bot]`` account) rather
    than read via ``get_user``, which is not available on an App installation token; only
    that account's own approvals are ever dismissed.
    """
    target = bot_login.lower()
    dismissed: list[int] = []
    for review in pr.get_reviews():
        user = review.user
        if user is None or not user.login:
            continue
        if user.login.lower() == target and review.state == _REVIEW_STATE_APPROVED:
            review.dismiss(message)
            dismissed.append(review.id)
    return dismissed
