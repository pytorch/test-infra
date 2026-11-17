"""The scan's tokens minted from GreenLight's GitHub App installation, one per job and repo (the Lambda).

``AppTokens`` is the ``tick.TokenSource`` the ``greenlight-scan`` Lambda runs with. It mints, once per
instance (one per tick), a ``DISPATCH_REPO`` token with ``DISPATCH_TOKEN_PERMISSIONS`` for the repos
config, the dispatch and the review runs, and a metadata-only token for ``GET /installation/repositories``,
which reports each repo the installation reaches with its canonical name, private flag and default
branch. Each configured repo the listing shows and the live checks pass gets its own token with
``REPO_TOKEN_PERMISSIONS`` and no ``actions``. A repo the installation lacks, or whose mint fails, is
that repo's ``RepoUnavailable``: GitHub refuses a whole token request that names one repo the
installation cannot reach. When the listing itself fails, the primary is still minted and the others
wait for the next tick. ``greenlight-review.yml`` mints the same two permission sets.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight import github_client, repo_scan
from greenlight.constants import DISPATCH_REPO
from greenlight.guards import IterationTimeout
from greenlight.repo_config import is_primary
from greenlight.repo_scan import RepoIdentity
from greenlight.tick import RepoUnavailable

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence

    from github import Github, GithubIntegration

    from greenlight.repo_config import RepoConfig, RepoEntry

logger = logging.getLogger(__name__)

DISPATCH_TOKEN_PERMISSIONS: dict[str, str] = {"actions": "write", "contents": "read"}
# pull_requests is write, not read: the scan revokes greenlight's own approval on a reverted or ineligible PR
# and writes greenlight's GL/* labels, whose issue-label endpoints GitHub's App-permission table lists under
# pull_requests: write.
REPO_TOKEN_PERMISSIONS: dict[str, str] = {"pull_requests": "write", "contents": "read", "members": "read"}
LISTING_TOKEN_PERMISSIONS: dict[str, str] = {"metadata": "read"}


def require_key(mapping: Mapping[str, str], key: str, source: str) -> str:
    if key not in mapping:
        raise ValueError(f"{source} is missing required key {key!r}")
    return mapping[key]


def repo_token_names(repo_config: RepoConfig) -> str:
    """The bare names of the served and safety-only repos, comma-separated: what a repo token must cover."""
    return ",".join(entry.repo.partition("/")[2] for entry, _served in repo_scan.scanned_entries(repo_config))


class AppTokens:
    """``tick.TokenSource`` minted from the App installation ``installation_id`` of ``owner``."""

    def __init__(
        self,
        integration: GithubIntegration,
        installation_id: int,
        *,
        owner: str = "pytorch",
        build_github: Callable[[str], Github] = github_client.build_client,
    ) -> None:
        self._integration = integration
        self._installation_id = installation_id
        self._owner = owner
        self._build_github = build_github
        self._dispatch_token: str | None = None
        self._listed = False
        self._listing: dict[str, RepoIdentity] | None = None
        self._listing_error: Exception | None = None

    def _mint(self, permissions: Mapping[str, str], repositories: Sequence[str] | None) -> str:
        # PyGithub 2.9.1's GithubIntegration.get_access_token sends only ``permissions`` and cannot
        # scope ``repositories``; the token is minted through the integration's public requester
        # (its documented escape hatch for endpoints PyGithub does not model) so both are applied.
        payload: dict[str, object] = {"permissions": dict(permissions)}
        if repositories is not None:
            payload["repositories"] = list(repositories)
        _headers, data = self._integration.requester.requestJsonAndCheck(
            "POST", f"/app/installations/{self._installation_id}/access_tokens", input=payload
        )
        return require_key(data, "token", "installation token response")

    def _name(self, repo: str) -> str:
        """``repo``'s name inside ``owner``, the form a token's ``repositories`` takes."""
        owner, _slash, name = repo.partition("/")
        if owner.lower() != self._owner.lower():
            raise RepoUnavailable(f"it is not in {self._owner}, the account the GitHub App installation belongs to")
        return name

    def dispatch_token(self) -> str:
        if self._dispatch_token is None:
            self._dispatch_token = self._mint(DISPATCH_TOKEN_PERMISSIONS, [self._name(DISPATCH_REPO)])
        return self._dispatch_token

    def _list(self) -> dict[str, RepoIdentity]:
        from github.PaginatedList import PaginatedList
        from github.Repository import Repository

        client = self._build_github(self._mint(LISTING_TOKEN_PERMISSIONS, None))
        try:
            repos = PaginatedList(
                Repository, client.requester, "/installation/repositories", None, list_item="repositories"
            )
            return {
                repo.full_name.lower(): RepoIdentity(repo.full_name, repo.private, repo.default_branch)
                for repo in repos
            }
        finally:
            github_client.close_client(client)

    def _installation(self) -> dict[str, RepoIdentity] | None:
        """What the installation reaches, keyed by lowercased full name; None when the listing failed."""
        if not self._listed:
            self._listed = True
            try:
                self._listing = self._list()
            except IterationTimeout:
                raise
            except Exception as exc:
                logger.exception("cannot list the repos the GitHub App installation reaches")
                self._listing_error = exc
        return self._listing

    def repo_token(self, entry: RepoEntry) -> str:
        name = self._name(entry.repo)
        listing = self._installation()
        if listing is None:
            if not is_primary(entry.repo):
                raise RepoUnavailable(f"the installation listing failed: {self._listing_error}")
            logger.warning("%s: the installation listing failed; minting its token without the live checks", entry.repo)
        else:
            identity = listing.get(entry.repo.lower())
            if identity is None:
                raise RepoUnavailable("the GitHub App is not installed on it")
            problem = repo_scan.identity_problem(entry, identity)
            if problem is not None:
                raise RepoUnavailable(problem)
        try:
            return self._mint(REPO_TOKEN_PERMISSIONS, [name])
        except IterationTimeout:
            raise
        except Exception as exc:
            logger.exception("%s: cannot mint its installation token", entry.repo)
            raise RepoUnavailable(f"cannot mint its installation token: {exc}") from exc
