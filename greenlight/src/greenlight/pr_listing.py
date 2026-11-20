"""List the open pytorch/pytorch PRs the review scan considers, and hand them to it as candidates.

A full listing walks every open PR. A fast listing walks the open PRs most recently updated first,
stops at the review window's cutoff, and adds every open PR labelled ``Reverted``, which the revert
guard acts on at any age. Anything else the scan acts on waits for a full listing: an idle PR
reverted only by its recorded row; a PR whose place in GitHub's updated order lags its
``updated_at``; and a PR idle longer than the review window whose review is unfinished: a failed,
cancelled or stuck one is retried at the first full listing after its timeout, and an in-flight one
whose fingerprint changed without bumping ``updated_at`` is re-dispatched there. Every source keeps
a PR only when its author is in the evaluation cohort and it is not a draft, and every listing comes
back de-duplicated and sorted by number. A PR from the pulls endpoint also carries whether
``merge_authz.accepts_base``, trymerge's base rule matched by branch names, accepts it, judged from
the listing's own payload.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, NamedTuple

from greenlight.constants import REVERTED_LABELS, TARGET_REPO
from greenlight.merge_authz import accepts_base
from greenlight.state import naive_utc

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Mapping
    from datetime import datetime

    from github import Github

    from greenlight.github_types import _IssueClient, _ListedPR, _PRHead, _PRRef, _PullRequest, _RepoClient

    FetchFn = Callable[[Github, frozenset[str]], list["OpenPR"]]
    FetchUpdatedFn = Callable[[Github, frozenset[str], datetime], list["OpenPR"]]

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class OpenPR:
    """One listed PR; ``head_sha`` and ``base_accepted`` are None when it came from the issues endpoint.

    That endpoint carries no head and no base, so such a PR is judged by its author alone.
    """

    repo: str
    number: int
    author: str
    title: str
    url: str
    head_sha: str | None
    updated_at: datetime | None
    base_accepted: bool | None
    labels: tuple[str, ...] = ()


class _ListedRefs(NamedTuple):
    head: _PRHead
    base: _PRRef
    raw_data: Mapping[str, object]


def _lowered(authors: Iterable[str]) -> frozenset[str]:
    return frozenset(author.lower() for author in authors)


def _listed_base_accepted(pr: _PullRequest) -> bool:
    # PyGithub's raw_data completes a listed PR with one GET each; _rawData is the list payload as received.
    return accepts_base(_ListedRefs(pr.head, pr.base, pr._rawData))


def _to_open_pr(pr: _ListedPR, repo: str, cohort: frozenset[str], pull: _PullRequest | None) -> OpenPR | None:
    """``pr`` as an ``OpenPR``; ``pull`` is ``pr`` itself from the pulls endpoint, None from the issues endpoint."""
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
        head_sha=pull.head.sha if pull is not None else None,
        updated_at=naive_utc(updated_at) if updated_at is not None else None,
        base_accepted=_listed_base_accepted(pull) if pull is not None else None,
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
    return _by_number(_to_open_pr(pr, repo, cohort, pr) for pr in pulls)


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
        listed.append(_to_open_pr(pr, repo, cohort, pr))
    return _by_number(listed)


def list_reverted_prs(client: _IssueClient, repo: str, authors: Iterable[str]) -> list[OpenPR]:
    """List the open PRs carrying a label the revert guard matches, at any age.

    One issues-endpoint listing per label in ``REVERTED_LABELS``. The endpoint matches a label
    case-insensitively, as the guard does. Its payload carries each PR's author, labels,
    ``updated_at`` and draft flag but no head or base, so ``head_sha`` and ``base_accepted`` are None.
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
    authority come from its gate. A PR listed on a base ``merge_authz.accepts_base`` refuses is still a
    candidate but gets no author, so the scan treats it as shadow.
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
        if open_pr.base_accepted is False:
            logger.info("PR #%d by %s: base not accepted", open_pr.number, open_pr.author)
    return (
        [open_pr.number for open_pr in open_prs],
        {open_pr.number: open_pr.updated_at for open_pr in open_prs},
        {open_pr.number: open_pr.labels for open_pr in open_prs},
        {open_pr.number: open_pr.author for open_pr in open_prs if open_pr.base_accepted is not False},
        {open_pr.number: open_pr.head_sha for open_pr in open_prs},
    )
