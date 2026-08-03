"""GitHub pull-request access for the greenlight service.

Reads the open-PR list and the PR-fingerprint inputs, and performs the verdict write
actions: post an approving review, comment, and dismiss greenlight's own prior approvals.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from greenlight import constants
from greenlight.pr_hash import HumanEvent, PRFingerprint, compute_pr_hash, is_bot
from greenlight.review_gate import ReviewSkip, human_review_skip_reason
from greenlight.state import naive_utc

if TYPE_CHECKING:
    from collections.abc import Iterable
    from datetime import datetime

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
        @property
        def updated_at(self) -> datetime | None: ...

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
        @property
        def state(self) -> str: ...

    class _PRBase(Protocol):
        @property
        def sha(self) -> str: ...

    class _FingerprintPR(Protocol):
        @property
        def head(self) -> _PRBase: ...
        def get_issue_comments(self) -> Iterable[_PRComment]: ...
        def get_review_comments(self) -> Iterable[_PRComment]: ...
        def get_reviews(self) -> Iterable[_PRReview]: ...

    class _ScanRepo(Protocol):
        def get_pull(self, number: int) -> _FingerprintPR: ...

    class _AuthorPR(Protocol):
        @property
        def user(self) -> _PRUser | None: ...

    class _AuthorRepo(Protocol):
        def get_pull(self, number: int) -> _AuthorPR: ...

    class _AuthorClient(Protocol):
        def get_repo(self, full_name_or_id: str) -> _AuthorRepo: ...

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

    class VerdictPR(Protocol):
        @property
        def head(self) -> _PRBase: ...
        def create_review(self, *, body: str, event: str) -> object: ...
        def create_issue_comment(self, body: str) -> object: ...
        def get_issue_comments(self) -> Iterable[_VerdictComment]: ...
        def get_reviews(self) -> Iterable[_VerdictReview]: ...

    class _VerdictRepo(Protocol):
        def get_pull(self, number: int) -> VerdictPR: ...


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
    updated_at: datetime | None


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
            updated_at = pr.updated_at
            prs.append(
                OpenPR(
                    repo=repo,
                    number=pr.number,
                    author=login,
                    title=pr.title,
                    url=pr.html_url,
                    head_sha=pr.head.sha,
                    updated_at=naive_utc(updated_at) if updated_at is not None else None,
                )
            )
    return sorted(prs, key=lambda p: p.number)


def get_pr_author(client: _AuthorClient, repo: str, number: int) -> str | None:
    """Return the login of a single PR's author, or None if it has no resolvable user.

    Used by the ``--pr`` scan path to gate on the target PR's author: unlike the listing path
    (already filtered to trusted authors), ``--pr`` names an arbitrary PR, so the caller must
    verify its author before fingerprinting or dispatching a review.
    """
    pr = client.get_repo(repo).get_pull(number)
    user = pr.user
    return user.login if user is not None else None


def _actor_login(
    user: _PRActor | None, self_login: str | None, authorized_logins: frozenset[str] | None = None
) -> str | None:
    """Return the login to attribute an event to, or None if the actor is excluded.

    Excludes ghost/deleted actors (``user`` or its login missing), bots, and the
    greenlight account itself (``self_login``). The falsy-login guard runs before the
    ``self_login`` comparison so a null login never reaches ``.lower()``.

    When ``authorized_logins`` is given, an actor outside that (lowercased) set is also
    excluded, so only merge-authorized humans feed the fingerprint. ``None`` applies no
    such filter and keeps every non-bot, non-self human.
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
    if authorized_logins is not None and login.lower() not in authorized_logins:
        return None
    return login


def build_pr_fingerprint(
    pr: _FingerprintPR,
    *,
    reviews: Iterable[_PRReview],
    self_login: str | None = None,
    authorized_logins: frozenset[str] | None = None,
) -> PRFingerprint:
    """Build the deterministic fingerprint for a PR.

    ``reviews`` is the caller-materialized ``pr.get_reviews()`` list, threaded in so the
    reviews are fetched exactly once per fingerprint; issue comments and review comments are
    still fetched here.

    ``self_login`` MUST be exactly the greenlight bot account and identical on the
    writer and the verifier: the login passed here has its own events dropped, so a
    human login would exclude that human's reviews and open an approval-bypass.

    ``authorized_logins`` restricts the events to comments from that merge-authorized set
    (see ``merge_authz``); ``None`` keeps every non-bot, non-self human. The writer and
    the verifier MUST pass the identically-resolved set or their digests diverge.

    Coverage: the fingerprint covers ``head_sha`` and the ``id`` and ``body`` of
    non-bot, non-self human events (issue comments, review comments, and reviews). It
    deliberately EXCLUDES the changed files, event kind/author/state/timestamp, and the
    PR title/body.
    """
    human_events: list[HumanEvent] = []
    for comment in pr.get_issue_comments():
        if _actor_login(comment.user, self_login, authorized_logins) is None:
            continue
        human_events.append(HumanEvent(id=comment.id, body=comment.body))

    for review_comment in pr.get_review_comments():
        if _actor_login(review_comment.user, self_login, authorized_logins) is None:
            continue
        human_events.append(HumanEvent(id=review_comment.id, body=review_comment.body))

    for review in reviews:
        if _actor_login(review.user, self_login, authorized_logins) is None:
            continue
        human_events.append(HumanEvent(id=review.id, body=review.body))

    return PRFingerprint(
        head_sha=pr.head.sha,
        human_events=tuple(human_events),
    )


def fingerprint_pr(
    client: ScanClient,
    repo: str,
    pr_number: int,
    *,
    authorized_logins: frozenset[str] | None = None,
    allow_skip: bool = False,
    skip_on_approval: bool = False,
) -> tuple[str, str] | ReviewSkip:
    """Return the PR's ``(head_sha, eval_hash)``, or a ``ReviewSkip`` when it is human-decided.

    Reviews are materialized once. When ``allow_skip`` is set and a human has already
    decided the PR (``human_review_skip_reason``), that ``ReviewSkip`` is returned before
    reading ``head_sha`` or fetching comments -- so a skip costs only the one reviews call.
    Otherwise the full fingerprint is built (issue comments, review comments, and the same
    reviews list), costing ~3 paginated calls. ``authorized_logins`` is the merge-authorized
    filter threaded into both the skip check and ``build_pr_fingerprint``.
    """
    pr = client.get_repo(repo).get_pull(pr_number)
    reviews = list(pr.get_reviews())
    if allow_skip:
        skip = human_review_skip_reason(reviews, authorized_logins or frozenset(), skip_on_approval=skip_on_approval)
        if skip is not None:
            return skip
    head_sha = pr.head.sha
    eval_hash = compute_pr_hash(build_pr_fingerprint(pr, reviews=reviews, authorized_logins=authorized_logins))
    constants.validate_eval_hash(eval_hash)
    return head_sha, eval_hash


REVIEW_EVENT_APPROVE = "APPROVE"
REVIEW_EVENT_REQUEST_CHANGES = "REQUEST_CHANGES"
REVIEW_EVENT_COMMENT = "COMMENT"
_REVIEW_EVENTS: frozenset[str] = frozenset({REVIEW_EVENT_APPROVE, REVIEW_EVENT_REQUEST_CHANGES, REVIEW_EVENT_COMMENT})
_REVIEW_STATE_APPROVED = "APPROVED"


def get_pr(client: VerdictClient, repo: str, number: int) -> VerdictPR:
    return client.get_repo(repo).get_pull(number)


def post_review(pr: VerdictPR, *, event: str, body: str) -> None:
    if event not in _REVIEW_EVENTS:
        raise ValueError(f"unsupported review event {event!r}; expected one of {sorted(_REVIEW_EVENTS)}")
    pr.create_review(body=body, event=event)


_RUN_MARKER_RE = re.compile(r"<!-- greenlight-run: (\d+) -->")
# The run stamp lives in the header we fully control, above the <details> block that holds the
# untrusted (only defanged) model message; parsing stops there so a message cannot spoof a stamp.
_COMMENT_HEADER_END = "<details>"


def format_run_marker(run_id: int) -> str:
    return f"<!-- greenlight-run: {run_id} -->"


def parse_run_marker(body: str) -> int | None:
    header = body.split(_COMMENT_HEADER_END, 1)[0]
    match = _RUN_MARKER_RE.search(header)
    return int(match.group(1)) if match else None


def upsert_issue_comment(
    pr: VerdictPR, *, marker: str, body: str, author_login: str, run_id: int | None = None
) -> None:
    """Edit greenlight's own ``marker``-bearing comment in place, or create it if none exists.

    The author filter restricts edits to a comment authored by ``author_login`` so a copied
    ``marker`` in a third party's comment cannot hijack the canonical verdict comment.

    When ``run_id`` is given and the existing comment carries a strictly newer run's stamp, the
    edit is skipped: a superseded run must never regress the live run's comment.
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
        if run_id is not None:
            existing = parse_run_marker(comment.body)
            if existing is not None and existing > run_id:
                return
        comment.edit(body)
        return
    pr.create_issue_comment(body)


def dismiss_prior_greenlight_approvals(pr: VerdictPR, *, bot_login: str, message: str) -> list[int]:
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
