"""Dispatch the greenlight PR-review workflow via a ``workflow_dispatch`` event.

The scanner calls ``dispatch_review`` to trigger a review run for a new-or-changed
trusted-author PR. It issues the single ``workflow_dispatch`` POST and nothing else: no
run-status polling and no cancel call -- the workflow's own per-PR concurrency group
supersedes any still-running review. The PyGithub client is injected, so this module never
constructs one or holds credentials.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Protocol

from greenlight import constants
from greenlight.constants import DEFAULT_DISPATCH_REF, DISPATCH_REPO, TARGET_REPO, WORKFLOW_FILE

if TYPE_CHECKING:

    class _Workflow(Protocol):
        def create_dispatch(self, ref: str, inputs: dict[str, str], throw: bool) -> bool: ...

    class _DispatchRepo(Protocol):
        def get_workflow(self, id_or_file_name: str) -> _Workflow: ...


logger = logging.getLogger(__name__)


class DispatchClient(Protocol):
    """Structural GitHub client for the dispatch path; the real ``github.Github`` satisfies it."""

    def get_repo(self, full_name_or_id: str) -> _DispatchRepo: ...


def dispatch_review(
    client: DispatchClient,
    pr_number: int,
    head_sha: str,
    eval_hash: str,
    ref: str = DEFAULT_DISPATCH_REF,
) -> None:
    """Fire the PR-review workflow for one PR.

    Every input is stringified because the workflow declares them ``type: string``. A
    malformed ``eval_hash`` or ``head_sha`` raises before any GitHub call. The dispatch is
    issued with ``throw=True`` so a PyGithub API error propagates; a ``False`` return
    becomes a ``RuntimeError`` rather than being swallowed.
    """
    constants.validate_eval_hash(eval_hash)
    constants.validate_head_sha(head_sha)

    inputs = {
        "pr_number": str(pr_number),
        "head_sha": head_sha,
        "eval_hash": eval_hash,
    }
    workflow = client.get_repo(DISPATCH_REPO).get_workflow(WORKFLOW_FILE)
    dispatched = workflow.create_dispatch(ref, inputs=inputs, throw=True)
    if not dispatched:
        raise RuntimeError(
            f"dispatch of {WORKFLOW_FILE} ({DISPATCH_REPO}@{ref}) to review {TARGET_REPO}#{pr_number} returned failure"
        )
    logger.info("dispatched %s (%s@%s) to review %s#%d", WORKFLOW_FILE, DISPATCH_REPO, ref, TARGET_REPO, pr_number)
