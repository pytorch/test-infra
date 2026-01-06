"""
WorkflowResolver: Resolve GitHub Actions workflows by exact display or file name.

- Exact matches only (no lowercasing or fuzzy matching)
- Caches per-repo resolver instances
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

import github
import yaml

from .github_client_helper import GHClientFactory
from .utils import RetryWithBackoff


@dataclass(frozen=True)
class WorkflowRef:
    """Reference to a workflow's identities in a repository."""

    display_name: str
    file_name: str  # basename, e.g., "pull.yml"


@dataclass(frozen=True)
class WorkflowInputSupport:
    """Describes which workflow_dispatch inputs a workflow accepts."""

    jobs_to_include: bool = False
    tests_to_include: bool = False

    @property
    def supports_filtering(self) -> bool:
        """True if workflow supports any filtering inputs."""
        return self.jobs_to_include or self.tests_to_include


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
        self._input_support_cache: dict[str, WorkflowInputSupport] = {}
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
                    # Skip disabled workflows (deleted files may leave stale entries)
                    state = getattr(w, "state", "") or ""
                    if state != "active":
                        continue
                    name = getattr(w, "name", "") or ""
                    path = getattr(w, "path", "") or ""
                    base = os.path.basename(path) if path else ""
                    if not (name and base):
                        continue
                    ref = WorkflowRef(display_name=name, file_name=base)
                    if name in self._by_display:
                        existing = self._by_display[name]
                        logging.warning(
                            "Duplicate workflow display name '%s': %s vs %s, keeping %s",
                            name,
                            existing.file_name,
                            base,
                            existing.file_name,
                        )
                        continue
                    self._by_display[name] = ref
                    self._by_file[base] = ref

    def get_input_support(self, workflow_name: str) -> WorkflowInputSupport:
        """Check if workflow supports filtering inputs by parsing its YAML.

        Args:
            workflow_name: Display name or file name of the workflow

        Returns:
            WorkflowInputSupport describing which inputs are accepted
        """
        ref = self.require(workflow_name)

        if ref.file_name in self._input_support_cache:
            return self._input_support_cache[ref.file_name]

        support = self._fetch_and_parse_workflow_inputs(ref.file_name)
        self._input_support_cache[ref.file_name] = support
        return support

    def _fetch_and_parse_workflow_inputs(self, file_name: str) -> WorkflowInputSupport:
        """Fetch workflow YAML from GitHub and parse for dispatch inputs.

        Args:
            file_name: Workflow file basename (e.g., "trunk.yml")

        Returns:
            WorkflowInputSupport with detected input support
        """
        path = f".github/workflows/{file_name}"

        for attempt in RetryWithBackoff():
            with attempt:
                contents = self._repository.get_contents(path)
                yaml_content = contents.decoded_content.decode("utf-8")

        return self._parse_workflow_inputs(yaml_content)

    def _parse_workflow_inputs(self, yaml_content: str) -> WorkflowInputSupport:
        """Parse workflow YAML content to detect supported dispatch inputs.

        Args:
            yaml_content: Raw YAML content of the workflow file

        Returns:
            WorkflowInputSupport with detected input support
        """
        try:
            workflow = yaml.safe_load(yaml_content)
            if not isinstance(workflow, dict):
                return WorkflowInputSupport()

            # YAML 1.1 parses "on" as boolean True, so check for both
            on_section = workflow.get("on") or workflow.get(True) or {}
            if isinstance(on_section, str):
                # Simple trigger like "on: push"
                return WorkflowInputSupport()

            workflow_dispatch = on_section.get("workflow_dispatch", {})
            if not isinstance(workflow_dispatch, dict):
                return WorkflowInputSupport()

            inputs = workflow_dispatch.get("inputs", {})
            if not isinstance(inputs, dict):
                return WorkflowInputSupport()

            support = WorkflowInputSupport(
                jobs_to_include="jobs-to-include" in inputs,
                tests_to_include="tests-to-include" in inputs,
            )

            logging.debug(
                "Workflow %s input support: jobs=%s, tests=%s",
                self._repo_full_name,
                support.jobs_to_include,
                support.tests_to_include,
            )

            return support

        except yaml.YAMLError:
            logging.warning("Failed to parse workflow YAML", exc_info=True)
            return WorkflowInputSupport()
        except Exception:
            logging.warning("Unexpected error parsing workflow inputs", exc_info=True)
            return WorkflowInputSupport()
