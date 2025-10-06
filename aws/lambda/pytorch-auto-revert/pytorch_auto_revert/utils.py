import random
import time
import urllib.parse
from enum import Enum

import github


class AbstractExecAction:
    """Abstract base class for execution actions."""

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.value

    @property
    def side_effects(self) -> bool:
        raise NotImplementedError("Subclasses must implement this method")

    @classmethod
    def from_str(cls, label: any) -> "AbstractExecAction":
        lower_label = str(label).lower()
        for member in cls:
            if member.value.lower() == lower_label:
                return member
        raise ValueError(f"Unknown {cls.__name__} label: {label}")


class RestartAction(AbstractExecAction, Enum):
    """Controls restart behavior.

    - SKIP: no logging, no side effects
    - LOG: read prod state, log intended actions (no side effects)
    - RUN: read prod state, dispatch restarts (side effects)
    """

    SKIP = "skip"
    LOG = "log"
    RUN = "run"

    @property
    def side_effects(self) -> bool:
        """True if this mode performs external side effects (GitHub dispatch)."""
        return self is RestartAction.RUN


class RevertAction(AbstractExecAction, Enum):
    """Controls revert behavior.

    - SKIP: no logging, no side effects
    - LOG: read prod state, log revert intent only (no side effects)
    - RUN_LOG: read prod state, log revert intent with production dry-run flag (side effects limited to logging)
    - RUN_NOTIFY: read prod state, send notification (side effect) but no revert
    - RUN_REVERT: read prod state, perform revert (side effect)
    """

    SKIP = "skip"
    LOG = "log"
    RUN_LOG = "run-log"
    RUN_NOTIFY = "run-notify"
    RUN_REVERT = "run-revert"

    @property
    def side_effects(self) -> bool:
        """True if this mode performs external side effects or non-dry-run logging."""
        return self in (
            RevertAction.RUN_LOG,
            RevertAction.RUN_NOTIFY,
            RevertAction.RUN_REVERT,
        )


class _TryAgain(Exception):
    pass


class _Attempt:
    def __init__(self, ctrl):
        self._c = ctrl

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        # Success: stop the outer iterator
        if exc_type is None:
            self._c._done = True
            return False  # don't suppress; just signal done to iterator

        # Failure: if out of retries, let the original exception bubble
        if self._c._attempt >= self._c.max_retries:
            return False

        # Backoff before asking the iterator for another attempt
        delay = self._c.base_delay * (2 ** (self._c._attempt - 1))
        if self._c.jitter:
            delay += random.uniform(0, 0.1 * delay)
        time.sleep(delay)

        # Swallow the original exception so the iterator can decide to retry
        return True


class RetryWithBackoff:
    """
    Usage:
        for attempt in RetryWithBackoff(max_retries=4, base_delay=1, jitter=True):
            with attempt:
                # your code that might raise
    """

    def __init__(self, max_retries=5, base_delay=0.5, jitter=True):
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.jitter = jitter

    def __iter__(self):
        self._attempt = 1
        self._done = False
        while True:
            # Yield a context manager for the attempt; if the with-block
            # raised but is retryable, __exit__ returns True to suppress it.
            yield _Attempt(self)
            # If the with-block succeeded, stop iterating.
            if self._done:
                return
            # Otherwise, a retryable exception occurred and was suppressed.
            # Move to the next attempt.
            self._attempt += 1


def build_job_pytorch_url(repo_full_name: str, wf_run_id: str, job_id: str) -> str:
    return f"https://github.com/{repo_full_name}/actions/runs/{wf_run_id}/job/{job_id}"


def build_pytorch_hud_url(
    *,
    repo_full_name: str,
    top_sha: str,
    num_commits: int,
    job_base_name: str,
) -> str:
    """Build PyTorch HUD dashboard URL for a signal.

    Args:
        repo_full_name: Repository in format "owner/repo"
        top_sha: Most recent commit SHA
        num_commits: Number of commits to display
        job_base_name: Job base name to filter by

    Returns:
        URL to PyTorch HUD dashboard
    """
    encoded_name = urllib.parse.quote(job_base_name)
    return (
        f"https://hud.pytorch.org/hud/{repo_full_name}/{top_sha}/1?"
        f"per_page={num_commits}&name_filter={encoded_name}&mergeEphemeralLF=true"
    )


def proper_workflow_create_dispatch(
    workflow: github.Workflow,
    ref: github.Branch.Branch | github.Tag.Tag | github.Commit.Commit | str,
    inputs: dict,
) -> bool:
    """
    :calls: `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
    <https://docs.github.com/en/rest/reference/actions#create-a-workflow-dispatch-event>`
    """
    status, headers, body = workflow._requester.requestJson(
        "POST", f"{workflow.url}/dispatches", input={"ref": ref, "inputs": inputs}
    )
    if status != 204:
        raise ValueError(f"Error dispatching workflow: {status}, {headers}, {body}")
    return True
