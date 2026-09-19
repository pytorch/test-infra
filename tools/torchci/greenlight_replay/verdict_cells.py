"""Turning one replayed ``RunResult`` into the four columns the replay adds.

This is the whole of what a run means in the output: the status, the reason
code, the prose, and a summary of it. Nothing here knows about files -- neither
the CSV nor the checkpoint -- so the rule below is stated once and everything
downstream inherits it.

**A run that produced no verdict is never four blank cells.** Blank already
means something in the export this file extends: ``decision`` is blank for a
pull request greenlight never reached a verdict on. A timed-out or
budget-tripped replay writing the same blank would read as a LAND the candidate
policy declined to repeat -- the most consequential row in the file,
manufactured by the harness rather than observed. So a run that reached no
verdict puts ``harness:<outcome>`` in ``new_decision_reason``, a prefix no
greenlight reason code carries, and spends ``new_decision_message`` on the
outcome, the error, and the run's cost, duration and turn count. Selecting the
failures is then a prefix match on one column, while ``new_decision`` itself
stays inside ``LAND``/``NO_LAND``/blank, so a comparison against ``decision`` is
never widened by a harness code.

A result claiming success while carrying no readable verdict is reported the
same way, as ``harness:unreadable``. It is a harness fault too, and the only
other option is the blank this module exists to avoid.

**The prefix means the harness, never the policy.** The test is whether the row
carries a verdict the policy produced, not whether the run ended tidily: the
policy's size gate firing is a decision, and so is a verdict recovered from a
budget-tripped run, so both keep their own reason code unprefixed and their own
prose in the summary. Getting this backwards is not cosmetic -- readers are told
to drop ``harness:`` rows before counting, and a size-gate decline is precisely
what a policy PR retuning the diff cap is meant to produce, so mislabelling it
deletes the finding. ``POLICY_VERDICT_OUTCOMES`` names the outcomes this covers
and says why ``SCHEMA_INVALID`` is not among them.

``RunResult`` is read by attribute rather than imported. Nothing here needs the
concrete type -- only the names it carries -- and staying off it is what lets the
tests drive this module with a stand-in instead of building a real run.
"""

from __future__ import annotations

from typing import Any

from torchci.greenlight_decisions.rows import first_sentence


NEW_COLUMNS: list[str] = [
    "new_decision",
    "new_decision_reason",
    "new_decision_summary",
    "new_decision_message",
]

# The verdict vocabulary. A status outside it is not written to new_decision at
# all, so no harness artefact can reach the column every comparison keys on.
DECISION_VALUES = frozenset({"LAND", "NO_LAND"})

OUTCOME_SUCCESS = "success"
OUTCOME_TOO_LARGE = "too_large"
OUTCOME_BUDGET_TRIP = "budget_trip"

# Covers both a result whose outcome cannot be read and one that claims success
# without a usable verdict: from here they are the same statement, that the
# harness and not the policy is why this row has no decision.
OUTCOME_UNREADABLE = "unreadable"

# The outcomes whose verdict is the policy's own answer rather than a payload
# nothing stood behind. TOO_LARGE is the canned size-gate decline, read out of
# the policy tree rather than off the model, and a BUDGET_TRIP carrying a status
# is a verdict recovered from the turn record: paid for and kept.
#
# SCHEMA_INVALID is absent deliberately. The policy's own schema rejected that
# payload, and the field it rejects is often ``reason``, against an enum the
# policy PR owns -- so publishing that code unprefixed would put a value that
# failed validation into the column readers aggregate. An outcome added later
# lands outside this set and reads as a harness fault until someone decides
# otherwise, which is the safe direction to be wrong in.
POLICY_VERDICT_OUTCOMES = frozenset(
    {OUTCOME_SUCCESS, OUTCOME_TOO_LARGE, OUTCOME_BUDGET_TRIP}
)

# No greenlight reason code contains a colon -- they are bare snake_case
# identifiers -- so this prefix cannot collide with a real one. It marks a
# harness fault and never a policy decision: a reader filtering it out is
# dropping runs that failed, not verdicts they disagree with.
HARNESS_REASON_PREFIX = "harness:"

# Rendered into the failure message so a reader can tell a budget trip from a
# timeout, and a cheap crash from an expensive one, without opening the run log.
_DIAGNOSTIC_FIELDS = (
    "outcome",
    "status",
    "reason",
    "cost_usd",
    "duration_s",
    "num_turns",
    "model",
    "context_window",
)


def as_text(value: Any) -> str:
    """Render a cell value, treating absence as blank rather than as ``"None"``."""
    return "" if value is None else str(value)


def replay_cells(result: Any) -> dict[str, str]:
    """The four new columns for one ``RunResult``.

    The only place a ``RunResult`` becomes cells. It is reached through
    ``checkpoint.append_checkpoint`` and nowhere else, so every row in the output
    is built from a recorded entry -- including the rows whose runs just finished
    -- and a resumed row and a fresh one are the same bytes because they are the
    same code.
    """
    failure = _failure_outcome(result)
    if failure:
        reason = HARNESS_REASON_PREFIX + failure
        message = _failure_message(failure, result)
    else:
        reason = as_text(getattr(result, "reason", "")).strip()
        message = _verdict_message(result)
    return {
        "new_decision": _verdict_status(result),
        "new_decision_reason": reason,
        "new_decision_summary": first_sentence(message),
        "new_decision_message": message,
    }


def _failure_outcome(result: Any) -> str:
    """The harness outcome to surface, or ``""`` when the policy itself answered.

    The question is whether this row carries a verdict the policy produced, not
    whether the run ended tidily. A size-gate decline and a recovered budget trip
    are both the policy speaking, and calling either a harness fault would throw
    away its reason code and hide the row from anyone following the documented
    advice to filter the prefix out -- which is exactly the row a policy PR
    retuning the diff cap exists to produce.
    """
    name = _outcome_name(result)
    if name in POLICY_VERDICT_OUTCOMES and _verdict_status(result):
        return ""
    if name == OUTCOME_SUCCESS:
        return OUTCOME_UNREADABLE
    return name or OUTCOME_UNREADABLE


def _outcome_name(result: Any) -> str:
    outcome = getattr(result, "outcome", None)
    name = getattr(outcome, "name", None)
    if name is None:
        name = "" if outcome is None else str(outcome)
    return str(name).strip().lower()


def _verdict_status(result: Any) -> str:
    status = as_text(getattr(result, "status", "")).strip()
    return status if status in DECISION_VALUES else ""


def _verdict_message(result: Any) -> str:
    """The policy's prose, with the run's diagnostics when it did not end tidily.

    A clean run's cell is the prose and nothing else, so what the policy wrote
    survives the file byte for byte. A size-gate decline or a recovered budget
    trip is equally the policy's answer, but the route it arrived by is part of
    the record, so the diagnostics follow the prose rather than displacing it --
    which also leaves the summary column reading as prose on every row that
    carries a verdict, however its run ended.
    """
    message = as_text(getattr(result, "message", ""))
    if _outcome_name(result) == OUTCOME_SUCCESS:
        return message
    return "\n".join(part for part in (message, _diagnostics(result)) if part.strip())


def _failure_message(failure: str, result: Any) -> str:
    """Prose whose first sentence names the outcome, over the run's diagnostics.

    The outcome sentence is terminated so that ``first_sentence`` -- the same
    helper the export summarises verdicts with -- yields the outcome alone, and
    the summary column stays scannable instead of holding a diagnostic dump.
    """
    detail = as_text(getattr(result, "error", "")).strip()
    lines = [f"harness {failure}." + (f" {detail}" if detail else "")]

    fields = _diagnostics(result)
    if fields:
        lines.append(fields)

    # A payload the schema rejected can still carry prose. It is not the policy's
    # answer -- nothing validated it -- but it is the only copy anyone will see,
    # and it costs a line to keep under the diagnostics that disown it.
    verdict = as_text(getattr(result, "message", "")).strip()
    if verdict:
        lines.append(verdict)
    return "\n".join(lines)


def _diagnostics(result: Any) -> str:
    values = {
        field: as_text(getattr(result, field, "")).strip()
        for field in _DIAGNOSTIC_FIELDS
    }
    values["outcome"] = _outcome_name(result)
    return " ".join(f"{field}={value}" for field, value in values.items() if value)
