"""Whether GreenLight's ledger backs a live GreenLight approval on a ``gate`` repo (``approval_backing``).

``judge`` applies the rules in order; ``read_newest_version`` reads the ledger's newest row version, which
tells an approval whose LAND row may still be on its way from one the ledger has moved past.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, NamedTuple

from greenlight import clickhouse_client, state
from greenlight.constants import (
    BACKING_WAIT_MAX,
    IN_FLIGHT_STATUSES,
    LEDGER_MARGIN,
    STATUS_CANCELLED,
    STATUS_FAILED,
    STATUS_LAND,
    STATUS_NO_LAND,
    STATUS_REVERTED,
    TARGET_BRANCH,
)

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    from clickhouse_connect.driver.client import Client

    from greenlight.approvals import ReviewRecord
    from greenlight.gate_rules import GateRules
    from greenlight.state import PRState

_LEDGER_NEWEST_QUERY = "SELECT maxOrNull(version) AS newest FROM misc.greenlight_pr_state"
_UNBACKING_STATUSES = frozenset({STATUS_NO_LAND, STATUS_REVERTED, STATUS_CANCELLED, STATUS_FAILED})


class Judgement(NamedTuple):
    state: Literal["backed", "waiting", "unbacked"]
    reason: str = ""


BACKED = Judgement("backed")
WAITING = Judgement("waiting")


def read_newest_version(*, connect: Callable[[], Client] = clickhouse_client.connect) -> datetime | None:
    """The ledger's newest row version over every repo, as naive UTC; None when it holds no row."""
    rows = clickhouse_client.query(_LEDGER_NEWEST_QUERY, {}, connect=connect)
    newest = rows[0]["newest"] if rows else None
    return None if newest is None else state.naive_utc(newest)


def judge(
    approval: ReviewRecord,
    *,
    repo: str,
    head: str,
    base: str,
    gate: PRState | None,
    rules: GateRules | None,
    ledger_newest: datetime | None,
    now: datetime,
) -> Judgement:
    """Whether GreenLight's live ``approval`` is backed, waiting or unbacked; the first rule that applies decides.

    1. ``rules`` say GreenLight's gate is not enforced (None, unknown, skips this rule): unbacked.
    2. It was given on a commit other than ``head``: unbacked.
    3. The base is not ``TARGET_BRANCH``: unbacked.
    4. ``gate``, the PR's latest non-shadow row, is a LAND on ``head``: backed.
    5. ``gate`` is a NO_LAND, REVERTED, CANCELLED or FAILED row: unbacked.
    6. ``gate`` is newer than the approval: unbacked.
    7. ``gate`` is absent, in flight or a LAND on another head, the ledger's newest row (naive UTC, as ``now``)
       is not ``LEDGER_MARGIN`` past the approval, and the approval is younger than ``BACKING_WAIT_MAX``:
       waiting, since its LAND row may not be ingested yet.
    8. Otherwise: unbacked.
    """
    if rules is not None and not rules.enforced:
        return Judgement("unbacked", f"GreenLight's gate is not enforced on {repo}: {'; '.join(rules.problems)}")
    if (approval.commit_id or "").lower() != head.lower():
        given = approval.commit_id or "an unknown commit"
        return Judgement("unbacked", f"it was given on {given}, not on the head {head}")
    if base != TARGET_BRANCH:
        return Judgement("unbacked", f"the base is {base}, not {TARGET_BRANCH}")
    if gate is not None and gate.status == STATUS_LAND and gate.head_sha.lower() == head.lower():
        return BACKED
    if gate is not None and gate.status in _UNBACKING_STATUSES:
        return Judgement("unbacked", f"GreenLight's latest verdict row for the head is {gate.status}")
    submitted = None if approval.submitted_at is None else state.naive_utc(approval.submitted_at)
    if gate is not None and submitted is not None and gate.version > submitted:
        return Judgement("unbacked", f"a newer {gate.status} row")
    unsettled = gate is None or gate.status in IN_FLIGHT_STATUSES or gate.status == STATUS_LAND
    if (
        unsettled
        and submitted is not None
        and (ledger_newest is None or ledger_newest < submitted + LEDGER_MARGIN)
        and now - submitted < BACKING_WAIT_MAX
    ):
        return WAITING
    return Judgement("unbacked", "no LAND row backs it on the head")
