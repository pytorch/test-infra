"""
WorkflowResolver: Resolve GitHub Actions workflows by exact display or file name.

- Exact matches only (no lowercasing or fuzzy matching)
- Caches per-repo resolver instances
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

import github

from .github_client_helper import GHClientFactory
from .utils import RetryWithBackoff


@dataclass(frozen=True)
class WorkflowRef:
    """Reference to a workflow's identities in a repository."""

    display_name: str
    file_name: str  # basename, e.g., "pull.yml"


class WorkflowResolver:
    """Caches workflows for a repo and resolves by exact names.

    Usage:
        resolver = WorkflowResolver.get("owner/repo")
        wf = resolver.resolve("pull")        # display name
        wf = resolver.resolve("pull.yml")    # file basename
    """

    def __init__(
        self, repo_full_name: str, repository: "github.Repository.Repository"
    ) -> None:
        if re.match(r"^[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$", repo_full_name) is None:
            raise ValueError(
                f"Invalid repo format: {repo_full_name}. Expected 'owner/repo'."
            )
        if repository is None or not isinstance(
            repository, github.Repository.Repository
        ):
            raise ValueError(f"Invalid repository object for {repo_full_name}.")

        self._repo_full_name = repo_full_name
        self._repository = repository
        self._by_display: dict[str, WorkflowRef] = {}
        self._by_file: dict[str, WorkflowRef] = {}
        self._build_indices()

    @staticmethod
    @lru_cache(maxsize=None)
    def get(repo: str) -> "WorkflowResolver":
        """Get a cached resolver for a repo in owner/repo format.

        Internally creates a GitHub Repository client using GHClientFactory when
        available; otherwise falls back to an anonymous client for public repos.
        """
        for attempt in RetryWithBackoff():
            with attempt:
                repository = GHClientFactory().client.get_repo(repo)
                return WorkflowResolver(repo_full_name=repo, repository=repository)

    def resolve(self, input_name: str) -> Optional[WorkflowRef]:
        """Resolve by exact display name, file basename, or full path.

        Returns None if no exact match is found.
        """
        if input_name in self._by_display:
            return self._by_display[input_name]
        if input_name in self._by_file:
            return self._by_file[input_name]
        return None

    def require(self, input_name: str) -> WorkflowRef:
        """Resolve or raise ValueError with a helpful message."""
        ref = self.resolve(input_name)
        if ref is None:
            display = ", ".join(sorted(self._by_display))
            files = ", ".join(sorted(self._by_file))
            raise ValueError(
                f"Workflow '{input_name}' not found in {self._repo_full_name}. "
                f"Available display names: [{display}]. Available files: [{files}]"
            )
        return ref

    def _build_indices(self) -> None:
        for attempt in RetryWithBackoff():
            with attempt:
                for w in self._repository.get_workflows():
                    name = getattr(w, "name", "") or ""
                    path = getattr(w, "path", "") or ""
                    base = os.path.basename(path) if path else ""
                    if not (name and base):
                        continue
                    ref = WorkflowRef(display_name=name, file_name=base)
                    self._by_display[name] = ref
                    self._by_file[base] = ref
