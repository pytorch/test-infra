"""Decision records shared by the row-assembly and CLI tests.

Hand-built to the shape ``query.fetch_decisions`` returns, so nothing that uses
them touches ClickHouse or GitHub. They live here rather than in either test
module because both need the same records and two copies would drift.
"""

from datetime import datetime

from torchci.greenlight_decisions.loc import LOC_STATUS_OK


EM_DASH_MESSAGE = "Touches the ROCm CI script — rebase before landing."

DECIDED = {
    "repo": "pytorch/pytorch",
    "pr_number": 192258,
    "pr_url": "https://github.com/pytorch/pytorch/pull/192258",
    "pr_status": "closed-merged",
    "base_ref": "main",
    "decision": "LAND",
    "decision_reason": "clean",
    "decision_message": EM_DASH_MESSAGE,
    "decision_head_sha": "a" * 40,
    "decision_run_id": 1234567890,
    "decision_version": datetime(2026, 8, 14, 9, 30, 0),
    "final_head_sha": "b" * 40,
    "base_sha": "c" * 40,
    "lifecycle_status": "decided",
    "reverted": False,
    "n_terminal_decisions": 1,
    "human_approvals": 1,
    "human_approvers": "jeanschmidt",
    "human_changes_requested": 0,
    "human_change_requesters": "",
    "additions": 60,
    "deletions": 11,
    "changed_files": 3,
}

UNDECIDED = {
    **DECIDED,
    "pr_number": 194906,
    "pr_status": "open",
    "decision": "",
    "decision_reason": "",
    "decision_message": "",
    "decision_head_sha": "",
    "decision_run_id": None,
    "decision_version": None,
    "lifecycle_status": "in-flight",
    "n_terminal_decisions": 0,
}

MEASURED = {
    "loc": 71,
    "sig_loc": 64,
    "verdict_staleness": "content-changed",
    "files_changed_after_verdict": 1,
    "loc_status": LOC_STATUS_OK,
}
