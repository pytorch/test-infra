"""Test doubles shared by the change-detection tests: PR records, a freshness reading, a listing client."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, cast

from greenlight.constants import TARGET_REPO
from greenlight.pr_listing import OpenPR

if TYPE_CHECKING:
    from greenlight.change_feed import Freshness

NOW = datetime(2026, 11, 17, 12, 0, 0)
RECENT = NOW - timedelta(hours=1)


def record(
    number: int,
    *,
    author: str = "alice",
    updated_at: datetime | None = RECENT,
    draft: bool = False,
    state: str = "open",
    labels: tuple[str, ...] = (),
    head_sha: str | None = None,
) -> OpenPR:
    """A pulls-endpoint record of PR ``number`` in ``TARGET_REPO``, its head ``sha<number>`` unless given."""
    return OpenPR(
        TARGET_REPO,
        number,
        author,
        f"fix {number}",
        f"url{number}",
        f"sha{number}" if head_sha is None else head_sha,
        updated_at,
        True,
        labels,
        draft,
        state,
    )


class FreshnessStub:
    """A freshness reading whose ``problem()`` answers ``problem``, or raises ``error``."""

    def __init__(self, problem: str | None = None, error: Exception | None = None) -> None:
        self._problem = problem
        self._error = error

    def problem(self) -> str | None:
        if self._error is not None:
            raise self._error
        return self._problem


def fresh(_repo: str) -> Freshness:
    """A ``read_freshness`` seam whose reading is always fresh."""
    return cast("Freshness", FreshnessStub())


@dataclass(frozen=True)
class _Login:
    login: str


@dataclass(frozen=True)
class _Ref:
    sha: str
    ref: str = "main"


class Pull:
    """A pulls-endpoint item as the listings read it, on ``main``, its head ``sha<number>``."""

    def __init__(self, number: int, updated_at: datetime, *, author: str = "alice", state: str = "open") -> None:
        self.number = number
        self.updated_at = updated_at
        self.state = state
        self.user = _Login(author)
        self.title = f"fix {number}"
        self.html_url = f"https://example.test/{number}"
        self.labels: list[object] = []
        self.draft = False
        self.head = _Ref(f"sha{number}")
        self.base = _Ref("main")
        self._rawData: dict[str, object] = {}


class ListingClient:
    """A client whose every repo lists ``pulls`` as the pulls endpoint would, and no ``Reverted`` PR.

    ``listed`` records each listing asked for, and each PR read alone.
    """

    def __init__(self, pulls: list[Pull]) -> None:
        self.pulls = pulls
        self.listed: list[str] = []

    def get_repo(self, _name: str) -> ListingClient:
        return self

    def get_pull(self, number: int) -> Pull:
        self.listed.append(f"pull {number}")
        [pull] = [pull for pull in self.pulls if pull.number == number]
        return pull

    def get_pulls(self, state: str = "", sort: str = "", direction: str = "") -> list[Pull]:
        self.listed.append(f"pulls {state}")
        pulls = [pull for pull in self.pulls if state == "all" or pull.state == state]
        return sorted(pulls, key=lambda pull: pull.updated_at, reverse=True) if sort == "updated" else pulls

    def get_issues(self, *, state: str, labels: list[str]) -> list[object]:
        self.listed.append(f"issues {state} {labels}")
        return []

    def close(self) -> None:
        pass
