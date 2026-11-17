"""List a repo's PRs for the review scan, and hand its candidates to it.

Each listed PR becomes an ``OpenPR`` record, whoever wrote it, drafts included; ``is_candidate`` is the
one rule that makes a record a candidate: open, its author in the evaluation cohort, not a draft. Every
listing comes back de-duplicated and sorted by number. A PR from the pulls endpoint also carries its
base ref and whether ``merge_authz.accepts_base``, trymerge's base rule matched by branch names, accepts
it, judged from the listing's own payload. ``change_listing`` picks the listings each tick runs, by the repo's
change source.

On a ``github`` repo, a full listing walks every open PR. A fast listing walks the open PRs most
recently updated first, stops at the review window's cutoff, and adds every open PR labelled
``Reverted``, which the revert guard acts on at any age. Anything else the scan acts on waits for a
full listing: an idle PR reverted only by its recorded row; a PR whose place in GitHub's updated order
lags its ``updated_at``; and a PR idle longer than the review window whose review is unfinished: a
failed, cancelled or stuck one is retried at the first full listing after its timeout, and an in-flight
one whose fingerprint changed without bumping ``updated_at`` is re-dispatched there.

On a ``clickhouse`` repo, a full listing (its sweep, every ``full_tick_minutes`` while HUD's webhook
tables are fresh) rebuilds the repo's view of its open PRs (``pr_view``), and between sweeps a walk of
every PR, open or closed, back to the previous listing's start less ``LISTING_OVERLAP`` updates the
view, while the open ``Reverted`` PRs join each tick's candidates without entering it. Every
``FULL_TICK_INTERVAL`` a wide tick hands the scan every candidate in the view, so the revert guard and
the retry of unfinished reviews reach as far as a ``github`` repo's full listing. A PR whose place in
the updated order lags enters the review window through its marker's newest non-bot comment or
``pull_request`` event, and a cohort PR whose marker shows a ``pull_request`` event its record lacks is
read alone (``read_record``). What waits for the sweep, and only on a PR whose latest recorded row is not a
``LAND`` (``scan_memory`` revalidates those every ``FULL_TICK_INTERVAL``): an issue comment deletion
that does not bump ``updated_at``; an approver's login rename; and a non-bumping event (a review
dismissal, an inline comment edit) whose webhook HUD lost, or that a stalled stream holds below its
table's threshold.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, NamedTuple

from greenlight.constants import REVERTED_LABELS
from greenlight.merge_authz import accepts_base, is_default_base
from greenlight.state import naive_utc

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
    from datetime import datetime

    from github import Github

    from greenlight.github_types import _IssueClient, _ListedPR, _PRHead, _PRRef, _PullRequest, _RepoClient

    FetchFn = Callable[[Github, str, frozenset[str]], list["OpenPR"]]
    FetchUpdatedFn = Callable[[Github, str, frozenset[str], datetime], list["OpenPR"]]

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class OpenPR:
    """One listed PR; ``head_sha``, ``base_accepted`` and ``base_ref`` are None when it came from the issues endpoint.

    That endpoint carries no head and no base, so such a PR is judged by its author alone. ``state`` is
    GitHub's ``open`` or ``closed`` (a merged PR is closed).
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
    draft: bool = False
    state: str = "open"
    base_ref: str | None = None


class Candidates(NamedTuple):
    """The scan's candidate PR numbers, with each one's ``updated_at``, labels, author and head."""

    numbers: list[int]
    updated_at: dict[int, datetime | None]
    labels: dict[int, tuple[str, ...]]
    authors: dict[int, str]
    heads: dict[int, str | None]


class _ListedRefs(NamedTuple):
    head: _PRHead
    base: _PRRef
    raw_data: Mapping[str, object]


def lowered(authors: Iterable[str]) -> frozenset[str]:
    return frozenset(author.lower() for author in authors)


def is_candidate(record: OpenPR, cohort: frozenset[str]) -> bool:
    """Whether the scan considers ``record``: open, its author in ``cohort`` (lower-cased logins), not a draft."""
    return record.state == "open" and record.author.lower() in cohort and not record.draft


def _listed_base_accepted(pr: _PullRequest) -> bool:
    # PyGithub's raw_data completes a listed PR with one GET each; _rawData is the list payload as received.
    return accepts_base(_ListedRefs(pr.head, pr.base, pr._rawData))


def _record(pr: _ListedPR, repo: str, pull: _PullRequest | None) -> OpenPR | None:
    """``pr`` as an ``OpenPR`` whoever wrote it, or None when it names no author.

    ``pull`` is ``pr`` itself from the pulls endpoint, None from the issues endpoint, which is only ever
    asked for open PRs.
    """
    user = pr.user
    login = None if user is None else user.login
    if not login:
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
        draft=pr.draft,
        state=pull.state if pull is not None else "open",
        base_ref=pull.base.ref if pull is not None else None,
    )


def _by_number(prs: Iterable[OpenPR | None]) -> list[OpenPR]:
    # The last copy of a PR wins. A paginated walk returns a PR twice when the list shifts between two
    # of its page requests.
    unique = {pr.number: pr for pr in prs if pr is not None}
    return sorted(unique.values(), key=lambda pr: pr.number)


def _candidates(records: Iterable[OpenPR | None], authors: Iterable[str]) -> list[OpenPR]:
    cohort = lowered(authors)
    return _by_number(record for record in records if record is not None and is_candidate(record, cohort))


def _open_records(client: _RepoClient, repo: str) -> Iterator[OpenPR | None]:
    return (_record(pr, repo, pr) for pr in client.get_repo(repo).get_pulls(state="open"))


def list_open_records(client: _RepoClient, repo: str) -> list[OpenPR]:
    """Every open PR, whoever wrote it, drafts included."""
    return _by_number(_open_records(client, repo))


def list_open_prs_by_authors(client: _RepoClient, repo: str, authors: Iterable[str]) -> list[OpenPR]:
    return _candidates(_open_records(client, repo), authors)


def _walk_updated(client: _RepoClient, repo: str, *, cutoff: datetime, state: str) -> list[OpenPR | None]:
    listed: list[OpenPR | None] = []
    # GitHub sorts by updated ascending unless asked for descending.
    for pr in client.get_repo(repo).get_pulls(state=state, sort="updated", direction="desc"):
        updated_at = pr.updated_at
        if updated_at is not None and naive_utc(updated_at) <= cutoff:
            break
        listed.append(_record(pr, repo, pr))
    return listed


def read_record(client: Github, repo: str, number: int) -> OpenPR | None:
    """PR ``number`` as ``list_open_records`` builds each record, read with one GET; None when it names no author.

    The scan's client builds lazy objects: the GET happens at the record builder's first attribute read,
    before it reads the payload the base is judged from.
    """
    pull = client.get_repo(repo).get_pull(number)
    return _record(pull, repo, pull)


def list_recent_records(client: _RepoClient, repo: str, *, cutoff: datetime, state: str) -> list[OpenPR]:
    """Every PR in ``state`` (``open``, ``closed`` or ``all``) updated after ``cutoff`` (naive UTC), whoever wrote it.

    The walk goes most recently updated first and stops at the first PR updated at or before ``cutoff``;
    PyGithub requests each page only when the walk reaches it, so no later page is fetched. A PR with no
    ``updated_at`` never stops it.
    """
    return _by_number(_walk_updated(client, repo, cutoff=cutoff, state=state))


def list_recently_updated_prs(
    client: _RepoClient, repo: str, authors: Iterable[str], *, cutoff: datetime
) -> list[OpenPR]:
    """The candidates among the open PRs updated after ``cutoff``, walked as ``list_recent_records`` walks."""
    return _candidates(_walk_updated(client, repo, cutoff=cutoff, state="open"), authors)


def list_reverted_prs(client: _IssueClient, repo: str, authors: Iterable[str]) -> list[OpenPR]:
    """List the candidates among the open PRs carrying a label the revert guard matches, at any age.

    One issues-endpoint listing per label in ``REVERTED_LABELS``. The endpoint matches a label
    case-insensitively, as the guard does. Its payload carries each PR's author, labels,
    ``updated_at`` and draft flag but no head or base, so ``head_sha`` and ``base_accepted`` are None.
    """
    repo_obj = client.get_repo(repo)
    return _candidates(
        (
            _record(issue, repo, None)
            for label in sorted(REVERTED_LABELS)
            for issue in repo_obj.get_issues(state="open", labels=[label])
            if issue.pull_request is not None
        ),
        authors,
    )


def default_fetch(client: Github, repo: str, authors: frozenset[str]) -> list[OpenPR]:
    return list_open_prs_by_authors(client, repo, authors)


def default_fetch_updated(client: Github, repo: str, authors: frozenset[str], cutoff: datetime) -> list[OpenPR]:
    """The PRs updated after ``cutoff``, plus the open ``Reverted`` PRs that walk missed.

    A PR in both keeps the ``Reverted`` listing's copy: read after the walk, its labels are fresher.
    """
    walked = list_recently_updated_prs(client, repo, authors, cutoff=cutoff)
    reverted = list_reverted_prs(client, repo, authors)
    walked_numbers = {pr.number for pr in walked}
    added = sum(pr.number not in walked_numbers for pr in reverted)
    logger.info("fast tick: %d PR(s) updated since the cutoff, plus %d labelled Reverted", len(walked), added)
    return _by_number([*walked, *reverted])


def _base_refused(open_pr: OpenPR, *, strict_base: bool) -> bool:
    if strict_base:
        return not is_default_base(open_pr.base_ref)
    return open_pr.base_accepted is False


def candidate_fields(open_prs: Sequence[OpenPR], *, strict_base: bool = False) -> Candidates:
    """``open_prs`` as the scan's candidates; a PR on a base the repo's rule refuses gets no author.

    The rule is ``merge_authz.accepts_base``, or under ``strict_base`` (a ``gate`` repo)
    ``merge_authz.is_default_base``, which also refuses a PR listed with no base.
    """
    refused = {open_pr.number for open_pr in open_prs if _base_refused(open_pr, strict_base=strict_base)}
    for open_pr in open_prs:
        logger.debug("open PR #%d by %s: %s (%s)", open_pr.number, open_pr.author, open_pr.title, open_pr.url)
        if open_pr.number in refused:
            logger.info("PR #%d by %s: base not accepted", open_pr.number, open_pr.author)
    return Candidates(
        [open_pr.number for open_pr in open_prs],
        {open_pr.number: open_pr.updated_at for open_pr in open_prs},
        {open_pr.number: open_pr.labels for open_pr in open_prs},
        {open_pr.number: open_pr.author for open_pr in open_prs if open_pr.number not in refused},
        {open_pr.number: open_pr.head_sha for open_pr in open_prs},
    )


def candidate_numbers(
    client: Github,
    *,
    repo: str,
    pr: int | None,
    authors: frozenset[str],
    fetch: FetchFn,
    cutoff: datetime | None,
    fetch_updated: FetchUpdatedFn,
    strict_base: bool = False,
) -> Candidates:
    """Return the candidate PR numbers with their ``updated_at``, labels, author, and head.

    With no ``cutoff`` the listing is full (``fetch``); with one it is fast (``fetch_updated``). The
    ``--pr`` path has no listing to read labels, an author or a head from, so it returns none: the one
    caller that needs labels (``revert_guard``) fetches that single PR's, and the PR's author and
    authority come from its gate. A PR listed on a base the repo's rule refuses (``candidate_fields``, with
    ``strict_base``) is still a candidate but gets no author, so the scan treats it as shadow.
    """
    if pr is not None:
        logger.info("targeting single PR #%d in %s", pr, repo)
        return Candidates([pr], {}, {}, {}, {})
    if cutoff is None:
        open_prs = fetch(client, repo, authors)
        tick = "full tick"
    else:
        open_prs = fetch_updated(client, repo, authors, cutoff)
        tick = f"fast tick, updated since {cutoff:%Y-%m-%d %H:%M:%S} UTC"
    logger.info("found %d open PR(s) from %d author(s) in %s (%s)", len(open_prs), len(authors), repo, tick)
    return candidate_fields(open_prs, strict_base=strict_base)
