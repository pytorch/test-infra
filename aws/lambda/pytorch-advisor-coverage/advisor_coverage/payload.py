"""Isolated-red `signal_pattern` payload builder.

Assembles the advisor workflow's `signal_pattern` JSON for a single unclassified
trunk red: the failing suspect commit plus a few green baseline-before commits
of the same job. Matches the validated /tmp/ft_test_payload_*.json schema. The
top-level `signal_key` is COVERAGE_SIGNAL_KEY_PREFIX + the NORMALIZED native job
key (shard index + runner dropped); `workflow_name`, `signal_source`,
`suspect_commit`, and each commit event's concrete job name / log URL stay REAL.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Dict, List, Optional

from .config import COVERAGE_SIGNAL_KEY_PREFIX
from .enumeration import JobRun, RedSignal


_LABEL_FAILED = (
    "failed: commits where this signal FAILS, "
    "at or after the suspect commit (newest first)"
)
_LABEL_SUCCESSFUL = (
    "successful: baseline commits where this signal was GREEN before the suspect commit"
)


def _fmt_ts(dt: Optional[datetime]) -> str:
    if dt is None:
        return ""
    return dt.strftime("%Y-%m-%d %H:%M:%S UTC")


def _event(*, status: str, run: JobRun, repo_full_name: str) -> Dict[str, Any]:
    return {
        "status": status,
        "job_name": run.name,
        "job_id": run.job_id,
        "wf_run_id": run.wf_run_id,
        "run_attempt": run.run_attempt,
        "started_at": _fmt_ts(run.started_at),
        "ended_at": _fmt_ts(run.ended_at),
        "url": (
            f"https://github.com/{repo_full_name}/actions/runs/"
            f"{run.wf_run_id}/job/{run.job_id}"
        ),
        "log_url": (f"https://ossci-raw-job-status.s3.amazonaws.com/log/{run.job_id}"),
    }


def coverage_signal_key(red: RedSignal) -> str:
    """The prefixed signal_key for this red (dispatch + dedup + payload).

    `red.job_name` is the normalized job key, so this equals
    COVERAGE_SIGNAL_KEY_PREFIX + the native job signal_key the page joins on.
    """
    return COVERAGE_SIGNAL_KEY_PREFIX + red.job_name


def build_isolated_red_payload(red: RedSignal, repo_full_name: str) -> str:
    """Build the coverage advisor `signal_pattern` JSON for one red."""
    commits: List[Dict[str, Any]] = [
        {
            "sha": red.observed_commit,
            "timestamp": _fmt_ts(red.commit_time),
            "partition": _LABEL_FAILED,
            "is_suspect": True,
            "events": [
                _event(status="failure", run=red.suspect, repo_full_name=repo_full_name)
            ],
        }
    ]
    for baseline in red.baselines:
        commits.append(
            {
                "sha": baseline.sha,
                "timestamp": _fmt_ts(baseline.commit_time),
                "partition": _LABEL_SUCCESSFUL,
                "is_suspect": False,
                "events": [
                    _event(
                        status="success",
                        run=baseline.run,
                        repo_full_name=repo_full_name,
                    )
                ],
            }
        )

    payload: Dict[str, Any] = {
        "signal_key": coverage_signal_key(red),
        "signal_source": "job",
        "workflow_name": red.workflow_name,
        "job_base_name": red.job_base_name,
        "commit_order": "newest_first",
        "suspect_commit": red.observed_commit,
        "commits": commits,
    }
    return json.dumps(payload)
