"""
WorkflowResolver: Resolve GitHub Actions workflows by exact display or file name.

- Exact matches only (no lowercasing or fuzzy matching)
- Caches per-repo resolver instances
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

import github

from .github_client_helper import GHClientFactory


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
        # Build a client: prefer configured factory; fall back to anonymous
        try:
            client = GHClientFactory().client
        except Exception:
            # Anonymous client for public data; may be rate limited
            client = github.Github()

        repository = client.get_repo(repo)
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
            # Build an informative message with available names
            display = ", ".join(sorted(self._by_display))
            files = ", ".join(sorted(self._by_file))
            raise ValueError(
                f"Workflow '{input_name}' not found in {self._repo_full_name}. "
                f"Available display names: [{display}]. Available files: [{files}]"
            )
        return ref

    # Internal helpers

    def _build_indices(self) -> None:
        for w in self._repository.get_workflows():
            name = getattr(w, "name", "") or ""
            path = getattr(w, "path", "") or ""
            base = os.path.basename(path) if path else ""
            if not (name and base):
                continue
            ref = WorkflowRef(display_name=name, file_name=base)
            self._by_display[name] = ref
            self._by_file[base] = ref
