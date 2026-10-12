"""Persist and validate the agent's upstream review results."""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, List, Mapping, Optional, Sequence


UPSTREAM_REPO = "vllm-project/vllm"
ISSUE_URL = re.compile(
    rf"^https://github\.com/{re.escape(UPSTREAM_REPO)}/issues/[1-9][0-9]*$"
)


class UpstreamStatus(StrEnum):
    """Status of the agent's upstream review."""

    UPSTREAM_CANDIDATES = "upstream_candidates"
    NO_HITS = "no_hits"
    SEARCH_INCOMPLETE = "search_incomplete"


# Agent review artifact.


@dataclass
class UpstreamIssueHit:
    """An issue selected by the agent as semantically related.

    Attributes:
        url: Canonical issue URL.
        title: Issue title.
        state: Issue state.
        reason: Why the agent judged the issue related.
    """

    url: str
    title: str
    state: str
    reason: str

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "UpstreamIssueHit":
        """Build an issue hit from decoded JSON data."""

        try:
            url = data["url"]
            title = data["title"]
            state = data["state"]
            reason = data["reason"]
        except KeyError as error:
            raise ValueError("issue is missing a required field") from error
        if not all(isinstance(value, str) for value in (url, title, state, reason)):
            raise ValueError("issue fields must be strings")
        return cls(url, title, state, reason)

    def __post_init__(self) -> None:
        """Validate the selected issue."""

        if not ISSUE_URL.fullmatch(self.url):
            raise ValueError(f"invalid canonical issue URL: {self.url!r}")
        if not self.title:
            raise ValueError("issue title must be non-empty")
        if self.state not in {"open", "closed"}:
            raise ValueError(f"invalid issue state: {self.state!r}")
        if not self.reason:
            raise ValueError("issue reason must be non-empty")


@dataclass
class IssueSearchResult:
    """The agent's review of one upstream query.

    Attributes:
        query: Query sent to the upstream issue search.
        total_count: Raw number of matching issues.
        issues: Issues selected as semantically related.
        error: Search or review error.
    """

    query: str
    total_count: Optional[int]
    issues: List[UpstreamIssueHit]
    error: Optional[str]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "IssueSearchResult":
        """Build a query result from decoded JSON data."""

        try:
            raw_issues = data["issues"]
            query = data["query"]
            total_count = data["total_count"]
            error = data["error"]
        except KeyError as missing:
            raise ValueError("search is missing a required field") from missing
        if not isinstance(raw_issues, list):
            raise ValueError("issues must be a list")
        if not isinstance(query, str):
            raise ValueError("query must be a string")
        if total_count is not None and (
            isinstance(total_count, bool) or not isinstance(total_count, int)
        ):
            raise ValueError("total_count must be an integer or null")
        if error is not None and not isinstance(error, str):
            raise ValueError("error must be a string or null")
        return cls(
            query,
            total_count,
            [UpstreamIssueHit.from_dict(issue) for issue in raw_issues],
            error,
        )

    def __post_init__(self) -> None:
        """Validate the query result."""

        successful = self.total_count is not None and self.error is None
        failed = self.total_count is None and self.error is not None
        if not successful and not failed:
            raise ValueError(
                "a search needs either a count with no error or a null count with an error"
            )
        if self.total_count is not None and self.total_count < 0:
            raise ValueError("search count must be non-negative")
        if self.total_count == 0 and self.issues:
            raise ValueError("zero-count search contains selected issues")


@dataclass
class CauseUpstreamCheck:
    """The agent's upstream review for one vLLM-routed cause.

    Attributes:
        cause_signature: Verbatim signature from the root-cause finding.
        status: Aggregate review status.
        searches: Query reviews for the cause.
    """

    cause_signature: str
    status: UpstreamStatus
    searches: List[IssueSearchResult]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "CauseUpstreamCheck":
        """Build a cause review from decoded JSON data."""

        try:
            raw_searches = data["searches"]
            cause_signature = data["cause_signature"]
            raw_status = data["status"]
        except KeyError as error:
            raise ValueError("check is missing a required field") from error
        if not isinstance(raw_searches, list):
            raise ValueError("searches must be a list")
        if not isinstance(cause_signature, str):
            raise ValueError("cause_signature must be a string")
        if not isinstance(raw_status, str):
            raise ValueError("status must be a string")
        try:
            status = UpstreamStatus(raw_status)
        except ValueError as error:
            raise ValueError(f"invalid status: {raw_status!r}") from error
        return cls(
            cause_signature,
            status,
            [IssueSearchResult.from_dict(search) for search in raw_searches],
        )

    def __post_init__(self) -> None:
        """Validate the cause review."""

        if not self.cause_signature:
            raise ValueError("cause_signature must be non-empty")
        if not isinstance(self.status, UpstreamStatus):
            raise ValueError("status must be an UpstreamStatus")
        if not self.searches:
            raise ValueError("searches must be non-empty")
        expected = status_for_searches(self.searches)
        if self.status != expected:
            raise ValueError(
                f"status {self.status!r} does not match reviewed searches {expected!r}"
            )


@dataclass
class UpstreamChecksArtifact:
    """Persisted upstream reviews for a triage run.

    Attributes:
        checks: Upstream reviews for vLLM-routed findings keyed by their root
            cause signatures.
    """

    checks: List[CauseUpstreamCheck]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "UpstreamChecksArtifact":
        """Build an artifact from decoded JSON data."""

        try:
            raw_checks = data["checks"]
        except KeyError as error:
            raise ValueError("artifact is missing a required field") from error
        if not isinstance(raw_checks, list):
            raise ValueError("checks must be a list")
        return cls([CauseUpstreamCheck.from_dict(check) for check in raw_checks])

    def __post_init__(self) -> None:
        """Validate artifact-local invariants."""

        signatures = [check.cause_signature for check in self.checks]
        if len(signatures) != len(set(signatures)):
            raise ValueError("cause_signature values must be unique")


def status_for_searches(searches: Sequence[IssueSearchResult]) -> UpstreamStatus:
    """Return the status represented by agent-reviewed searches.

    Args:
        searches: Query reviews for one cause.

    Returns:
        The status represented by the searches.
    """

    if not searches or any(search.error is not None for search in searches):
        return UpstreamStatus.SEARCH_INCOMPLETE
    if any(search.issues for search in searches):
        return UpstreamStatus.UPSTREAM_CANDIDATES
    return UpstreamStatus.NO_HITS


def build_upstream_checks(
    checks: Sequence[CauseUpstreamCheck],
) -> UpstreamChecksArtifact:
    """Build an artifact from agent-produced checks.

    Args:
        checks: Reviews produced by the upstream-review agent.

    Returns:
        The validated upstream-check artifact.
    """

    return UpstreamChecksArtifact(list(checks))


def read_upstream_checks(
    path: os.PathLike[str] | str,
) -> UpstreamChecksArtifact:
    """Load and validate an artifact.

    Args:
        path: Artifact path.

    Returns:
        The loaded and validated artifact.
    """

    return UpstreamChecksArtifact.from_dict(json.loads(Path(path).read_bytes()))


def write_upstream_checks(
    path: os.PathLike[str] | str, artifact: UpstreamChecksArtifact
) -> None:
    """Write an upstream-check artifact.

    Args:
        path: Destination path.
        artifact: Agent-produced artifact to write.
    """

    Path(path).write_text(
        json.dumps(asdict(artifact), indent=2) + "\n", encoding="utf-8"
    )
