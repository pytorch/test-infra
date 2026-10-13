"""List the open pytorch/pytorch PRs the review scan considers, and hand them to it as candidates.

A full listing walks every open PR. A fast listing walks the open PRs most recently updated first,
stops at the review window's cutoff, and adds every open PR labelled ``Reverted``, which the revert
guard acts on at any age. Anything else the scan acts on waits for a full listing: an idle PR
reverted only by its recorded row; a PR whose place in GitHub's updated order lags its
``updated_at``; and a PR idle longer than the review window whose review is unfinished: a failed,
cancelled or stuck one is retried at the first full listing after its timeout, and an in-flight one
whose fingerprint changed without bumping ``updated_at`` is re-dispatched there. Every source keeps
a PR only when its author is in the evaluation cohort and it is not a draft, and every listing comes
back de-duplicated and sorted by number.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from greenlight.constants import REVERTED_LABELS, TARGET_REPO
from greenlight.state import naive_utc

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable
    from datetime import datetime

    from github import Github

    from greenlight.github_types import _IssueClient, _ListedPR, _RepoClient

    FetchFn = Callable[[Github, frozenset[str]], list["OpenPR"]]
    FetchUpdatedFn = Callable[[Github, frozenset[str], datetime], list["OpenPR"]]

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class OpenPR:
    """One listed PR; ``head_sha`` is None when it came from the issues endpoint, which carries no head."""

    repo: str
    number: int
    author: str
    title: str
    url: str
    head_sha: str | None
    updated_at: datetime | None
    labels: tuple[str, ...] = ()


def _lowered(authors: Iterable[str]) -> frozenset[str]:
    return frozenset(author.lower() for author in authors)


def _to_open_pr(pr: _ListedPR, repo: str, cohort: frozenset[str], head_sha: str | None) -> OpenPR | None:
    user = pr.user
    if user is None:
        return None
    login = user.login
    if not login or login.lower() not in cohort or pr.draft:
        return None
    updated_at = pr.updated_at
    return OpenPR(
        repo=repo,
        number=pr.number,
        author=login,
        title=pr.title,
        url=pr.html_url,
        head_sha=head_sha,
        updated_at=naive_utc(updated_at) if updated_at is not None else None,
        labels=tuple(label.name for label in pr.labels),
    )


def _by_number(prs: Iterable[OpenPR | None]) -> list[OpenPR]:
    # The last copy of a PR wins. A paginated walk returns a PR twice when the list shifts between two
    # of its page requests.
    unique = {pr.number: pr for pr in prs if pr is not None}
    return sorted(unique.values(), key=lambda pr: pr.number)


def list_open_prs_by_authors(client: _RepoClient, repo: str, authors: Iterable[str]) -> list[OpenPR]:
    cohort = _lowered(authors)
    pulls = client.get_repo(repo).get_pulls(state="open")
    return _by_number(_to_open_pr(pr, repo, cohort, pr.head.sha) for pr in pulls)


def list_recently_updated_prs(
    client: _RepoClient, repo: str, authors: Iterable[str], *, cutoff: datetime
) -> list[OpenPR]:
    """List the open PRs updated after ``cutoff`` (naive UTC), walking the most recently updated first.

    The walk stops at the first PR updated at or before ``cutoff``; PyGithub requests each page only
    when the walk reaches it, so no later page is fetched. A PR with no ``updated_at`` never stops it.
    """
    cohort = _lowered(authors)
    listed: list[OpenPR | None] = []
    # GitHub sorts by updated ascending unless asked for descending.
    for pr in client.get_repo(repo).get_pulls(state="open", sort="updated", direction="desc"):
        updated_at = pr.updated_at
        if updated_at is not None and naive_utc(updated_at) <= cutoff:
            break
        listed.append(_to_open_pr(pr, repo, cohort, pr.head.sha))
    return _by_number(listed)


def list_reverted_prs(client: _IssueClient, repo: str, authors: Iterable[str]) -> list[OpenPR]:
    """List the open PRs carrying a label the revert guard matches, at any age.

    One issues-endpoint listing per label in ``REVERTED_LABELS``. The endpoint matches a label
    case-insensitively, as the guard does. Its payload carries each PR's author, labels,
    ``updated_at`` and draft flag but no head, so ``head_sha`` is None.
    """
    cohort = _lowered(authors)
    repo_obj = client.get_repo(repo)
    return _by_number(
        _to_open_pr(issue, repo, cohort, None)
        for label in sorted(REVERTED_LABELS)
        for issue in repo_obj.get_issues(state="open", labels=[label])
        if issue.pull_request is not None
    )


def default_fetch(client: Github, authors: frozenset[str]) -> list[OpenPR]:
    return list_open_prs_by_authors(client, TARGET_REPO, authors)


def default_fetch_updated(client: Github, authors: frozenset[str], cutoff: datetime) -> list[OpenPR]:
    """The PRs updated after ``cutoff``, plus the open ``Reverted`` PRs that walk missed.

    A PR in both keeps the ``Reverted`` listing's copy: read after the walk, its labels are fresher.
    """
    walked = list_recently_updated_prs(client, TARGET_REPO, authors, cutoff=cutoff)
    reverted = list_reverted_prs(client, TARGET_REPO, authors)
    walked_numbers = {pr.number for pr in walked}
    added = sum(pr.number not in walked_numbers for pr in reverted)
    logger.info("fast tick: %d PR(s) updated since the cutoff, plus %d labelled Reverted", len(walked), added)
    return _by_number([*walked, *reverted])


def candidate_numbers(
    client: Github,
    *,
    pr: int | None,
    authors: frozenset[str],
    fetch: FetchFn,
    cutoff: datetime | None,
    fetch_updated: FetchUpdatedFn,
) -> tuple[list[int], dict[int, datetime | None], dict[int, tuple[str, ...]], dict[int, str], dict[int, str | None]]:
    """Return the candidate PR numbers with their ``updated_at``, labels, author, and head.

    With no ``cutoff`` the listing is full (``fetch``); with one it is fast (``fetch_updated``). The
    ``--pr`` path has no listing to read labels, an author or a head from, so it returns none: the one
    caller that needs labels (``revert_guard``) fetches that single PR's, and the PR's author and
    authority come from its gate.
    """
    if pr is not None:
        logger.info("targeting single PR #%d in %s", pr, TARGET_REPO)
        return [pr], {}, {}, {}, {}
    if cutoff is None:
        open_prs = fetch(client, authors)
        tick = "full tick"
    else:
        open_prs = fetch_updated(client, authors, cutoff)
        tick = f"fast tick, updated since {cutoff:%Y-%m-%d %H:%M:%S} UTC"
    logger.info("found %d open PR(s) from %d author(s) in %s (%s)", len(open_prs), len(authors), TARGET_REPO, tick)
    for open_pr in open_prs:
        logger.debug("open PR #%d by %s: %s (%s)", open_pr.number, open_pr.author, open_pr.title, open_pr.url)
    return (
        [open_pr.number for open_pr in open_prs],
        {open_pr.number: open_pr.updated_at for open_pr in open_prs},
        {open_pr.number: open_pr.labels for open_pr in open_prs},
        {open_pr.number: open_pr.author for open_pr in open_prs},
        {open_pr.number: open_pr.head_sha for open_pr in open_prs},
    )
