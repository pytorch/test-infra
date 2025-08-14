import logging
from dataclasses import dataclass
from typing import Optional

from .clickhouse_client_helper import CHCliFactory


def log_autorevert_event(
    *,
    workflow: str,
    action: str,
    first_failing_sha: str,
    previous_sha: str,
    failure_rule: str,
    job_name_base: str,
    second_failing_sha: Optional[str] = None,
    dry_run: bool = False,
    notes: str = "",
) -> None:
    """Insert a single autorevert event row into ClickHouse.

    Uses the misc.autorevert_events table. Best-effort: logs and continues on failure.
    """
    try:
        columns = [
            "workflow",
            "action",
            "first_failing_sha",
            "previous_sha",
            "second_failing_sha",
            "failure_rule",
            "job_name_base",
            "dry_run",
            "notes",
        ]
        data = [
            [
                workflow,
                action,
                first_failing_sha,
                previous_sha,
                second_failing_sha,
                failure_rule,
                job_name_base,
                1 if dry_run else 0,
                notes or "",
            ]
        ]
        # Specify database explicitly since this table lives in 'misc'
        CHCliFactory().client.insert(
            table="autorevert_events",
            data=data,
            column_names=columns,
            database="misc",
        )
    except Exception as e:
        logging.warning(f"Failed to log autorevert event to ClickHouse: {e}")


@dataclass
class AutoRevertEvent:
    workflow: str
    first_failing_sha: str
    previous_sha: str
    second_failing_sha: Optional[str]
    failure_rule: str
    job_name_base: str
    dry_run: bool = False
    notes: str = ""

    def send(self, action: str, notes: Optional[str] = None) -> None:
        """Send this event with the given action; optional notes override."""
        log_autorevert_event(
            workflow=self.workflow,
            action=action,
            first_failing_sha=self.first_failing_sha,
            previous_sha=self.previous_sha,
            second_failing_sha=self.second_failing_sha,
            failure_rule=self.failure_rule,
            job_name_base=self.job_name_base,
            dry_run=self.dry_run,
            notes=(notes if notes is not None else self.notes),
        )

    def send_restart_outcome(
        self, *, already_count: int, success_count: int, failure_count: int
    ) -> None:
        """Consolidated restart outcome sender with minimal branching."""
        if self.dry_run or (
            already_count > 0 and success_count == 0 and failure_count == 0
        ):
            self.send(
                "restart_skipped",
                notes=(
                    "dry_run" if self.dry_run else f"already_restarted={already_count}"
                ),
            )
            return

        action = "restart_dispatched" if success_count > 0 else "restart_failed"
        notes = f"success={success_count}, failures={failure_count}, already={already_count}"
        self.send(action, notes=notes)
