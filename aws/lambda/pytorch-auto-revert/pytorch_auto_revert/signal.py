from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import List, Optional, Set, Union


class SignalStatus(Enum):
    """signal status enum"""

    PENDING = "pending"
    SUCCESS = "success"
    FAILURE = "failure"


# data classes:


@dataclass
class AutorevertPattern:
    """
    Represents an autorevert pattern detected in a signal.
    """

    pattern_detected: bool
    workflow_name: str
    newer_commits: List[str]
    older_commit: str
    # failed_job_names: List[str]  # TODO: Uncomment when needed
    # failure_rule: str              # TODO: Uncomment when needed
    # job_name_base: str             # TODO: Uncomment when needed


@dataclass
class RestartCommits:
    """
    Represents an intent to restart a specific set of commits on the signal.
    """

    commit_shas: Set[str]


class SignalEvent:
    """A single observation contributing to a Signal on a given commit.

    Represents one job/test/classification-derived event with a status and
    start/end timestamps used to reason about ordering and patterns.
    """

    def __init__(
        self,
        name: str,
        status: SignalStatus,
        started_at: datetime,
        ended_at: Optional[datetime] = None,
    ):
        self.name = name
        self.status = status
        self.started_at = started_at
        self.ended_at = ended_at

    @property
    def is_pending(self) -> bool:
        return self.status == SignalStatus.PENDING

    @property
    def is_success(self) -> bool:
        return self.status == SignalStatus.SUCCESS

    @property
    def is_failure(self) -> bool:
        return self.status == SignalStatus.FAILURE


class SignalCommit:
    """All events for a single commit, ordered oldest → newest by start time."""

    def __init__(self, head_sha: str, events: List[SignalEvent]):
        self.head_sha = head_sha
        # enforce events ordered by time, oldest first
        self.events = sorted(events, key=lambda e: e.started_at) if events else []

    def events_by_status(self, status: SignalStatus) -> List[SignalEvent]:
        """Get all events with the specified status."""
        return [event for event in self.events if event.status == status]

    # make iterable
    def __iter__(self):
        return iter(self.events)


class Signal:
    """A refined, column-like view of raw CI data for pattern detection.

    - key: stable identifier for the signal (e.g., normalized job/test name)
    - workflow_name: source workflow this signal is derived from
    - commits: newest → older list of SignalCommit objects for this signal
    """

    def __init__(self, key: str, workflow_name: str, commits: List[SignalCommit]):
        self.key = key
        self.workflow_name = workflow_name
        # commits are ordered from newest to oldest
        self.commits = commits

    def detect_recovered(self) -> bool:
        """
        Find the first commit with any non‑pending event; if it contains a success, consider the signal recovered.
        """
        # find the first non-pending existing commit in the signal
        for commit in self.commits:
            if not all(event.is_pending for event in commit):
                # If we found a commit with no pending jobs, check if it has any failed jobs
                return any(event.is_success for event in commit)  # recovered
        return False

    def detect_flaky(self) -> bool:
        """
        Checks whether signal is flaky, i.e. has both successful and failed events for any commit.
        Note: false result can mean that there is not enough data to determine flakiness.
        """
        for commit in self.commits:
            if any(event.is_success for event in commit) and any(
                event.is_failure for event in commit
            ):
                return True
        return False

    def confirm_not_an_infra_issue(self) -> Optional[bool]:
        """
        Considers pairs of commits: an older one with two successful jobs, and a newer one (not necessarily an immediate successor) with a failure.
        Checks if there is a "sandwich" pattern where:
        - The failure of the newer commit is between two successes of the older commit (time-wise).

        The goal of this it to eliminate the possibility of transient infra issue.

        Note: in the real world this relies on the previously checked invariants:
            * no flakiness - older commit will not have failures if it has successful job
            * not recovered - there is a newer commit with failure that is followed by an older commit with at least one success

        Returns:
            True if such a pattern exists, meaning the failure is likely **not** an infra issue (previously successful signal stays stable),
            False means no bracketing successes were observed; we can’t rule out infra, so prefer restarts (i.e. "not enough data", given "no flakiness" invariant is true).
            None is "Maybe", meaning the result depends on the resolution of the existing pending job.
        """
        if len(self.commits) < 2:
            return False

        maybe = False

        # Iterate through commits, looking for a newer commit with failure
        for i in range(0, len(self.commits) - 1):
            nc = self.commits[i]

            # Check all older commits before this one
            for j in range(i + 1, len(self.commits)):
                oc = self.commits[j]
                # Check if this older commit has two successful jobs
                oc_successes = oc.events_by_status(SignalStatus.SUCCESS)
                oc_pending = oc.events_by_status(SignalStatus.PENDING)

                if len(oc_successes) >= 2:
                    # Check if the failure of the newer commit is between the two successes of the older commit
                    # Events are ordered by time within each commit, oldest events first
                    for e in nc.events:
                        if (
                            oc_successes[0].started_at
                            < e.started_at
                            < oc_successes[-1].started_at
                        ):
                            if e.is_failure:
                                # We have a sandwich pattern
                                return True
                            elif e.is_pending:
                                # We have a pending job, possible pattern, cannot confirm yet
                                maybe = True

                elif (
                    len(oc_successes) == 1
                    and len(oc_pending) > 1
                    and oc_successes[0].started_at < oc_pending[-1].started_at
                ):
                    # If there is only one success and multiple pending jobs, we cannot confirm the sandwich
                    if any(
                        oc_successes[0].started_at
                        < e.started_at
                        < oc_pending[-1].started_at
                        and (e.is_failure or e.is_pending)
                        for e in nc.events
                    ):
                        maybe = True

        return None if maybe else False

    def has_loose_autorevert_pattern(self) -> bool:
        """
        Checks if there is subsequence of commits, where:
        - there are two commits with a failure (not necessarily consecutive)
        - there is at least one older commit with a success (not necessarily immediate predecessor)
        :return:
            True if such a pattern exists, False otherwise.
        """
        if len(self.commits) < 3:
            return False

        # Check for two newer commits with failure and one older commit with success
        found_failures = 0
        for c in self.commits:
            if c.events_by_status(SignalStatus.FAILURE):
                found_failures += 1
            elif c.events_by_status(SignalStatus.SUCCESS):
                if found_failures >= 2:
                    return True
                else:
                    # potentially recovered Signal + one flake, not enough confidence
                    return False

        return False

    def detect_autorevert_pattern(self) -> Optional[AutorevertPattern]:
        """
        Detect first autorevert pattern in the Signal.

        Pattern: 3 consecutive commits where:
        - 2 newer commits have failure
        - 1 older commit doesn't have this failure

        Note:
            in real world relies on the previously checked invariants, such as:
            no flakiness, no infra issues, etc.

        Returns:
            First detected autorevert pattern if exists, None otherwise.
        """
        # Commits are ordered newest -> older
        if len(self.commits) < 3:
            return None

        for i in range(1, len(self.commits) - 1):
            suspected_commit1 = self.commits[i]
            newer_commit = self.commits[i - 1]
            successful_base_commit = self.commits[i + 1]

            if (
                newer_commit.events_by_status(SignalStatus.FAILURE)
                and suspected_commit1.events_by_status(SignalStatus.FAILURE)
                and successful_base_commit.events_by_status(SignalStatus.SUCCESS)
            ):
                return AutorevertPattern(
                    pattern_detected=True,
                    workflow_name=self.workflow_name,
                    newer_commits=[
                        newer_commit.head_sha,
                        suspected_commit1.head_sha,
                    ],
                    older_commit=successful_base_commit.head_sha,
                )

        return None

    def process_valid_autorevert_pattern(
        self,
    ) -> Optional[Union[AutorevertPattern, RestartCommits]]:
        """
        Detect valid autorevert pattern in the Signal.

        Validates all invariants before checking for the pattern.

        Returns:
            AutorevertPattern if a valid pattern is detected, None if no pattern is detected,
            or RestartCommit if the pattern is not confirmed but a restart is needed.
        """
        if (
            self.detect_flaky()
            or self.detect_recovered()
            or not self.has_loose_autorevert_pattern()
        ):
            return None

        infra_failure = self.confirm_not_an_infra_issue()
        if infra_failure is None:
            # If we have pending jobs, we cannot confirm the pattern yet
            return None

        if not infra_failure:
            # not enough data to confirm the pattern, need to issue restarts
            # TODO find a commit to restart
            pass

        # TODO close the gaps in the signal (find commits to restart)

        return self.detect_autorevert_pattern()
