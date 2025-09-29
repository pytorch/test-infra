from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Callable, List, Optional, Set, Tuple, Union


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

    - newer_failing_commits: list of newer commits (after the suspected commit)
      that have failures for this signal (newest → older order).
    - suspected_commit: the oldest commit that first started to fail.
    - older_successful_commit: the most recent successful commit before
      failures started (direct parent of the suspected commit for this signal).
    """

    workflow_name: str
    newer_failing_commits: List[str]
    suspected_commit: str
    older_successful_commit: str


@dataclass
class RestartCommits:
    """
    Represents an intent to restart a specific set of commits on the signal.
    """

    commit_shas: Set[str]


class IneligibleReason(Enum):
    """Reasons why a signal is not eligible for an autorevert pattern right now."""

    FLAKY = "flaky"
    FIXED = "fixed"
    NO_SUCCESSES = "no_successes"
    NO_PARTITION = "no_partition"  # insufficient commit history to form partitions
    INFRA_NOT_CONFIRMED = "infra_not_confirmed"  # infra check not confirmed
    INSUFFICIENT_FAILURES = "insufficient_failures"  # not enough failures to make call
    INSUFFICIENT_SUCCESSES = (
        "insufficient_successes"  # not enough successes to make call
    )
    PENDING_GAP = "pending_gap"  # unknown/pending commits present


@dataclass
class Ineligible:
    reason: IneligibleReason
    message: str = ""


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
        wf_run_id: int,
        ended_at: Optional[datetime] = None,
    ):
        self.name = name
        self.status = status
        self.started_at = started_at
        self.ended_at = ended_at
        self.wf_run_id = wf_run_id

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

    def __init__(self, head_sha: str, timestamp: datetime, events: List[SignalEvent]):
        self.head_sha = head_sha
        self.timestamp = timestamp
        # enforce events ordered by time, then by wf_run_id (oldest first)
        self.events = (
            sorted(events, key=lambda e: (e.started_at, e.wf_run_id)) if events else []
        )
        # counts by status
        self.statuses = {}
        for e in self.events:
            self.statuses[e.status] = self.statuses.get(e.status, 0) + 1

    @property
    def has_pending(self) -> bool:
        return SignalStatus.PENDING in self.statuses

    @property
    def has_success(self) -> bool:
        return SignalStatus.SUCCESS in self.statuses

    @property
    def has_failure(self) -> bool:
        return SignalStatus.FAILURE in self.statuses

    def events_by_status(self, status: SignalStatus) -> List[SignalEvent]:
        """Get all events with the specified status."""
        return [event for event in self.events if event.status == status]

    # make iterable
    def __iter__(self):
        return iter(self.events)


def _bounds(
    commits: List["SignalCommit"], keep_predicate: Callable[[SignalEvent], bool]
) -> Tuple[Optional[datetime], Optional[datetime]]:
    """
    Compute (min_time, max_time) over events of commits satisfying predicate `keep`.
    """
    lo: Optional[datetime] = None
    hi: Optional[datetime] = None
    for c in commits:
        for e in c.events:
            if keep_predicate(e):
                t = e.started_at
                if lo is None or t < lo:
                    lo = t
                if hi is None or t > hi:
                    hi = t
    return lo, hi


@dataclass
class PartitionedCommits:
    """
    Represents the result of partitioning commits based on an autorevert pattern.
    """

    def __init__(
        self,
        failed: List[SignalCommit],
        unknown: List[SignalCommit],
        successful: List[SignalCommit],
    ):
        self.failed = failed
        self.unknown = unknown
        self.successful = successful

    def failure_events_count(self) -> int:
        return sum(c.statuses.get(SignalStatus.FAILURE, 0) for c in self.failed)

    def success_events_count(self) -> int:
        return sum(c.statuses.get(SignalStatus.SUCCESS, 0) for c in self.successful)

    def confirm_not_an_infra_issue(self) -> "InfraCheckResult":
        """
        Infra check based on this partition that classifies whether observed
        failures are likely infra or code-caused.

        Invariants established (priority: CONFIRMED > PENDING):
        - CONFIRMED: at least one failure (newer side) timestamp lies strictly
          between two actual success timestamps (older side).
        - PENDING: success-like and failure-like time ranges overlap, but no
          confirmed sandwich yet; pending events could complete the sandwich.
        - RESTART_SUCCESS: no success-like event occurs after any failure-like
          event (ranges do not overlap in that direction).
        - RESTART_FAILURE: no failure-like event occurs after any success-like
          event (ranges do not overlap in that direction).

        Notes:
        - success-like = SUCCESS or PENDING; failure-like = FAILURE or PENDING.
        - Only "failed" and "successful" partitions are considered; "unknown" is ignored.
        - Flakiness is assumed to be ruled out upstream.
        """

        # success-like includes pending; actual-success excludes pending
        min_succ_like, max_succ_like = _bounds(
            self.successful, lambda e: e.is_success or e.is_pending
        )
        min_succ, max_succ = _bounds(self.successful, lambda e: e.is_success)
        # failure-like includes pending
        min_fail_like, max_fail_like = _bounds(
            self.failed, lambda e: e.is_failure or e.is_pending
        )

        # Strict ordering without overlap → restart
        if min_succ_like is None or max_succ_like <= min_fail_like:
            return InfraCheckResult.RESTART_SUCCESS
        if min_fail_like is None or max_fail_like <= min_succ_like:
            return InfraCheckResult.RESTART_FAILURE

        # Confirmed: any actual failure falls strictly between two actual successes
        if min_succ is not None and max_succ is not None and min_succ < max_succ:
            for c in self.failed:
                for e in c.events:
                    if e.is_failure and (min_succ < e.started_at < max_succ):
                        return InfraCheckResult.CONFIRMED

        # Overlap exists, but not confirmed yet → pending
        return InfraCheckResult.PENDING


class InfraCheckResult(Enum):
    """Outcome of infra check based on partitioned commits."""

    CONFIRMED = "confirmed"  # failure bracketed by two successes (not infra)
    PENDING = "pending"  # pending events could still form the sandwich
    RESTART_SUCCESS = "restart_success"  # no success after any failure
    RESTART_FAILURE = "restart_failure"  # no failure after any success


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

    def detect_fixed(self) -> bool:
        """
        Find the first commit with any non‑pending event; if it contains a success, consider the signal recovered.
        """
        # find the first non-pending existing commit in the signal
        for commit in self.commits:
            # not all events are pending
            if commit.has_success or commit.has_failure:
                # If we found a commit that has resolved jobs, check if it has failed jobs
                return commit.has_success  # recovered
        return False

    def detect_flaky(self) -> bool:
        """
        Checks whether signal is flaky, i.e. has both successful and failed events for any commit.

        Notes:
         * false result can mean that there is not enough data to determine flakiness.
         * the definition of "flaky" here is somewhat broad, as it also includes intermittent infra issues.
            For the sake of simplicity we're leaning on the conservative side and discarding potentially
            intermittent outside issues as "flakiness".
         * while technically "flakiness" is not a property of the signal (it can be introduced or removed by changes),
            for simplicity we assume that flakiness stays constant within the limited time window we're considering,
            and we lean on the conservative side (discarding signal if we know it was flaky).
            that means that we will have some false negatives, but they will be very infrequent
            (need both conditions — recovery from flakiness + autorevert pattern within the same window)
        """
        return any(commit.has_success and commit.has_failure for commit in self.commits)

    def has_successes(self) -> bool:
        """
        Checks if there is at least one successful event in the signal.
        """
        return any(commit.has_success for commit in self.commits)

    def partition_by_autorevert_pattern(self) -> Optional[PartitionedCommits]:
        """
        Partition the most recent commit history into three lists:
        - Failed commits before the first potential breakage
        - Pending / missing signal commits in the middle (if any)
        - Successful commits after the breakage (up to the next breakage, if any)

        Preserves the original order of commits (newest to oldest).

        The useful invariant this establishes:
        - pending commits in the "failed" list are expected to resolve to failure
        - pending commits in the "successful" list are expected to resolve to success
        - pending commits in the "unknown" list could resolve either way
        - commits with the missing signal (that we need to trigger) would fall into the "unknown" list
        """
        if len(self.commits) < 2:
            return None

        failed = []
        successful = []

        picking_failed = True  # simple state machine

        # first broadly partition into failed and successful
        for c in self.commits:
            if c.has_success:
                picking_failed = False
            elif c.has_failure and not picking_failed:
                # encountered a failure after the streak of successes
                # this indicates another older pattern which we don't care about
                break

            if picking_failed:
                failed.append(c)
            else:
                successful.append(c)

        # further partition failed into failed and unknown (pending/missing)
        unknown = []
        while failed and not failed[-1].has_failure:
            unknown.append(failed.pop())

        unknown.reverse()

        if not failed or not successful:
            return None

        return PartitionedCommits(failed=failed, unknown=unknown, successful=successful)

    def process_valid_autorevert_pattern(
        self,
    ) -> Union[AutorevertPattern, RestartCommits, Ineligible]:
        """
        Detect valid autorevert pattern in the Signal.

        Validates all invariants before checking for the pattern.

        Returns one of:
            - AutorevertPattern: a confirmed pattern ready for action
            - RestartCommits: a suggested set of commits to restart to reduce uncertainty
            - Ineligible: reason + optional message when no pattern is actionable yet
        """
        if self.detect_flaky():
            return Ineligible(
                IneligibleReason.FLAKY,
                "signal is flaky (mixed outcomes on same commit)",
            )
        if self.detect_fixed():
            return Ineligible(
                IneligibleReason.FIXED, "signal appears recovered at head"
            )
        if not self.has_successes():
            return Ineligible(
                IneligibleReason.NO_SUCCESSES, "no successful commits present in window"
            )

        partition = self.partition_by_autorevert_pattern()
        if partition is None:
            return Ineligible(
                IneligibleReason.NO_PARTITION,
                "insufficient history to form failed/unknown/successful partitions",
            )

        restart_commits = set()

        # close gaps in the signal (greedily for now)
        for c in partition.unknown:
            if not c.events:
                restart_commits.add(c.head_sha)

        # infra check section

        infra_check_result = partition.confirm_not_an_infra_issue()
        if (
            infra_check_result == InfraCheckResult.RESTART_FAILURE
            and not partition.failed[-1].has_pending
        ):
            # restarting oldest failed
            restart_commits.add(partition.failed[-1].head_sha)

        if (
            infra_check_result == InfraCheckResult.RESTART_SUCCESS
            and not partition.successful[0].has_pending
        ):
            # restarting newest successful
            restart_commits.add(partition.successful[0].head_sha)

        # additional heuristics to reduce uncertainty / flakiness
        REQUIRE_FAILED_EVENTS = 3
        REQUIRE_SUCCESS_EVENTS = 2

        # this is a confidence heuristic to detect flakiness, can adjust the number of events as needed
        if (
            partition.failure_events_count() < REQUIRE_FAILED_EVENTS
            and not partition.failed[-1].has_pending
        ):
            restart_commits.add(partition.failed[-1].head_sha)

        if (
            partition.success_events_count() < REQUIRE_SUCCESS_EVENTS
            and not partition.successful[0].has_pending
        ):
            restart_commits.add(partition.successful[0].head_sha)

        if restart_commits:
            return RestartCommits(commit_shas=restart_commits)

        if infra_check_result != InfraCheckResult.CONFIRMED:
            return Ineligible(
                IneligibleReason.INFRA_NOT_CONFIRMED,
                f"infra check result: {infra_check_result.value}",
            )

        if partition.failure_events_count() < REQUIRE_FAILED_EVENTS:
            return Ineligible(
                IneligibleReason.INSUFFICIENT_FAILURES,
                f"not enough failures to make call: {partition.failure_events_count()}",
            )

        if partition.success_events_count() < REQUIRE_SUCCESS_EVENTS:
            return Ineligible(
                IneligibleReason.INSUFFICIENT_SUCCESSES,
                f"not enough successes to make call: {partition.success_events_count()}",
            )

        if partition.unknown:
            # there are still pending/missing commits in the unknown partition
            unknown_shas = ", ".join(c.head_sha for c in partition.unknown)
            return Ineligible(
                IneligibleReason.PENDING_GAP,
                f"pending/missing commits present: {unknown_shas}",
            )

        # all invariants validated, confirmed not infra, pattern exists
        # failed is newest -> older; the last element is the suspected commit
        suspected = partition.failed[-1]
        newer_failures = [c.head_sha for c in partition.failed[:-1]]
        return AutorevertPattern(
            workflow_name=self.workflow_name,
            newer_failing_commits=newer_failures,
            suspected_commit=suspected.head_sha,
            older_successful_commit=partition.successful[0].head_sha,
        )
