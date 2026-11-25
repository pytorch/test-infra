"""GreenLight's own reviews: which stand, what the merge gate decides from them, and how they are read and dismissed.

The gate (``gate_check``), the verdict and the scan all judge GreenLight's approvals through these predicates, which
accept PyGithub review objects and ``ReviewRecord`` alike. ``ReviewReader`` reads a PR and its reviews with conditional
requests: a 304 costs no rate-limit request, but GitHub ties an ETag to the token that received it, so a 304 comes
back only while the token is the same. A PR payload embeds its base and head repositories, so its ETag can change
while the PR itself does not.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, TypeGuard

from greenlight import constants
from greenlight.cohort import GREENLIGHT_APP_SLUG

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Iterator

    from greenlight.github_types import GateReview, JsonRequester, VerdictPR, _VerdictReview

GREENLIGHT_LOGIN = f"{GREENLIGHT_APP_SLUG}{constants.BOT_LOGIN_SUFFIX}"
REVIEWS_PER_PAGE = 100
REVIEW_STATE_APPROVED = "APPROVED"

_UNCOUNTED_STATES = frozenset({"COMMENTED", "PENDING"})
_BOT_USER_TYPE = "Bot"
_PR_STATE_OPEN = "open"


def same_sha(left: str, right: str) -> bool:
    """Whether two commit SHAs name the same commit: GitHub's payloads and the ledger may differ in case."""
    return left.lower() == right.lower()


def on_commit(review: GateReview, sha: str) -> bool:
    """Whether ``review`` was given on ``sha`` (``same_sha``); a review on no known commit is not."""
    commit = review.commit_id
    if not commit:
        return False
    return same_sha(commit, sha)


def dismiss_approvals(reviews: Iterable[_VerdictReview], message: str) -> list[int]:
    """Dismiss each of ``reviews`` with ``message``; the ids dismissed, in order. A failed dismissal raises."""
    dismissed: list[int] = []
    for review in reviews:
        review.dismiss(message)
        dismissed.append(review.id)
    return dismissed


def dismiss_prior_greenlight_approvals(pr: VerdictPR, *, bot_login: str, message: str) -> list[int]:
    """Dismiss every live approval ``bot_login`` gave on ``pr`` (``live_approvals``, logins compared in any case).

    The login is passed in (the greenlight App's ``<slug>[bot]`` account) since an App token cannot call
    ``get_user``.
    """
    return dismiss_approvals(_iter_live_approvals(pr.get_reviews(), bot_login, exact=False), message)


def counted_review[R: GateReview](reviews: Iterable[R], login: str) -> R | None:
    """``login``'s latest review that is not COMMENTED or PENDING (logins compared in any case), or None.

    It is the one review of an author pytorchbot's trymerge counts. ``reviews`` are oldest first, as GitHub lists them.
    """
    folded = login.lower()
    counted: R | None = None
    for review in reviews:
        user = review.user
        if user is not None and user.login and user.login.lower() == folded and review.state not in _UNCOUNTED_STATES:
            counted = review
    return counted


def live_approvals[R: GateReview](reviews: Iterable[R], login: str, *, exact: bool = False) -> list[R]:
    """The APPROVED reviews authored by ``login``.

    ``exact=False`` compares logins case-insensitively; ``exact=True`` requires the login byte for byte and a
    ``Bot`` account, so a user account that merely spells the App's login never counts. A null user or an empty
    login never matches.
    """
    return list(_iter_live_approvals(reviews, login, exact=exact))


def _iter_live_approvals[R: GateReview](reviews: Iterable[R], login: str, *, exact: bool) -> Iterator[R]:
    """``live_approvals`` one review at a time, so a dismissal loop acts on each page before the next is read."""
    folded = login.lower()
    for review in reviews:
        user = review.user
        if review.state != REVIEW_STATE_APPROVED or user is None or not user.login:
            continue
        if exact:
            if user.login == login and user.type == _BOT_USER_TYPE:
                yield review
        elif user.login.lower() == folded:
            yield review


@dataclass(frozen=True)
class GateDecision:
    passes: bool
    reason: str


def _commit_label(commit: str | None) -> str:
    return commit if commit else "an unknown commit"


def gate_decision(reviews: Iterable[GateReview], head_sha: str) -> GateDecision:
    """PASS unless a live GreenLight approval stands on a commit other than ``head_sha``.

    Every live approval counts, not only GreenLight's latest non-COMMENTED review: GitHub's docs say a dismissal
    changes a review to a comment and do not say whether required approvals then count an older approval.
    """
    live = live_approvals(reviews, GREENLIGHT_LOGIN, exact=True)
    stale = dict.fromkeys(review.commit_id for review in live if not on_commit(review, head_sha))
    if stale:
        named = ", ".join(_commit_label(commit) for commit in stale)
        return GateDecision(passes=False, reason=f"live GreenLight approval on {named} while the head is {head_sha}")
    if live:
        return GateDecision(passes=True, reason=f"every live GreenLight approval is on the head {head_sha}")
    return GateDecision(passes=True, reason="no live GreenLight approval")


@dataclass(frozen=True)
class ReviewActor:
    login: str | None
    type: str | None


@dataclass(frozen=True)
class ReviewRecord:
    id: int
    user: ReviewActor | None
    state: str
    commit_id: str | None
    submitted_at: datetime | None

    @classmethod
    def from_payload(cls, payload: object) -> ReviewRecord:
        data = payload_mapping(payload, "review")
        user = data.get("user")
        actor = None
        if user is not None:
            fields = payload_mapping(user, "review user")
            actor = ReviewActor(
                login=payload_optional(fields, "login", str, "review user"),
                type=payload_optional(fields, "type", str, "review user"),
            )
        return cls(
            id=payload_required(data, "id", int, "review"),
            user=actor,
            state=payload_required(data, "state", str, "review"),
            commit_id=payload_optional(data, "commit_id", str, "review"),
            submitted_at=_timestamp(payload_optional(data, "submitted_at", str, "review")),
        )


@dataclass(frozen=True)
class PullFacts:
    number: int
    state: str
    head_sha: str
    base_ref: str

    @property
    def is_open(self) -> bool:
        return self.state == _PR_STATE_OPEN

    @classmethod
    def from_payload(cls, payload: object) -> PullFacts:
        data = payload_mapping(payload, "pull request")
        head = payload_mapping(data.get("head"), "pull request head")
        base = payload_mapping(data.get("base"), "pull request base")
        return cls(
            number=payload_required(data, "number", int, "pull request"),
            state=payload_required(data, "state", str, "pull request"),
            head_sha=payload_required(head, "sha", str, "pull request head"),
            base_ref=payload_required(base, "ref", str, "pull request base"),
        )


def payload_mapping(value: object, what: str) -> dict[str, Any]:
    """``value`` as a JSON object; ``ValueError`` naming ``what`` when it is not one."""
    if not isinstance(value, dict):
        raise ValueError(f"{what} is not an object: {type(value).__name__}")
    return value


def payload_is[T](value: object, kind: type[T]) -> TypeGuard[T]:
    """Whether ``value`` is a ``kind``; a JSON boolean passes only as a ``bool``, though Python counts it an ``int``."""
    return isinstance(value, kind) and (kind is bool or not isinstance(value, bool))


def payload_required[T](data: dict[str, Any], key: str, kind: type[T], what: str) -> T:
    """``data[key]`` as a ``kind`` (``payload_is``); ``ValueError`` naming ``what`` when it is absent or not one."""
    value = data.get(key)
    if not payload_is(value, kind):
        raise ValueError(f"{what} field {key!r} is not a {kind.__name__}: {value!r}")
    return value


def payload_optional[T](data: dict[str, Any], key: str, kind: type[T], what: str) -> T | None:
    """``data[key]`` as a ``kind``, or None when it is absent or null (``payload_required``)."""
    return None if data.get(key) is None else payload_required(data, key, kind, what)


def _timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp {value!r} carries no time zone")
    return parsed.astimezone(UTC)


@dataclass(frozen=True)
class _Entry[T]:
    etag: str
    value: T


class ReviewReader:
    """Reads PRs and their reviews with ``If-None-Match``, keeping each URL's ETag and parsed result.

    A 304 reuses the kept result. Read failures propagate.
    """

    def __init__(self, requester: JsonRequester, *, per_page: int = REVIEWS_PER_PAGE) -> None:
        self._requester = requester
        self._per_page = per_page
        self._pulls: dict[tuple[str, int], _Entry[PullFacts]] = {}
        self._pages: dict[tuple[str, int, int], _Entry[tuple[ReviewRecord, ...]]] = {}

    def pull(self, repo: str, number: int) -> PullFacts:
        return self._get(self._pulls, (repo, number), f"/repos/{repo}/pulls/{number}", None, PullFacts.from_payload)

    def reviews(self, repo: str, number: int) -> list[ReviewRecord]:
        """Every review of the PR, oldest first, reading pages until one holds fewer than ``per_page`` reviews.

        A new review always lands on the last page, so a full page that is unchanged says nothing about the next
        one: it is read on as a fresh page would be.
        """
        records: list[ReviewRecord] = []
        page = 1
        while True:
            items = self._get(
                self._pages,
                (repo, number, page),
                f"/repos/{repo}/pulls/{number}/reviews",
                {"per_page": self._per_page, "page": page},
                self._parse_page,
            )
            records.extend(items)
            if len(items) < self._per_page:
                break
            page += 1
        for key in [k for k in self._pages if k[0] == repo and k[1] == number and k[2] > page]:
            del self._pages[key]
        return records

    @staticmethod
    def _parse_page(payload: object) -> tuple[ReviewRecord, ...]:
        if not isinstance(payload, list):
            raise ValueError(f"reviews payload is not a list: {type(payload).__name__}")
        return tuple(ReviewRecord.from_payload(item) for item in payload)

    def _get[K, T](
        self,
        cache: dict[K, _Entry[T]],
        key: K,
        url: str,
        parameters: dict[str, Any] | None,
        parse: Callable[[object], T],
    ) -> T:
        cached = cache.get(key)
        headers = None if cached is None else {"If-None-Match": cached.etag}
        response_headers, data = self._requester.requestJsonAndCheck("GET", url, parameters=parameters, headers=headers)
        if data is None:
            if cached is None:
                raise ValueError(f"GET {url} returned no body with nothing kept to reuse")
            return cached.value
        value = parse(data)
        etag = response_headers.get("etag")
        if isinstance(etag, str) and etag:
            cache[key] = _Entry(etag=etag, value=value)
        else:
            cache.pop(key, None)
        return value


def dismiss_review(requester: JsonRequester, repo: str, number: int, review_id: int, message: str) -> None:
    """Dismiss one review; the client's transport retry is the only retry."""
    requester.requestJsonAndCheck(
        "PUT",
        f"/repos/{repo}/pulls/{number}/reviews/{review_id}/dismissals",
        input={"message": message, "event": "DISMISS"},
    )
