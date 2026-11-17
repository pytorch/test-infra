"""GreenLight's own reviews: which stand, what the merge gate decides from them, and how they are read and dismissed.

The gate (``gate_check``), the verdict and the scan all judge GreenLight's approvals through these predicates, which
accept PyGithub review objects and ``ReviewRecord`` alike. ``ReviewReader`` reads a PR and its reviews with conditional
requests: a 304 costs no rate-limit request. A PR payload embeds its base and head repositories, so its ETag can
change while the PR itself does not.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from greenlight import constants
from greenlight.cohort import GREENLIGHT_APP_SLUG

if TYPE_CHECKING:
    from collections.abc import Callable, Collection, Iterable, Iterator

    from greenlight.github_types import GateReview, JsonRequester, VerdictPR, _VerdictReview

GREENLIGHT_LOGIN = f"{GREENLIGHT_APP_SLUG}{constants.BOT_LOGIN_SUFFIX}"
REVIEWS_PER_PAGE = 100

_REVIEW_STATE_APPROVED = "APPROVED"
_BOT_USER_TYPE = "Bot"
_PR_STATE_OPEN = "open"


def greenlight_reviews(pr: VerdictPR, bot_login: str) -> Iterator[_VerdictReview]:
    """Yield every review authored by ``bot_login`` (any state) -- greenlight's own reviews.

    The login is passed in (the greenlight App's ``<slug>[bot]`` account) since an App token
    cannot call ``get_user``. Null-user and empty-login reviews are skipped; match is case-insensitive.
    """
    target = bot_login.lower()
    for review in pr.get_reviews():
        user = review.user
        if user is not None and user.login and user.login.lower() == target:
            yield review


def dismiss_prior_greenlight_approvals(pr: VerdictPR, *, bot_login: str, message: str) -> list[int]:
    """Dismiss every prior APPROVED review authored by ``bot_login`` (see ``greenlight_reviews``)."""
    dismissed: list[int] = []
    for review in greenlight_reviews(pr, bot_login):
        if review.state == _REVIEW_STATE_APPROVED:
            review.dismiss(message)
            dismissed.append(review.id)
    return dismissed


def live_approvals[R: GateReview](reviews: Iterable[R], login: str, *, exact: bool = False) -> list[R]:
    """The APPROVED reviews authored by ``login``.

    ``exact=False`` compares logins case-insensitively; ``exact=True`` requires the login byte for byte and a
    ``Bot`` account, so a user account that merely spells the App's login never counts. A null user or an empty
    login never matches.
    """
    folded = login.lower()
    found: list[R] = []
    for review in reviews:
        user = review.user
        if review.state != _REVIEW_STATE_APPROVED or user is None or not user.login:
            continue
        if exact:
            if user.login == login and user.type == _BOT_USER_TYPE:
                found.append(review)
        elif user.login.lower() == folded:
            found.append(review)
    return found


@dataclass(frozen=True)
class GateDecision:
    passes: bool
    reason: str
    stale_commits: tuple[str | None, ...] = ()


def _commit_label(commit: str | None) -> str:
    return commit if commit else "an unknown commit"


def gate_decision(reviews: Iterable[GateReview], head_sha: str) -> GateDecision:
    """PASS unless a live GreenLight approval stands on a commit other than ``head_sha``.

    Every live approval counts, not only GreenLight's latest non-COMMENTED review: dismissing a review turns it
    into a comment on GitHub, so a dismissal can make an older approval the one that counts again.
    """
    head = head_sha.lower()
    live = live_approvals(reviews, GREENLIGHT_LOGIN, exact=True)
    stale = tuple(dict.fromkeys(r.commit_id for r in live if not r.commit_id or r.commit_id.lower() != head))
    if stale:
        named = ", ".join(_commit_label(commit) for commit in stale)
        return GateDecision(
            passes=False,
            reason=f"live GreenLight approval on {named} while the head is {head_sha}",
            stale_commits=stale,
        )
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
        data = _mapping(payload, "review")
        user = data.get("user")
        actor = None
        if user is not None:
            fields = _mapping(user, "review user")
            actor = ReviewActor(
                login=_optional(fields, "login", str, "review user"), type=_optional(fields, "type", str, "review user")
            )
        return cls(
            id=_required(data, "id", int, "review"),
            user=actor,
            state=_required(data, "state", str, "review"),
            commit_id=_optional(data, "commit_id", str, "review"),
            submitted_at=_timestamp(_optional(data, "submitted_at", str, "review")),
        )


@dataclass(frozen=True)
class PullFacts:
    number: int
    state: str
    head_sha: str
    base_ref: str
    default_branch: str | None
    updated_at: datetime | None

    @property
    def is_open(self) -> bool:
        return self.state == _PR_STATE_OPEN

    @classmethod
    def from_payload(cls, payload: object) -> PullFacts:
        data = _mapping(payload, "pull request")
        head = _mapping(data.get("head"), "pull request head")
        base = _mapping(data.get("base"), "pull request base")
        base_repo = base.get("repo")
        default_branch = None
        if base_repo is not None:
            default_branch = _optional(_mapping(base_repo, "base repo"), "default_branch", str, "base repo")
        return cls(
            number=_required(data, "number", int, "pull request"),
            state=_required(data, "state", str, "pull request"),
            head_sha=_required(head, "sha", str, "pull request head"),
            base_ref=_required(base, "ref", str, "pull request base"),
            default_branch=default_branch,
            updated_at=_timestamp(_optional(data, "updated_at", str, "pull request")),
        )


def _mapping(value: object, what: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{what} payload is not an object: {type(value).__name__}")
    return value


def _required[T](data: dict[str, Any], key: str, kind: type[T], what: str) -> T:
    value = data.get(key)
    if not isinstance(value, kind) or isinstance(value, bool):
        raise ValueError(f"{what} field {key!r} is not a {kind.__name__}: {value!r}")
    return value


def _optional[T](data: dict[str, Any], key: str, kind: type[T], what: str) -> T | None:
    return None if data.get(key) is None else _required(data, key, kind, what)


def _timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp {value!r} carries no time zone")
    return parsed.astimezone(UTC)


@dataclass(frozen=True)
class _Entry[T]:
    number: int
    etag: str
    value: T


class ReviewReader:
    """Reads PRs and their reviews with ``If-None-Match``, keeping each URL's ETag and parsed result.

    A 304 reuses the kept result. Read failures propagate. ``rebind`` hands a reader that outlives its client (the
    scan keeps one per repo between ticks) the next client's requester.
    """

    def __init__(self, requester: JsonRequester, *, per_page: int = REVIEWS_PER_PAGE) -> None:
        self._requester = requester
        self._per_page = per_page
        self._pulls: dict[tuple[str, int], _Entry[PullFacts]] = {}
        self._pages: dict[tuple[str, int, int], _Entry[tuple[ReviewRecord, ...]]] = {}

    def rebind(self, requester: JsonRequester) -> None:
        """Send every later read through ``requester``, keeping every kept result."""
        self._requester = requester

    def pull(self, repo: str, number: int) -> PullFacts:
        return self._get(
            self._pulls, (repo, number), number, f"/repos/{repo}/pulls/{number}", None, PullFacts.from_payload
        )

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
                number,
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

    def prune(self, keep: Collection[int]) -> None:
        """Forget every kept result of a PR whose number is not in ``keep``."""
        self._pulls = {key: entry for key, entry in self._pulls.items() if entry.number in keep}
        self._pages = {key: entry for key, entry in self._pages.items() if entry.number in keep}

    @staticmethod
    def _parse_page(payload: object) -> tuple[ReviewRecord, ...]:
        if not isinstance(payload, list):
            raise ValueError(f"reviews payload is not a list: {type(payload).__name__}")
        return tuple(ReviewRecord.from_payload(item) for item in payload)

    def _get[K, T](
        self,
        cache: dict[K, _Entry[T]],
        key: K,
        number: int,
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
            cache[key] = _Entry(number=number, etag=etag, value=value)
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
