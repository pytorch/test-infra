"""The refit's gate (a twin of the new model's time budget against TD's cut and the live
model), the live model's drift, and the daily staleness check. Stdlib only: `check` runs
without numpy."""

from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Union

from torchci.td.scorer import model_json


GATE_DAYS = 28
MIN_LIVE_PR_EVENTS = 100
CALIBRATION_BAND = (0.5, 2.0)
STALE_DAYS = 9
OK, DISABLED, STALE, UNREADABLE, INVALID = (
    "ok",
    "disabled",
    "stale",
    "unreadable",
    "invalid",
)
FAIL = "FAIL: "
NOTE = "note: "


def _interval(b: dict[str, Any]) -> str:
    return (
        f"{b['diff']:+.3f} [{b['lo']:+.3f}, {b['hi']:+.3f}] over {b['events']} events"
    )


def gate(
    budget: dict[str, Any],
    twin_vs_live: Optional[dict[str, Any]],
    calibration: Optional[dict[str, Any]],
) -> tuple[bool, list[str]]:
    """(passed, reasons): failures start with FAIL, the rest are notes.

    - budget: the twin's time budget against TD's cut on the last GATE_DAYS settled
      days: "risk" (whether the twin has a risk score), "base" (the base the search
      chose, None when none up to "max_base" keeps PR recall within "max_loss" of TD's),
      "known_pr_events" (PR events with test times) and "bootstrap" (paired_bootstrap
      of the budget's minus TD's PR recall at that base, else at "max_base"; None
      without PR events). Fails without a risk score, without PR events, with fewer
      than MIN_LIVE_PR_EVENTS known ones, or without a base.
    - twin_vs_live: the same against the live model on the units after its data, with
      "pr_events"; None without a live model; skipped below MIN_LIVE_PR_EVENTS PR events.
    - calibration: calibration.calibration of the twin; fails outside CALIBRATION_BAND,
      skipped when None (too few positives).
    """
    reasons = []
    boot, known = budget["bootstrap"], budget["known_pr_events"]
    if not budget["risk"]:
        reasons.append(FAIL + "the twin has no risk score, so no time budget")
    elif boot is None:
        reasons.append(FAIL + "no PR failure events to compare the model with TD on")
    elif known < MIN_LIVE_PR_EVENTS:
        reasons.append(
            FAIL
            + "too few PR failures with test times to choose a base"
            + f" ({known} < {MIN_LIVE_PR_EVENTS})"
        )
    elif budget["base"] is None:
        reasons.append(
            FAIL
            + f"no base up to {budget['max_base']:.0%} keeps PR recall within"
            + f" {budget['max_loss'] * 100:g} point of TD's cut: "
            + _interval(boot)
        )
    else:
        reasons.append(
            NOTE
            + f"base {budget['base']:.0%}: model vs TD on PR failures: "
            + _interval(boot)
        )
    if twin_vs_live is None:
        reasons.append(NOTE + "no live model to compare with")
    elif twin_vs_live.get("pr_events", 0) < MIN_LIVE_PR_EVENTS:
        reasons.append(
            NOTE
            + f"live comparison skipped: {twin_vs_live.get('pr_events', 0)} PR events"
            + f" after the live model's data (needs {MIN_LIVE_PR_EVENTS})"
        )
    elif twin_vs_live["hi"] < 0:
        reasons.append(FAIL + "model below the live model: " + _interval(twin_vs_live))
    else:
        reasons.append(NOTE + "model vs live: " + _interval(twin_vs_live))
    reasons.extend(_calibration("model", calibration, FAIL))
    return not any(r.startswith(FAIL) for r in reasons), reasons


def _calibration(
    who: str, calibration: Optional[dict[str, Any]], prefix: str
) -> list[str]:
    if calibration is None:
        return [NOTE + f"{who} calibration skipped: too few positives"]
    lo, hi = CALIBRATION_BAND
    ratio = calibration["ratio"]
    if not lo <= ratio <= hi:
        return [prefix + f"{who} calibration ratio {ratio:.2f} outside [{lo}, {hi}]"]
    return [NOTE + f"{who} calibration ratio {ratio:.2f}"]


def drift(live_calibration: Optional[dict[str, Any]]) -> list[str]:
    """Notes on the live model's calibration (reported, never a failure)."""
    return _calibration("live model", live_calibration, NOTE + "drift: ")


def parse_time(value: Any) -> datetime:
    """An ISO time ("...Z" or with an offset) as an aware UTC datetime."""
    if not isinstance(value, str):
        raise ValueError(f"not a time: {value!r}")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def staleness(
    doc_or_error: Union[dict[str, Any], BaseException, str], now: datetime
) -> tuple[str, list[str]]:
    """(status, reasons) of the published model: OK, DISABLED (switched off: not a
    failure), STALE (trained more than STALE_DAYS ago), UNREADABLE or INVALID."""
    if not isinstance(doc_or_error, dict):
        return UNREADABLE, [str(doc_or_error)]
    try:
        risk_problem = model_json.validate(doc_or_error)
    except model_json.ModelDisabled:
        return DISABLED, ["the model is disabled (enabled: false)"]
    except model_json.InvalidModel as e:
        return INVALID, [str(e)]
    try:
        trained_at = parse_time(doc_or_error.get("trained_at"))
    except ValueError as e:
        return INVALID, [f"trained_at: {e}"]
    age = now - trained_at
    reasons = [f"trained at {trained_at.isoformat()}, {age.days} days ago"]
    if risk_problem:
        reasons.append(f"risk score disabled: {risk_problem}")
    if age > timedelta(days=STALE_DAYS):
        return STALE, reasons
    return OK, reasons
