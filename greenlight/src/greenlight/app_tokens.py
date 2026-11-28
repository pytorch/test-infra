"""The scan Lambda's tokens, minted from GreenLight's GitHub App installation, each for one job.

``AppTokens`` mints:

- the dispatch token: ``DISPATCH_REPO`` alone with ``DISPATCH_TOKEN_PERMISSIONS``, for the dispatch and
  the review runs, once per instance;
- a repo token: one repo alone with ``REPO_TOKEN_PERMISSIONS`` and no ``actions``, for that repo's scan;
- the listing token: ``LISTING_TOKEN_PERMISSIONS`` only, for ``GET /installation/repositories``
  (``installation``), which reports each repo the installation reaches with its canonical name, private
  and archived flags and default branch;
- contents tokens: ``CONTENTS_TOKEN_PERMISSIONS`` for the repos named, at most 500 a token as GitHub
  allows, for the planner's reads of their config files (``contents_tokens``).

GitHub refuses a whole token request that names one repo the installation cannot reach, so a repo's
mint failure is that repo's ``RepoUnavailable``. A rate limit, on the listing or on any mint, is raised
as it is, so the caller latches on it. ``greenlight-review.yml`` mints the dispatch and repo permission
sets too.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight import github_client
from greenlight.constants import DISPATCH_REPO
from greenlight.guards import IterationTimeout
from greenlight.repo_scan import RepoIdentity, RepoUnavailable

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence

    from github import Github, GithubIntegration

logger = logging.getLogger(__name__)

DISPATCH_TOKEN_PERMISSIONS: dict[str, str] = {"actions": "write", "contents": "read"}
# pull_requests is write, not read: the scan revokes greenlight's own approval on a reverted or ineligible PR
# and writes greenlight's GL/* labels, whose issue-label endpoints GitHub's App-permission table lists under
# pull_requests: write.
REPO_TOKEN_PERMISSIONS: dict[str, str] = {"pull_requests": "write", "contents": "read", "members": "read"}
LISTING_TOKEN_PERMISSIONS: dict[str, str] = {"metadata": "read"}
CONTENTS_TOKEN_PERMISSIONS: dict[str, str] = {"contents": "read"}
_MAX_TOKEN_REPOSITORIES = 500


def require_key(mapping: Mapping[str, str], key: str, source: str) -> str:
    if key not in mapping:
        raise ValueError(f"{source} is missing required key {key!r}")
    return mapping[key]


class AppTokens:
    """Tokens minted from the App installation ``installation_id`` of ``owner``."""

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

    def repo_token(self, repo: str) -> str:
        """``repo``'s token; ``RepoUnavailable`` when it cannot be minted but for a rate limit, which raises."""
        name = self._name(repo)
        try:
            return self._mint(REPO_TOKEN_PERMISSIONS, [name])
        except IterationTimeout:
            raise
        except Exception as exc:
            if github_client.is_rate_limit_error(exc):
                raise
            logger.exception("%s: cannot mint its installation token", repo)
            raise RepoUnavailable(f"cannot mint its installation token: {exc}") from exc

    def installation(self, build_github: Callable[[str], Github] | None = None) -> dict[str, RepoIdentity]:
        """What the installation reaches, keyed by lowercased full name, read with a client ``build_github``
        makes (default: the instance's)."""
        from github.PaginatedList import PaginatedList
        from github.Repository import Repository

        client = (build_github or self._build_github)(self._mint(LISTING_TOKEN_PERMISSIONS, None))
        try:
            repos = PaginatedList(
                Repository, client.requester, "/installation/repositories", None, list_item="repositories"
            )
            return {
                repo.full_name.lower(): RepoIdentity(repo.full_name, repo.private, repo.default_branch, repo.archived)
                for repo in repos
            }
        finally:
            github_client.close_client(client)

    def contents_tokens(self, repos: Sequence[str]) -> dict[str, str]:
        """A ``contents: read`` token for each repo of ``repos``, one per 500 repos."""
        names = [(repo, self._name(repo)) for repo in repos]
        tokens: dict[str, str] = {}
        for start in range(0, len(names), _MAX_TOKEN_REPOSITORIES):
            chunk = names[start : start + _MAX_TOKEN_REPOSITORIES]
            token = self._mint(CONTENTS_TOKEN_PERMISSIONS, [name for _repo, name in chunk])
            tokens.update((repo, token) for repo, _name in chunk)
        return tokens
