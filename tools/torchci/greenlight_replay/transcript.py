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

A verdict counts only as the live job would let it count. The session must have ended in
a ``success`` result that is not an error, as ``claude-code-action`` requires before the
step passes; the instruction-loading detector must pass after any session that started;
and the verdict file must pass the record path's own checks, which the caller supplies as
``accept``. A verdict recovered from the turn record, or a file left by a failed session,
is kept on the result as a diagnostic and never becomes the policy's verdict.

Both output shapes are accepted. ``--output-format json`` alone emits a single result
object; only ``--verbose`` emits the top-level array that carries the turn record, and
without that array a budget trip has nothing to recover from.
"""

from __future__ import annotations

import dataclasses
import enum
import json
import logging
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, TYPE_CHECKING

from torchci.greenlight_replay.verdict import (
    read_verdict,
    recover_verdict,
    verdict_fields,
    verdict_path,
)


if TYPE_CHECKING:
    from torchci.greenlight_replay.detector import DetectorFailure


logger = logging.getLogger(__name__)

__all__ = [
    "RETRYABLE",
    "Acceptor",
    "Detector",
    "Outcome",
    "RunResult",
    "classify",
    "merge_attempts",
    "read_verdict",
    "recover_verdict",
    "session_started",
    "verdict_fields",
    "verdict_path",
]

# The record path's checks on a verdict file: the processed verdict, or why it is refused.
Acceptor = Callable[[Path], "tuple[dict[str, str] | None, str | None]"]
# The detector, run after a session that started: a DetectorFailure, or None.
Detector = Callable[[], "DetectorFailure | None"]

# GNU timeout reports 124 when it had to terminate the command, and the shell's 128+SIGKILL
# when the -k grace period elapsed too.
_TIMEOUT_EXIT_CODES = frozenset({124, 137})

_SUCCESS_SUBTYPE = "success"


class Outcome(enum.Enum):
    """How one reviewer invocation ended, in the caller's terms rather than the CLI's."""

    SUCCESS = "success"
    REJECTED = "rejected"
    NO_VERDICT = "no_verdict"
    TIMEOUT = "timeout"
    BUDGET_TRIP = "budget_trip"
    API_ERROR = "api_error"
    EMPTY_RUN = "empty_run"
    ARM_CHECK_FAILED = "arm_check_failed"
    HOOKS_NOT_LOADED = "hooks_not_loaded"
    UNTRUSTED_INSTRUCTIONS = "untrusted_instructions"
    TOO_LARGE = "too_large"


# Retrying is an estimator decision, not an error-handling one. CI draws ONE verdict per
# pull request; a harness that draws twice and keeps the last is last-of-two, which against
# this reviewer's measured 18.3% self-disagreement is a visibly different distribution from
# the one the tool exists to compare against. So a second draw is taken only where there is
# no answer to keep at all; CI records such a run FAILED, which greenlight's scan
# re-dispatches. REJECTED is deliberately NOT here: the model did answer, and re-rolling a
# verdict the record path refused is exactly the biased second draw.
RETRYABLE = frozenset({Outcome.NO_VERDICT})


@dataclasses.dataclass(frozen=True)
class RunResult:
    """One pull request's replay outcome, including what it cost when it produced nothing.

    ``status``, ``reason`` and ``message`` are the policy's verdict under ``SUCCESS`` and
    the canned outcomes. Under any other outcome they are diagnostics: whatever the
    session left in its verdict file or its turn record, which the live job would not
    have recorded. ``cost_usd``, ``duration_s`` and ``num_turns`` are summed across
    attempts, because a retried PR is billed twice.
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
    model: str,
    context_window: int,
    duration_s: float,
    detect: Detector,
    accept: Acceptor,
) -> RunResult:
    """Turn one invocation's exit code and output into an outcome the caller can act on.

    ``detect`` runs once the session is known to have started, or would otherwise be
    accepted, as the live job runs its detector whenever the model ran; a failure there
    is the outcome whatever else the session did: ``HOOKS_NOT_LOADED`` when the hooks
    left no sentinel, ``UNTRUSTED_INSTRUCTIONS`` when they ran and an instruction file
    loaded from the checkout. Any other session with no sign of having started keeps
    its own outcome. ``accept`` runs only on a verdict file a successful session left.

    Either call raising -- the policy's code past its timeout, an interpreter missing,
    output that is not what it should be -- is ``ARM_CHECK_FAILED``, carrying what the
    session cost, so a paid run is still recorded rather than lost with the exception.
    """
    if exit_code in _TIMEOUT_EXIT_CODES:
        return RunResult(
            outcome=Outcome.TIMEOUT,
            duration_s=duration_s,
            error=f"timeout killed the reviewer (exit {exit_code}): {stderr.strip()[-400:]}",
        )
    envelope = _decode(stdout)
    session = _session_outcome(
        envelope, exit_code, stdout, stderr, run_dir, model, context_window, duration_s
    )
    if session_started(envelope) or session.outcome is Outcome.SUCCESS:
        try:
            failure = detect()
        except Exception as exc:
            return _arm_check_failed(session, "the detector", exc)
        if failure is not None:
            return dataclasses.replace(
                session,
                outcome=Outcome.UNTRUSTED_INSTRUCTIONS
                if failure.hooks_ran
                else Outcome.HOOKS_NOT_LOADED,
                error=failure.message,
            )
    if session.outcome is not Outcome.SUCCESS:
        return session
    try:
        verdict, rejection = accept(verdict_path(run_dir))
    except Exception as exc:
        return _arm_check_failed(session, "the record checks", exc)
    if verdict is None:
        return dataclasses.replace(session, outcome=Outcome.REJECTED, error=rejection)
    return dataclasses.replace(session, **verdict_fields(verdict))


def _arm_check_failed(session: RunResult, check: str, exc: Exception) -> RunResult:
    logger.error("%s could not run: %s", check, exc, exc_info=True)
    return dataclasses.replace(
        session,
        outcome=Outcome.ARM_CHECK_FAILED,
        error=f"{check} could not run: {type(exc).__name__}: {exc}"[:400],
    )


def session_started(envelope: Sequence[Mapping[str, Any]]) -> bool:
    """Whether the turn record opens a session: a ``system`` element of subtype ``init``."""
    return any(
        element.get("type") == "system" and element.get("subtype") == "init"
        for element in envelope
    )


def _session_outcome(
    envelope: list[dict[str, Any]],
    exit_code: int,
    stdout: str,
    stderr: str,
    run_dir: Path,
    model: str,
    context_window: int,
    duration_s: float,
) -> RunResult:
    """How the session ended, before the detector and the record path's checks.

    ``SUCCESS`` here means only that the session succeeded and left a verdict file.
    """
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
    left = verdict_fields(read_verdict(run_dir) or recover_verdict(envelope, run_dir))
    if "result" not in result and "structured_output" not in result:
        return RunResult(
            outcome=Outcome.BUDGET_TRIP,
            error="the reviewer's budget tripped; it was billed in full",
            **left,
            **base,
        )
    if (
        result.get("is_error")
        or result.get("api_error_status")
        or result.get("subtype") != _SUCCESS_SUBTYPE
    ):
        return RunResult(
            outcome=Outcome.API_ERROR,
            error=(
                f"the session ended {result.get('subtype')!r}: "
                + json.dumps(result.get("errors") or result.get("result"))[:400]
            ),
            **left,
            **base,
        )
    if not verdict_path(run_dir).is_file():
        return RunResult(
            outcome=Outcome.NO_VERDICT,
            error=f"no verdict at {verdict_path(run_dir)}",
            **left,
            **base,
        )
    return RunResult(outcome=Outcome.SUCCESS, **left, **base)


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
