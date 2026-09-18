"""Read one reviewer run's output envelope and say what actually happened.

Everything here is about not mistaking a failure for an answer. Three of the reviewer's
failure modes are invisible to the obvious checks -- exit code, ``is_error``, a non-empty
result string -- and each was found by a run that looked clean and was not. Measured on this
machine on 2026-09-18, Claude Code CLI 2.1.267, against the AI Gateway's Vertex upstream.

* A prompt whose opening characters look like a slash command is answered ``Unknown
  command: ...`` and exits **0**, with ``is_error`` false. The reviewer's skill is named
  ``greenlight-review``, so this is a live hazard rather than a hypothetical. It is
  recognised by its accounting -- zero turns, no ``modelUsage``, zero cost -- and never by
  matching that sentence, which would both miss a reworded one and misfire on a review that
  quotes it.
* A silent model downgrade is reported nowhere but ``modelUsage``. A bare alias resolves to
  a 200k context window with no warning and at full price, so the only symptom is a
  mysteriously worse verdict, which is indistinguishable from a worse policy. Both the model
  id and the ``contextWindow`` are asserted after every run.
* A budget trip bills the full grant and OMITS ``result`` and ``structured_output`` -- the
  keys are absent, not null -- even though the reviewer has usually already written its
  verdict. Discarding such a run throws away work that was paid for, so the turn record is
  walked backwards for it before giving up.

The ordering in ``classify`` is load-bearing: each check would be misread as success by the
one after it. An empty run has no ``modelUsage``, so it has to be recognised before the
model assertion, which would otherwise report it as a downgrade.

Both output shapes are accepted. ``--output-format json`` alone emits a single result
object; only ``--verbose`` emits the top-level array that carries the turn record, and
without that array a budget trip has nothing to recover from.
"""

from __future__ import annotations

import dataclasses
import enum
import json
import logging
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from torchci.greenlight_replay.verdict import (
    read_verdict,
    recover_verdict,
    schema_support_violation,
    verdict_fields,
    verdict_path,
    verdict_violation,
)


logger = logging.getLogger(__name__)

# ``verdict_violation`` under its former private name, for policy.py, which validates the
# canned too-large verdict against the same schema the reviewer's answers are held to.
_schema_violation = verdict_violation

__all__ = [
    "RETRYABLE",
    "Outcome",
    "RunResult",
    "classify",
    "merge_attempts",
    "read_verdict",
    "recover_verdict",
    "schema_support_violation",
    "verdict_fields",
    "verdict_path",
    "verdict_violation",
]

# GNU timeout reports 124 when it had to terminate the command, and the shell's 128+SIGKILL
# when the -k grace period elapsed too.
_TIMEOUT_EXIT_CODES = frozenset({124, 137})


class Outcome(enum.Enum):
    """How one reviewer invocation ended, in the caller's terms rather than the CLI's."""

    SUCCESS = "success"
    SCHEMA_INVALID = "schema_invalid"
    NO_VERDICT = "no_verdict"
    TIMEOUT = "timeout"
    BUDGET_TRIP = "budget_trip"
    API_ERROR = "api_error"
    EMPTY_RUN = "empty_run"
    TOO_LARGE = "too_large"


# Retrying is an estimator decision, not an error-handling one. CI draws ONE verdict per
# pull request; a harness that draws twice and keeps the last is last-of-two, which against
# this reviewer's measured 18.3% self-disagreement is a visibly different distribution from
# the one the tool exists to compare against. So a second draw is taken only where there is
# no answer to keep at all. SCHEMA_INVALID is deliberately NOT here: the model did answer,
# and re-rolling a verdict the harness merely disliked is exactly the biased second draw.
RETRYABLE = frozenset({Outcome.NO_VERDICT})


@dataclasses.dataclass(frozen=True)
class RunResult:
    """One pull request's replay outcome, including what it cost when it produced nothing.

    ``status`` is populated whenever a verdict was obtained, which includes a
    ``BUDGET_TRIP`` whose verdict was recovered from the turn record: a trip carrying a
    ``status`` is work that was paid for and kept, not a loss. ``cost_usd``, ``duration_s``
    and ``num_turns`` are summed across attempts, because a retried PR is billed twice.
    """

    outcome: Outcome
    status: str | None = None
    reason: str | None = None
    message: str | None = None
    cost_usd: float = 0.0
    duration_s: float = 0.0
    num_turns: int = 0
    model: str | None = None
    context_window: int | None = None
    error: str | None = None
    # True when this row is the second of two draws. A reader comparing against CI's single
    # draw needs to be able to exclude them; a silent retry is worse than a visible one.
    retried: bool = False


def merge_attempts(attempts: Sequence[RunResult]) -> RunResult:
    """The last attempt's verdict, carrying every attempt's cost."""
    final = attempts[-1]
    if len(attempts) == 1:
        return final
    return dataclasses.replace(
        final,
        cost_usd=sum(attempt.cost_usd for attempt in attempts),
        duration_s=sum(attempt.duration_s for attempt in attempts),
        num_turns=sum(attempt.num_turns for attempt in attempts),
        retried=True,
    )


def classify(
    exit_code: int,
    stdout: str,
    stderr: str,
    *,
    run_dir: Path,
    schema: Mapping[str, Any],
    model: str,
    context_window: int,
    duration_s: float,
) -> RunResult:
    """Turn one invocation's exit code and output into an outcome the caller can act on.

    Raises ``ValueError`` when ``schema`` uses constructs this module cannot interpret.
    That is a fault in the harness or in the policy's schema file, not in the reviewer's
    answer, and it would be identical on every pull request -- returning it as a retryable
    outcome would re-run and re-bill a whole sweep to reach the same refusal twice. Callers
    check it once with ``schema_support_violation`` before spending anything.
    """
    unsupported = schema_support_violation(schema)
    if unsupported is not None:
        raise ValueError(unsupported)
    if exit_code in _TIMEOUT_EXIT_CODES:
        return RunResult(
            outcome=Outcome.TIMEOUT,
            duration_s=duration_s,
            error=f"timeout killed the reviewer (exit {exit_code}): {stderr.strip()[-400:]}",
        )
    envelope = _decode(stdout)
    result = _result_element(envelope)
    if result is None:
        return RunResult(
            outcome=Outcome.API_ERROR,
            duration_s=duration_s,
            error=(
                f"no result element in the reviewer's output (exit {exit_code}): "
                f"{(stdout or stderr).strip()[:400]}"
            ),
        )

    reported_usage = result.get("modelUsage")
    usage: Mapping[str, Any] = (
        reported_usage if isinstance(reported_usage, dict) else {}
    )
    cost = _as_float(result.get("total_cost_usd"))
    turns = _as_int(result.get("num_turns"))
    base: dict[str, Any] = {
        "cost_usd": cost,
        "duration_s": duration_s,
        "num_turns": turns,
        "model": next(iter(usage), None),
        "context_window": _as_int(
            (next(iter(usage.values()), {}) or {}).get("contextWindow")
        )
        or None,
    }

    if turns == 0 and not usage and cost == 0.0:
        return RunResult(
            outcome=Outcome.EMPTY_RUN,
            error=f"the reviewer did nothing and was billed nothing: {result.get('result')!r}",
            **base,
        )
    violation = _model_violation(usage, model, context_window)
    if violation is not None:
        return RunResult(outcome=Outcome.API_ERROR, error=violation, **base)
    if "result" not in result and "structured_output" not in result:
        verdict = read_verdict(run_dir) or recover_verdict(envelope, run_dir)
        return RunResult(
            outcome=Outcome.BUDGET_TRIP,
            error="the reviewer's budget tripped; it was billed in full",
            **verdict_fields(verdict),
            **base,
        )
    if result.get("is_error") or result.get("api_error_status"):
        return RunResult(
            outcome=Outcome.API_ERROR,
            error=json.dumps(result.get("errors") or result.get("result"))[:400],
            **base,
        )

    verdict = read_verdict(run_dir) or recover_verdict(envelope, run_dir)
    if verdict is None:
        return RunResult(
            outcome=Outcome.NO_VERDICT,
            error=f"no verdict at {verdict_path(run_dir)} and none in the turn record",
            **base,
        )
    invalid = verdict_violation(schema, verdict)
    if invalid is not None:
        return RunResult(
            outcome=Outcome.SCHEMA_INVALID,
            error=invalid,
            **verdict_fields(verdict),
            **base,
        )
    return RunResult(outcome=Outcome.SUCCESS, **verdict_fields(verdict), **base)


def _decode(stdout: str) -> list[dict[str, Any]]:
    """Normalize both output shapes to a list. Only ``--verbose`` yields the turn record."""
    try:
        decoded = json.loads(stdout)
    except (json.JSONDecodeError, ValueError):
        return []
    if isinstance(decoded, dict):
        return [decoded]
    if isinstance(decoded, list):
        return [element for element in decoded if isinstance(element, dict)]
    return []


def _result_element(envelope: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    for element in reversed(list(envelope)):
        if element.get("type") == "result":
            return dict(element)
    return None


def _model_violation(
    usage: Mapping[str, Any], model: str, context_window: int
) -> str | None:
    if not usage:
        return "the reviewer reported no modelUsage, so the model that ran is unknown"
    names = sorted(usage)
    if names != [model]:
        return f"asked for {model!r} but modelUsage names {names}"
    reported = _as_int((usage.get(model) or {}).get("contextWindow"))
    if reported != context_window:
        return (
            f"{model!r} ran with a {reported} context window, expected {context_window}"
        )
    return None


def _as_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
