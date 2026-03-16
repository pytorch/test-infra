"""Dataclass for revert decision messages sent to SQS queue."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import List, Optional


@dataclass(frozen=True)
class SignalDetail:
    """Details about a single signal that triggered the revert.

    Attributes:
        key: Unique identifier for the signal (e.g., job name, test name)
        job_base_name: Base name of the job (e.g., "pull / linux-focal-py3.8-gcc7")
        test_module: Test module path if this is a test-level signal
        wf_run_id: GitHub Actions workflow run ID
        job_id: GitHub Actions job ID
        job_url: Full URL to the specific job run (if available)
        hud_url: Full URL to the HUD view for this signal (if available)
    """

    key: str
    job_base_name: Optional[str] = None
    test_module: Optional[str] = None
    wf_run_id: Optional[int] = None
    job_id: Optional[int] = None
    job_url: Optional[str] = None
    hud_url: Optional[str] = None

    def __post_init__(self) -> None:
        """Validate required fields."""
        if not self.key:
            raise ValueError("key is required")


@dataclass(frozen=True)
class BreakingWorkflow:
    """Represents a workflow and all its broken signals that triggered the revert.

    Attributes:
        workflow_name: Name of the GitHub Actions workflow (e.g., "pull", "trunk")
        signals: List of individual signals that failed in this workflow
    """

    workflow_name: str
    signals: List[SignalDetail]

    def __post_init__(self) -> None:
        """Validate required fields."""
        if not self.workflow_name:
            raise ValueError("workflow_name is required")
        if not self.signals:
            raise ValueError("signals list cannot be empty")


@dataclass(frozen=True)
class RevertDecisionMessage:
    """Message sent to SQS queue when a revert decision is made.

    This message contains all relevant information about a revert action,
    allowing downstream systems to process and track autorevert decisions.

    Attributes:
        action: Type of action taken (e.g., "revert_requested")
        commit_sha: Full commit SHA being reverted
        pr_number: Pull request number
        pr_url: Full URL to the pull request
        pr_title: Title of the pull request
        repo_full_name: Repository in owner/repo format
        timestamp: ISO 8601 timestamp of when the action occurred
        revert_action: The revert action mode that was used
        action_type: Type of commit action ("merge" or "revert")
        breaking_workflows: List of workflows/jobs that triggered the revert
        breaking_notification_msg: Formatted notification message
        pr_author: GitHub username of the PR author (optional)
    """

    action: str
    commit_sha: str
    pr_number: int
    pr_url: str
    pr_title: str
    repo_full_name: str
    timestamp: str
    revert_action: str
    action_type: str
    breaking_workflows: List[BreakingWorkflow]
    breaking_notification_msg: str
    pr_author: Optional[str] = None

    def __post_init__(self) -> None:
        """Validate message fields."""
        if not self.action:
            raise ValueError("action is required")
        if not self.commit_sha:
            raise ValueError("commit_sha is required")
        if self.pr_number <= 0:
            raise ValueError("pr_number must be positive")
        if not self.pr_url:
            raise ValueError("pr_url is required")
        if not self.pr_title:
            raise ValueError("pr_title is required")
        if not self.repo_full_name or "/" not in self.repo_full_name:
            raise ValueError("repo_full_name must be in 'owner/repo' format")
        if not self.timestamp:
            raise ValueError("timestamp is required")
        if not self.revert_action:
            raise ValueError("revert_action is required")
        if not self.action_type or self.action_type not in ("merge", "revert"):
            raise ValueError("action_type must be 'merge' or 'revert'")
        if not self.breaking_workflows:
            raise ValueError("breaking_workflows must not be empty")
        if not self.breaking_notification_msg:
            raise ValueError("breaking_notification_msg is required")

    def to_json(self) -> str:
        """Serialize the message to a JSON string.

        Returns:
            JSON string representation of the message.
        """
        # Convert dataclass to dict, handling nested dataclasses
        message_dict = asdict(self)
        return json.dumps(message_dict)

    @classmethod
    def from_json(cls, json_str: str) -> RevertDecisionMessage:
        """Deserialize a JSON string to a RevertDecisionMessage.

        Args:
            json_str: JSON string to deserialize.

        Returns:
            RevertDecisionMessage instance.

        Raises:
            ValueError: If JSON is invalid or missing required fields.
            json.JSONDecodeError: If JSON string is malformed.
        """
        data = json.loads(json_str)
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: dict) -> RevertDecisionMessage:
        """Create a RevertDecisionMessage from a dictionary.

        Args:
            data: Dictionary containing message fields.

        Returns:
            RevertDecisionMessage instance.
        """
        # Convert breaking_workflows dicts to BreakingWorkflow instances if needed
        if "breaking_workflows" in data:
            workflows = data["breaking_workflows"]
            if workflows and not isinstance(workflows[0], BreakingWorkflow):
                data = data.copy()
                data["breaking_workflows"] = []
                for wf in workflows:
                    if isinstance(wf, dict):
                        # Convert signals dicts to SignalDetail instances
                        signals = wf.get("signals", [])
                        if signals and not isinstance(signals[0], SignalDetail):
                            wf = wf.copy()
                            wf["signals"] = [
                                SignalDetail(**sig) if isinstance(sig, dict) else sig
                                for sig in signals
                            ]
                        data["breaking_workflows"].append(BreakingWorkflow(**wf))
                    else:
                        data["breaking_workflows"].append(wf)

        return cls(**data)
