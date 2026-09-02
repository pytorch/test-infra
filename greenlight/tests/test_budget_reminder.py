"""Spec tests for the review time-budget reminder hook.

The reminder is a standalone shell script outside the greenlight package, so it is exercised as a
subprocess (invoked via bash, the way Claude Code runs a PostToolUse hook) rather than imported.

Every case passes an explicit ``env`` instead of inheriting one: the hook is driven entirely by
environment variables, and a stray ``RUNNER_TEMP`` or deadline in the developer's own shell would
otherwise steer it. The hook reads the wall clock itself, so a scenario is expressed as "how long
ago did the review start" and the deadlines are derived from that; offsets stay a comfortable
distance from every boundary so a clock tick between building the env and the hook's own ``date``
cannot flip an assertion. The cases that must land *on* a boundary go through
``_run_within_one_second``, which pins the whole run to a single second instead.

The budgets come from the workflow rather than from constants here, so changing a budget there
cannot leave this file testing tiers production no longer has.
"""

import json
import os
import re
import shutil
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = ROOT / ".claude" / "hooks" / "greenlight" / "budget-reminder.sh"
_STOP_HOOK = ROOT / ".claude" / "hooks" / "greenlight" / "validate-on-stop.sh"
_SKILL = ROOT / ".claude" / "skills" / "greenlight-review" / "SKILL.md"
_WORKFLOW = ROOT / ".github" / "workflows" / "greenlight-pr-review.yml"
_README = ROOT / "greenlight" / "README.md"
_BASH = shutil.which("bash") or "bash"

# The skill section the final tier defers to instead of restating what "critical" means.
_CRITERIA_SECTION = "What to inspect"
# The final tier's rule quantifies over the criteria, not over the questions the model happened to
# form: a criterion it never looked at raises no question, and without this clause such a review
# reads the rule as LAND. The hook and the skill state the rule to the same reader, tens of minutes
# apart, and there is no figure to compare between them -- the words are the artifact -- so the
# clause is pinned verbatim in both.
_UNEXAMINED_CRITERION_CLAUSE = "and a criterion there you never examined counts as one"
# The skill section that states the budget in prose. Most reviews finish inside the tier-1
# suppression floor and never receive a reminder, so those figures are their only time guidance.
_BUDGET_SECTION = "Time budget"
# The README subsection that restates the same budget for a human reader.
_README_BUDGET_SECTION = "Review time budget"

_MODEL_ACTION = "anthropics/claude-code-action@"
# Whole minutes that must remain between the last budget and the model step's timeout. Past the
# hard deadline the agent is still writing its verdict, and a timed-out step leaves it no turns at
# all -- so the gap has to cover several of them, not merely be positive.
_VERDICT_HEADROOM_MIN = 3
# Seconds. The reminder is pinned well under a tool call because the CLI's own default is measured
# in minutes and this hook runs after every one of them; a hung reminder spends the very budget it
# exists to protect.
_HOOK_TIMEOUT_CEILING_SEC = 10

_STATE_NAME = "greenlight-budget-reminder-last"
_VERDICT_NAME = "greenlight-verdict.json"
_INJECTION_MARKER = "arithmetic-injection-fired"
_JQ_STUB_DIAGNOSTIC = "jq: error: out of memory"

_EPOCH_VARS = (
    "GREENLIGHT_REVIEW_START_EPOCH",
    "GREENLIGHT_REVIEW_TARGET_DEADLINE",
    "GREENLIGHT_REVIEW_SOFT_DEADLINE",
    "GREENLIGHT_REVIEW_HARD_DEADLINE",
)
_NON_NUMERIC = ["", " ", "abc", "12.5", "-60", "1e3", "1 700", "60s"]

_REMINDER_INTERVAL_SEC = 180
_URGENT_INTERVAL_SEC = 60
# (env var, its default, a tier that uses it)
_INTERVAL_CASES = [
    ("GREENLIGHT_REVIEW_REMINDER_INTERVAL_SEC", _REMINDER_INTERVAL_SEC, 1),
    ("GREENLIGHT_REVIEW_URGENT_INTERVAL_SEC", _URGENT_INTERVAL_SEC, 4),
]
_INTERVAL_IDS = ["reminder", "urgent"]

_TIERS = [1, 2, 3, 4]
_BOUNDARY_ATTEMPTS = 10


def _review_job() -> dict[str, Any]:
    workflow: dict[str, Any] = yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))
    job: dict[str, Any] = workflow["jobs"]["review"]
    return job


_BUDGET_VARS = {
    "target": "GREENLIGHT_REVIEW_TARGET_BUDGET_MIN",
    "soft": "GREENLIGHT_REVIEW_SOFT_BUDGET_MIN",
    "hard": "GREENLIGHT_REVIEW_HARD_BUDGET_MIN",
}

# The budget each of the skill's four reminder stages quotes, in the hook's tier order. Tiers 1 and
# 2 sit either side of the target deadline and both name it.
_SKILL_STAGE_BUDGETS = ("target", "target", "soft", "hard")


def _budget_seconds() -> dict[str, int]:
    """The three review budgets the workflow configures, in seconds."""
    job_env = _review_job().get("env", {})
    missing = [name for name in _BUDGET_VARS.values() if name not in job_env]
    assert not missing, (
        f"{_WORKFLOW.name} sets no {missing}; the hook's tiers have no budget to derive from. "
        "Every tier boundary below is expressed in terms of these three values."
    )
    seconds = {key: int(job_env[name]) * 60 for key, name in _BUDGET_VARS.items()}
    assert seconds["target"] <= seconds["soft"] <= seconds["hard"], (
        f"budgets are not ordered target <= soft <= hard: {seconds}"
    )
    return seconds


_BUDGET_SEC = _budget_seconds()
_TARGET_BUDGET_SEC = _BUDGET_SEC["target"]
_SOFT_BUDGET_SEC = _BUDGET_SEC["soft"]
_HARD_BUDGET_SEC = _BUDGET_SEC["hard"]
_TARGET_BUDGET_MIN = _TARGET_BUDGET_SEC // 60
_TIER_ONE_FLOOR_SEC = _TARGET_BUDGET_SEC // 2

# Offsets that put a run squarely inside each tier, clear of every boundary: seconds still
# remaining before the tier's own deadline for tiers 1-3, elapsed seconds for the final tier.
_TIER_REMAINING = {1: 450, 2: 630, 3: 450}
_TIER_FOUR_ELAPSED = _HARD_BUDGET_SEC + 30


def _env_from_start(
    tmp_path: Path,
    *,
    start: int,
    target_budget: int = _TARGET_BUDGET_SEC,
    soft_budget: int = _SOFT_BUDGET_SEC,
    hard_budget: int = _HARD_BUDGET_SEC,
) -> dict[str, str]:
    """Environment for a review that started at epoch ``start``."""
    return {
        "PATH": os.environ["PATH"],
        "RUNNER_TEMP": str(tmp_path),
        # Redirected off the fixed /tmp path so a leftover verdict on the developer's machine
        # cannot decide which of the two final-tier messages a case sees.
        "GREENLIGHT_REVIEW_VERDICT_FILE": str(tmp_path / _VERDICT_NAME),
        "GREENLIGHT_REVIEW_START_EPOCH": str(start),
        "GREENLIGHT_REVIEW_TARGET_DEADLINE": str(start + target_budget),
        "GREENLIGHT_REVIEW_SOFT_DEADLINE": str(start + soft_budget),
        "GREENLIGHT_REVIEW_HARD_DEADLINE": str(start + hard_budget),
    }


def _env(tmp_path: Path, *, elapsed: int, **budgets: int) -> dict[str, str]:
    """Environment for a review that started ``elapsed`` seconds ago."""
    return _env_from_start(tmp_path, start=int(time.time()) - elapsed, **budgets)


def _expected_minutes(remaining: int) -> int:
    """Whole minutes the hook reports for ``remaining`` seconds left, truncating the way it does."""
    assert remaining % 60 >= 5, f"{remaining}s sits too close to a minute boundary for a clock tick to be harmless"
    return remaining // 60


def _tier_one_env(tmp_path: Path, *, remaining: int) -> dict[str, str]:
    """Tier 1, past the suppression floor, with ``remaining`` seconds before the target deadline."""
    assert 0 < remaining <= _TIER_ONE_FLOOR_SEC, "tier 1 fires only in the second half of the target window"
    return _env(tmp_path, elapsed=_TARGET_BUDGET_SEC - remaining)


def _tier_two_env(tmp_path: Path, *, remaining: int) -> dict[str, str]:
    """Tier 2 (target reached, soft deadline not) with ``remaining`` seconds before the hard deadline."""
    elapsed = _HARD_BUDGET_SEC - remaining
    assert _TARGET_BUDGET_SEC <= elapsed < _SOFT_BUDGET_SEC, "tier 2 spans the target-to-soft window only"
    return _env(tmp_path, elapsed=elapsed)


def _tier_three_env(tmp_path: Path, *, remaining: int) -> dict[str, str]:
    """Tier 3 (soft deadline reached, hard deadline not) with ``remaining`` seconds before the hard deadline."""
    elapsed = _HARD_BUDGET_SEC - remaining
    assert _SOFT_BUDGET_SEC <= elapsed < _HARD_BUDGET_SEC, "tier 3 spans the soft-to-hard window only"
    return _env(tmp_path, elapsed=elapsed)


def _tier_four_env(tmp_path: Path) -> dict[str, str]:
    return _env(tmp_path, elapsed=_TIER_FOUR_ELAPSED)


def _env_for_tier(tmp_path: Path, tier: int) -> dict[str, str]:
    """A representative environment for ``tier``, clear of every boundary."""
    if tier == 4:
        return _tier_four_env(tmp_path)
    builder = {1: _tier_one_env, 2: _tier_two_env, 3: _tier_three_env}[tier]
    return builder(tmp_path, remaining=_TIER_REMAINING[tier])


def _elapsed_for_tier(tier: int) -> int:
    """Seconds since the review started that ``_env_for_tier`` expresses."""
    if tier == 4:
        return _TIER_FOUR_ELAPSED
    deadline = _TARGET_BUDGET_SEC if tier == 1 else _HARD_BUDGET_SEC
    return deadline - _TIER_REMAINING[tier]


def _interval_for_tier(tier: int) -> int:
    return _URGENT_INTERVAL_SEC if tier == 4 else _REMINDER_INTERVAL_SEC


def _run(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    assert _SCRIPT.is_file(), f"budget reminder hook not found at {_SCRIPT}"
    return subprocess.run(  # noqa: S603
        [_BASH, str(_SCRIPT)],
        capture_output=True,
        text=True,
        check=False,
        env=env,
        stdin=subprocess.DEVNULL,
    )


def _run_within_one_second(setup: Callable[[int], dict[str, str]]) -> subprocess.CompletedProcess[str]:
    """Run the hook with every timestamp pinned to the same second its own ``date`` reads.

    The tier and rate-limit comparisons are ``>=`` / ``<``, so proving the boundary itself needs the
    hook to observe the deadline exactly; a second ticking mid-run lands one past it, where a
    strict-comparison mutant behaves identically. A result is kept only if the whole run stayed
    inside the second it was aligned to.
    """
    for _ in range(_BOUNDARY_ATTEMPTS):
        time.sleep(1.0 - (time.time() % 1.0) + 0.05)
        second = int(time.time())
        result = _run(setup(second))
        if int(time.time()) == second:
            return result
    pytest.fail(f"could not keep a hook run inside a single second after {_BOUNDARY_ATTEMPTS} attempts")


def _context(result: subprocess.CompletedProcess[str]) -> str:
    """The additionalContext of a well-formed single-line hook emission."""
    assert result.returncode == 0, result.stderr
    # Emitting is not a licence to complain: a run that nudges the model while also writing to
    # stderr still reaches the operator as a non-blocking hook error, once per tool call. Several
    # of the hook's guards fail this way rather than by changing what is emitted, so the check
    # belongs on every path and not only on the silent ones.
    assert result.stderr == ""
    assert result.stdout.count("\n") == 1, result.stdout
    payload = json.loads(result.stdout)
    assert list(payload) == ["hookSpecificOutput"]
    inner = payload["hookSpecificOutput"]
    assert sorted(inner) == ["additionalContext", "hookEventName"]
    assert inner["hookEventName"] == "PostToolUse"
    return str(inner["additionalContext"])


def _assert_silent(result: subprocess.CompletedProcess[str]) -> None:
    assert result.returncode == 0, result.stderr
    assert result.stdout == ""
    assert result.stderr == ""


def _write_state(tmp_path: Path, contents: str) -> Path:
    state = tmp_path / _STATE_NAME
    state.write_text(contents, encoding="utf-8")
    return state


def _seed_state(tmp_path: Path, *, seconds_ago: int, tier: int) -> Path:
    return _write_state(tmp_path, f"{int(time.time()) - seconds_ago} {tier}")


def _tier_one_message(minutes: int, *, budget_min: int = _TARGET_BUDGET_MIN) -> str:
    return (
        f"Time check: about {minutes} minute(s) remain of the {budget_min}-minute standard review target. "
        "The diff is the primary source; checkout reads are lookups for specific questions rather than exploration."
    )


def _tier_two_message(minutes: int, *, budget_min: int = _TARGET_BUDGET_MIN) -> str:
    return (
        f"Time check: this review is past its {budget_min}-minute standard target, with about {minutes} minute(s) "
        "before the hard limit. Unless this change is genuinely complex, the remaining work is writing the verdict."
    )


def _tier_three_message(minutes: int) -> str:
    return (
        f"Time check: about {minutes} minute(s) remain before the hard limit. Remaining time is for questions "
        "critical to the LAND/NO_LAND decision only."
    )


def _tier_four_message(tmp_path: Path) -> str:
    return (
        f"Time check: the review time is spent and the verdict is due now at {tmp_path / _VERDICT_NAME}. The rule "
        f"at this point: a still-unanswered question that is critical under the skill's {_CRITERIA_SECTION} "
        f"criteria means NO_LAND, {_UNEXAMINED_CRITERION_CLAUSE}; only minor nits, esoteric questions, or "
        "non-critical edge cases left unanswered means LAND."
    )


_TIER_FOUR_VERDICT_WRITTEN_MESSAGE = (
    "Time check: the review time is spent and the verdict file is already written. "
    "No further investigation is expected."
)


def _message_for_tier(tmp_path: Path, tier: int) -> str:
    """The message ``_env_for_tier`` produces, for cases that only care that the tier fired."""
    if tier == 4:
        return _tier_four_message(tmp_path)
    builder: dict[int, Callable[[int], str]] = {1: _tier_one_message, 2: _tier_two_message, 3: _tier_three_message}
    return builder[tier](_expected_minutes(_TIER_REMAINING[tier]))


def test_script_is_present_and_executable():
    assert _SCRIPT.is_file()
    assert os.access(_SCRIPT, os.X_OK)


def test_shell_options_are_pinned():
    # `set -uo pipefail` is unobservable from outside: every variable the hook reads is defaulted or
    # assigned, which is precisely what these options exist to keep true. Pin the line so deleting it
    # fails here rather than turning some future mistyped variable into permanent silence.
    lines = [line for line in _SCRIPT.read_text(encoding="utf-8").splitlines() if line and not line.startswith("#")]
    assert lines[0] == "set -uo pipefail", f"first executable line of the hook is {lines[0]!r}"


def test_interval_defaults_match_the_hook_source():
    source = _SCRIPT.read_text(encoding="utf-8")
    assert f"reminder_interval={_REMINDER_INTERVAL_SEC}" in source
    assert f"urgent_interval={_URGENT_INTERVAL_SEC}" in source


@pytest.mark.parametrize("tier", _TIERS)
def test_each_tier_emits_its_own_message(tmp_path, tier):
    assert _context(_run(_env_for_tier(tmp_path, tier))) == _message_for_tier(tmp_path, tier)


@pytest.mark.parametrize(
    ("remaining", "minutes"),
    [(450, 7), (515, 8), (75, 1), (30, 0)],
    ids=["7m30s", "8m35s", "1m15s", "under-a-minute"],
)
def test_tier_one_minutes_truncate(tmp_path, remaining, minutes):
    assert _expected_minutes(remaining) == minutes
    assert _context(_run(_tier_one_env(tmp_path, remaining=remaining))) == _tier_one_message(minutes)


@pytest.mark.parametrize(
    ("remaining", "minutes"),
    [(770, 12), (630, 10), (500, 8)],
    ids=["12m50s", "10m30s", "8m20s"],
)
def test_tier_two_minutes_truncate(tmp_path, remaining, minutes):
    assert _expected_minutes(remaining) == minutes
    assert _context(_run(_tier_two_env(tmp_path, remaining=remaining))) == _tier_two_message(minutes)


@pytest.mark.parametrize(
    ("remaining", "minutes"),
    [(450, 7), (130, 2), (30, 0)],
    ids=["7m30s", "2m10s", "under-a-minute"],
)
def test_tier_three_minutes_truncate(tmp_path, remaining, minutes):
    assert _expected_minutes(remaining) == minutes
    assert _context(_run(_tier_three_env(tmp_path, remaining=remaining))) == _tier_three_message(minutes)


def test_tier_four_names_the_verdict_path_when_none_is_written(tmp_path):
    assert _context(_run(_tier_four_env(tmp_path))) == _tier_four_message(tmp_path)


def test_tier_four_stops_pressing_once_the_verdict_exists(tmp_path):
    # The PostToolUse matcher is "*", so the Write that produces the verdict re-triggers the hook.
    (tmp_path / _VERDICT_NAME).write_text('{"status": "LAND"}', encoding="utf-8")
    assert _context(_run(_tier_four_env(tmp_path))) == _TIER_FOUR_VERDICT_WRITTEN_MESSAGE


def test_target_budget_in_the_message_is_derived_not_hardcoded(tmp_path):
    # Doubling every configured budget must double the target the nudge quotes: the hook derives it
    # from start-to-target rather than carrying a copy of the workflow's number.
    elapsed = _TARGET_BUDGET_SEC + 450
    env = _env(
        tmp_path,
        elapsed=elapsed,
        target_budget=_TARGET_BUDGET_SEC * 2,
        soft_budget=_SOFT_BUDGET_SEC * 2,
        hard_budget=_HARD_BUDGET_SEC * 2,
    )
    remaining = _TARGET_BUDGET_SEC * 2 - elapsed
    assert _context(_run(env)) == _tier_one_message(_expected_minutes(remaining), budget_min=_TARGET_BUDGET_MIN * 2)


def test_now_exactly_at_the_target_deadline_is_tier_two(tmp_path):
    result = _run_within_one_second(lambda second: _env_from_start(tmp_path, start=second - _TARGET_BUDGET_SEC))
    assert _context(result) == _tier_two_message((_HARD_BUDGET_SEC - _TARGET_BUDGET_SEC) // 60)


def test_now_exactly_at_the_soft_deadline_is_tier_three(tmp_path):
    result = _run_within_one_second(lambda second: _env_from_start(tmp_path, start=second - _SOFT_BUDGET_SEC))
    assert _context(result) == _tier_three_message((_HARD_BUDGET_SEC - _SOFT_BUDGET_SEC) // 60)


def test_now_exactly_at_the_hard_deadline_is_tier_four(tmp_path):
    result = _run_within_one_second(lambda second: _env_from_start(tmp_path, start=second - _HARD_BUDGET_SEC))
    assert _context(result) == _tier_four_message(tmp_path)


def test_tier_one_is_silent_below_half_the_target_budget(tmp_path):
    # The state file starts absent, so nothing but the floor can suppress this call.
    result = _run(_env(tmp_path, elapsed=_TIER_ONE_FLOOR_SEC - 10))
    _assert_silent(result)
    assert not (tmp_path / _STATE_NAME).exists()


def test_tier_one_fires_just_above_half_the_target_budget(tmp_path):
    result = _run(_env(tmp_path, elapsed=_TIER_ONE_FLOOR_SEC + 10))
    assert _context(result) == _tier_one_message(_expected_minutes(_TARGET_BUDGET_SEC - _TIER_ONE_FLOOR_SEC - 10))


def test_tier_one_fires_exactly_at_half_the_target_budget(tmp_path):
    # The floor is a strict `<`, so the halfway point itself is the first moment tier 1 may fire.
    # Only that exact second separates it from a `<=`; a run a second either way behaves the same
    # under both.
    result = _run_within_one_second(lambda second: _env_from_start(tmp_path, start=second - _TIER_ONE_FLOOR_SEC))
    assert _context(result) == _tier_one_message((_TARGET_BUDGET_SEC - _TIER_ONE_FLOOR_SEC) // 60)


def test_tier_one_floor_scales_with_the_configured_target_budget(tmp_path):
    # The floor is half of whatever target the workflow set, not a fixed number of minutes: an
    # elapsed time that clears it under the configured budget must still be suppressed under a
    # much larger one.
    env = _env(
        tmp_path,
        elapsed=_TIER_ONE_FLOOR_SEC + 10,
        target_budget=_TARGET_BUDGET_SEC * 3,
        soft_budget=_SOFT_BUDGET_SEC * 3,
        hard_budget=_HARD_BUDGET_SEC * 3,
    )
    _assert_silent(_run(env))


def test_zero_target_window_skips_the_tier_one_floor(tmp_path):
    # A target deadline exactly at the start has no halfway point to compare against; the hook
    # emits rather than dividing a zero window and silently disabling itself.
    env = _env(tmp_path, elapsed=-100, target_budget=0, soft_budget=200, hard_budget=300)
    assert _context(_run(env)) == _tier_one_message(_expected_minutes(100), budget_min=0)


def test_negative_target_window_skips_the_tier_one_floor(tmp_path):
    # A target deadline before the start is a misconfiguration rather than a window; same outcome
    # as the zero case, reached through the other side of the comparison. The window is quoted as
    # it is rather than clamped, so the nudge names a negative target: -90 seconds is -1 minute,
    # bash integer division truncating toward zero. Only the workflow's own budget validation
    # keeps that unreachable in production.
    env = _env(tmp_path, elapsed=-190, target_budget=-90, soft_budget=200, hard_budget=300)
    assert _context(_run(env)) == _tier_one_message(_expected_minutes(100), budget_min=-1)


@pytest.mark.parametrize("tier", _TIERS)
def test_repeat_within_the_interval_is_rate_limited(tmp_path, tier):
    interval = _interval_for_tier(tier)
    state = _seed_state(tmp_path, seconds_ago=interval - 20, tier=tier)
    before = state.read_text(encoding="utf-8")
    _assert_silent(_run(_env_for_tier(tmp_path, tier)))
    assert state.read_text(encoding="utf-8") == before


@pytest.mark.parametrize("tier", _TIERS)
def test_repeat_past_the_interval_fires_again(tmp_path, tier):
    _seed_state(tmp_path, seconds_ago=_interval_for_tier(tier) + 20, tier=tier)
    assert _context(_run(_env_for_tier(tmp_path, tier))) == _message_for_tier(tmp_path, tier)


@pytest.mark.parametrize("tier", _TIERS)
def test_fires_when_the_gap_exactly_equals_the_interval(tmp_path, tier):
    interval = _interval_for_tier(tier)

    def setup(second: int) -> dict[str, str]:
        _write_state(tmp_path, f"{second - interval} {tier}")
        return _env_from_start(tmp_path, start=second - _elapsed_for_tier(tier))

    assert _context(_run_within_one_second(setup)) == _message_for_tier(tmp_path, tier)


@pytest.mark.parametrize("tier", _TIERS)
def test_silent_one_second_inside_the_interval(tmp_path, tier):
    interval = _interval_for_tier(tier)

    def setup(second: int) -> dict[str, str]:
        _write_state(tmp_path, f"{second - interval + 1} {tier}")
        return _env_from_start(tmp_path, start=second - _elapsed_for_tier(tier))

    _assert_silent(_run_within_one_second(setup))


@pytest.mark.parametrize(("last_tier", "tier"), [(1, 2), (2, 3), (3, 4), (1, 4), (2, 4)])
def test_escalating_tier_bypasses_the_rate_limit(tmp_path, last_tier, tier):
    # One state file serves every tier, so without this bypass an escalation would inherit the
    # previous tier's cooldown and stay silent for up to a full reminder interval.
    _seed_state(tmp_path, seconds_ago=5, tier=last_tier)
    assert _context(_run(_env_for_tier(tmp_path, tier))) == _message_for_tier(tmp_path, tier)


@pytest.mark.parametrize("tier", _TIERS)
def test_state_file_records_the_emit_time_and_tier(tmp_path, tier):
    assert _context(_run(_env_for_tier(tmp_path, tier))) == _message_for_tier(tmp_path, tier)
    epoch, recorded_tier = (tmp_path / _STATE_NAME).read_text(encoding="utf-8").split()
    assert epoch.isdigit()
    assert abs(int(epoch) - int(time.time())) <= 5
    assert recorded_tier == str(tier)


@pytest.mark.parametrize(
    "contents",
    ["not-an-epoch", "", "   ", "123 x", "x 4", "12.5 4", "-1 4", "4"],
    ids=["garbage", "empty", "blank", "bad-tier", "bad-epoch", "float-epoch", "negative-epoch", "one-field"],
)
def test_unusable_state_file_does_not_suppress(tmp_path, contents):
    # Both fields reach an arithmetic context, and the file sits in a shared temp dir: a truncated
    # write, a foreign writer, or a file holding one field must read as "no reminder yet". The
    # emission alone does not prove the guard -- an unvalidated field reaches the arithmetic and is
    # dropped there too, just noisily -- so _context's stderr check is what separates the two.
    _write_state(tmp_path, contents)
    assert _context(_run(_tier_four_env(tmp_path))) == _tier_four_message(tmp_path)


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores the permission bits these cases rely on")
@pytest.mark.parametrize(
    ("dir_mode", "file_mode"),
    [(0o500, 0o600), (0o700, 0o000), (0o000, 0o600)],
    ids=["unwritable-dir", "unreadable-file", "unreachable-dir"],
)
def test_unusable_state_path_still_emits_quietly(tmp_path, dir_mode, file_mode):
    # A hook whose contract is "silent on fault" must not leak a redirection error to stderr, which
    # Claude Code surfaces to the operator as a non-blocking hook error. A redirection that fails
    # outright reports before a trailing 2>/dev/null on the same command can cover it.
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    state_file = state_dir / _STATE_NAME
    state_file.write_text("0 1", encoding="utf-8")
    state_file.chmod(file_mode)
    state_dir.chmod(dir_mode)
    try:
        env = _tier_four_env(tmp_path)
        env["RUNNER_TEMP"] = str(state_dir)
        assert _context(_run(env)) == _tier_four_message(tmp_path)
    finally:
        state_dir.chmod(0o700)
        state_file.chmod(0o600)


@pytest.mark.parametrize(
    "template",
    ["now[$(>{marker})] 4", "{recent} now[$(>{marker})]"],
    ids=["epoch-field", "tier-field"],
)
def test_state_file_contents_are_not_evaluated(tmp_path, template):
    # Both fields land in `$(( ))`, where bash evaluates the *contents* of a variable: a payload
    # subscripting a name the hook itself defines runs its command substitution, and `now` is such
    # a name. The 10# prefix is what makes the payload a syntax error instead, and the digit guard
    # is what keeps it from reaching the arithmetic at all -- neither may be the only one left.
    # The payload carries no space: `read` splits the line into fields, so a spaced one lands in
    # the state file as two harmless fragments and proves nothing about either field.
    marker = tmp_path / _INJECTION_MARKER
    _write_state(tmp_path, template.format(marker=marker, recent=int(time.time()) - 5))
    assert _context(_run(_tier_four_env(tmp_path))) == _tier_four_message(tmp_path)
    assert not marker.exists()


@pytest.mark.parametrize(
    ("epoch_prefix", "tier_field"),
    [("0", "4"), ("", "08")],
    ids=["epoch-field", "tier-field"],
)
def test_leading_zero_state_fields_are_read_as_base_ten(tmp_path, epoch_prefix, tier_field):
    # A leading zero is octal to `$(( ))`, so without the 10# prefix the recorded epoch and tier
    # read as some other number, or as nothing at all when the digits are not valid octal. Both
    # cases are proved through suppression: the state is recent enough and its tier high enough
    # that the hook must stay silent, which only holds if both fields survived the round trip.
    _write_state(tmp_path, f"{epoch_prefix}{int(time.time()) - 10} {tier_field}")
    _assert_silent(_run(_tier_four_env(tmp_path)))


@pytest.mark.parametrize(("var", "default", "tier"), _INTERVAL_CASES, ids=_INTERVAL_IDS)
def test_interval_override_is_honoured(tmp_path, var, default, tier):
    env = _env_for_tier(tmp_path, tier)
    env[var] = str(default * 4)
    _seed_state(tmp_path, seconds_ago=default + 20, tier=tier)
    _assert_silent(_run(env))

    env[var] = "1"
    assert _context(_run(env)) == _message_for_tier(tmp_path, tier)


@pytest.mark.parametrize(("var", "default", "tier"), _INTERVAL_CASES, ids=_INTERVAL_IDS)
def test_interval_injection_neither_executes_nor_changes_the_interval(tmp_path, var, default, tier):
    # The intervals land in `((now - last < interval))`, and bash evaluates the *contents* of a
    # variable in arithmetic context: an unvalidated one is a command-substitution sink. The value
    # must be rejected outright, leaving the default interval in force rather than any interval the
    # payload dictates.
    marker = tmp_path / _INJECTION_MARKER
    env = _env_for_tier(tmp_path, tier)
    env[var] = f"now[$(touch {marker})]"

    _seed_state(tmp_path, seconds_ago=default - 20, tier=tier)
    _assert_silent(_run(env))
    assert not marker.exists()

    _seed_state(tmp_path, seconds_ago=default + 20, tier=tier)
    assert _context(_run(env)) == _message_for_tier(tmp_path, tier)
    assert not marker.exists()


@pytest.mark.parametrize(("var", "default", "tier"), _INTERVAL_CASES, ids=_INTERVAL_IDS)
@pytest.mark.parametrize("bad", _NON_NUMERIC)
def test_non_numeric_interval_falls_back_to_its_default(tmp_path, var, default, tier, bad):
    env = _env_for_tier(tmp_path, tier)
    env[var] = bad
    _seed_state(tmp_path, seconds_ago=default - 20, tier=tier)
    _assert_silent(_run(env))


@pytest.mark.parametrize(("var", "default", "tier"), _INTERVAL_CASES, ids=_INTERVAL_IDS)
def test_leading_zero_interval_is_read_as_base_ten(tmp_path, var, default, tier):
    # A leading zero clears the digit guard and then means octal to `$(( ))`: 060 would be 48
    # seconds, and 0180 no number at all. The state is seeded just inside the interval, where the
    # hook is silent only if the override still reads as the decimal it was written as.
    env = _env_for_tier(tmp_path, tier)
    env[var] = f"0{default}"
    _seed_state(tmp_path, seconds_ago=default - 10, tier=tier)
    _assert_silent(_run(env))


@pytest.mark.parametrize("var", _EPOCH_VARS)
def test_unset_epoch_var_is_a_silent_no_op(tmp_path, var):
    # Tier 4 with no state file is the loudest scenario there is, so silence here can only be the guard.
    env = _tier_four_env(tmp_path)
    del env[var]
    _assert_silent(_run(env))
    assert not (tmp_path / _STATE_NAME).exists()


@pytest.mark.parametrize("var", _EPOCH_VARS)
@pytest.mark.parametrize("bad", _NON_NUMERIC)
def test_non_numeric_epoch_var_is_a_silent_no_op(tmp_path, var, bad):
    env = _tier_four_env(tmp_path)
    env[var] = bad
    _assert_silent(_run(env))
    assert not (tmp_path / _STATE_NAME).exists()


@pytest.mark.parametrize("var", _EPOCH_VARS)
def test_leading_zero_epoch_is_read_as_base_ten(tmp_path, var):
    # `$(( ))` reads a leading zero as octal, and an epoch is not a valid octal literal: the
    # expansion errors, leaves its target unset, and `set -u` turns the hook into a non-zero exit.
    env = _tier_one_env(tmp_path, remaining=450)
    env[var] = "0" + env[var]
    result = _run(env)
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""
    assert _context(result) == _tier_one_message(_expected_minutes(450))


def _stub_bin(tmp_path: Path, *, jq_exit: int | None = None, omit: str = "") -> dict[str, str]:
    """A PATH holding the tools the hook needs, optionally with jq stubbed out or a tool missing."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for tool in ("jq", "date", "cat"):
        if tool == omit:
            continue
        if tool == "jq" and jq_exit is not None:
            stub = bin_dir / "jq"
            # The stub explains itself on stderr, the way a real jq failure does: an out-of-memory
            # or corrupt-binary jq is loud, and a hook that passes that through reports a hook
            # error to the operator after every tool call for the rest of the review.
            stub.write_text(f"#!/bin/sh\necho '{_JQ_STUB_DIAGNOSTIC}' >&2\nexit {jq_exit}\n", encoding="utf-8")
            stub.chmod(0o755)
            continue
        resolved = shutil.which(tool)
        assert resolved, f"{tool} must be installed to run this test"
        (bin_dir / tool).symlink_to(resolved)
    env = _tier_four_env(tmp_path)
    env["PATH"] = str(bin_dir)
    return env


def test_missing_jq_is_a_silent_no_op(tmp_path):
    _assert_silent(_run(_stub_bin(tmp_path, omit="jq")))
    # The rate-limit clock must not advance, or the next reminder would be swallowed too.
    assert not (tmp_path / _STATE_NAME).exists()


def test_missing_date_is_a_silent_no_op(tmp_path):
    _assert_silent(_run(_stub_bin(tmp_path, omit="date")))
    assert not (tmp_path / _STATE_NAME).exists()


@pytest.mark.parametrize("jq_exit", [1, 7])
def test_failing_jq_is_silent_and_does_not_advance_the_clock(tmp_path, jq_exit):
    # `command -v jq` only detects absence. A jq that runs and fails would, if the state were
    # written first, bump the clock with nothing emitted and swallow the next reminder as well --
    # and it is the one fault here loud enough to reach the operator on its own, so the silence
    # _assert_silent checks covers the diagnostic the stub writes as well as the hook's own output.
    _assert_silent(_run(_stub_bin(tmp_path, jq_exit=jq_exit)))
    assert not (tmp_path / _STATE_NAME).exists()


def test_oversized_stdin_is_drained(tmp_path):
    # Claude Code writes the tool-call event JSON to hook stdin. A hook that never reads it makes
    # that write fail with EPIPE as soon as the payload outgrows the pipe buffer, so push a payload
    # far past any pipe buffer and require the write to complete.
    read_fd, write_fd = os.pipe()
    try:
        proc = subprocess.Popen(  # noqa: S603
            [_BASH, str(_SCRIPT)],
            stdin=read_fd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=_tier_four_env(tmp_path),
        )
    finally:
        os.close(read_fd)

    try:
        with os.fdopen(write_fd, "wb") as sink:
            sink.write(b'{"tool_name":"Read","padding":"' + b"x" * (1 << 20) + b'"}')
    except BrokenPipeError:
        proc.kill()
        proc.communicate()
        pytest.fail("the hook exited without draining stdin")

    stdout, stderr = proc.communicate(timeout=30)
    assert proc.returncode == 0, stderr
    assert json.loads(stdout)["hookSpecificOutput"]["additionalContext"] == _tier_four_message(tmp_path)


def _review_steps() -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = _review_job()["steps"]
    return steps


def _budget_step_index() -> int:
    """The workflow step that exports the deadlines to $GITHUB_ENV."""
    for index, step in enumerate(_review_steps()):
        if "$GITHUB_ENV" in str(step.get("run", "")):
            return index
    pytest.fail(f"no step in {_WORKFLOW.name} writes to $GITHUB_ENV")


def _model_step_index() -> int:
    """The workflow step that runs the reviewer model the deadlines pace."""
    for index, step in enumerate(_review_steps()):
        if str(step.get("uses", "")).startswith(_MODEL_ACTION):
            return index
    pytest.fail(f"no step in {_WORKFLOW.name} runs {_MODEL_ACTION}")


def _budget_step_run() -> str:
    return str(_review_steps()[_budget_step_index()].get("run", ""))


def _model_step_timeout_min() -> int:
    """The wall-clock the model step is timed out at, whatever the budgets say."""
    step = _review_steps()[_model_step_index()]
    timeout = step.get("timeout-minutes")
    assert isinstance(timeout, int), f"the model step in {_WORKFLOW.name} sets timeout-minutes {timeout!r}"
    return timeout


def _hook_settings() -> dict[str, Any]:
    """The .claude/settings.local.json the review job writes, parsed out of its heredoc."""
    for step in _review_job()["steps"]:
        match = re.search(r"<<'EOF'\n(.*?)\n\s*EOF\s*$", str(step.get("run", "")), re.DOTALL)
        if match and '"hooks"' in match.group(1):
            settings: dict[str, Any] = json.loads(match.group(1))
            return settings
    pytest.fail(f"no step in {_WORKFLOW.name} writes a settings file containing hooks")


def test_workflow_exports_every_epoch_var_the_hook_reads():
    # Renaming one of these on either side leaves every other test and linter green while the hook
    # reads an unset deadline and stays silent for the whole review.
    hook = _SCRIPT.read_text(encoding="utf-8")
    unread = [var for var in _EPOCH_VARS if f"${{{var}:-}}" not in hook]
    assert not unread, f"the hook no longer reads {unread}"

    exported = set(re.findall(r'echo "([A-Za-z_][A-Za-z0-9_]*)=', _budget_step_run()))
    assert set(_EPOCH_VARS) <= exported, f"{_WORKFLOW.name} does not export {sorted(set(_EPOCH_VARS) - exported)}"


def test_workflow_posttooluse_runs_this_hook():
    blocks = _hook_settings()["hooks"]["PostToolUse"]
    entries = [entry for block in blocks for entry in block["hooks"]]
    command = _SCRIPT.relative_to(ROOT).as_posix()
    ours = [entry for entry in entries if entry["command"] == command]
    assert ours, f"PostToolUse runs {[entry['command'] for entry in entries]}"
    # The final tier distinguishes "verdict still due" from "verdict already written", which is only
    # reachable because the Write that produces the verdict re-triggers the hook.
    assert [block["matcher"] for block in blocks] == ["*"]
    # An unpinned timeout falls back to the CLI's own, which is measured in minutes. This hook runs
    # after every tool call, so one that hangs there burns the budget it exists to protect.
    for entry in ours:
        timeout = entry.get("timeout")
        assert isinstance(timeout, int), f"the PostToolUse entry for {command} sets timeout {timeout!r}"
        assert 0 < timeout <= _HOOK_TIMEOUT_CEILING_SEC, (
            f"the PostToolUse entry for {command} times out after {timeout}s; "
            f"expected whole seconds at most {_HOOK_TIMEOUT_CEILING_SEC}"
        )


def test_budget_step_is_the_last_step_before_the_model():
    # $GITHUB_ENV reaches only subsequent steps, so the deadlines start counting from wherever this
    # step sits. Anywhere earlier and the budget also covers the checkout, sanitize and OIDC setup
    # that precede the model -- time the model never had.
    budget, model = _budget_step_index(), _model_step_index()
    names = [str(step.get("name", "")) for step in _review_steps()]
    assert budget == model - 1, f"the budget step is {model - budget} steps ahead of the model, in {names}"


def test_every_budget_leaves_the_model_time_to_write_its_verdict():
    # The tiers only pace the model; the model step's timeout-minutes is what actually stops it, and
    # a timed-out step discards a review that has not written its verdict yet. Nothing else compares
    # the two, so a budget raised past the timeout would leave the last nudges firing after the step
    # is already gone.
    timeout_min = _model_step_timeout_min()
    for key, var in _BUDGET_VARS.items():
        budget_min = _BUDGET_SEC[key] // 60
        assert budget_min + _VERDICT_HEADROOM_MIN <= timeout_min, (
            f"{var} is {budget_min}m against a {timeout_min}m model step timeout; "
            f"expected at least {_VERDICT_HEADROOM_MIN}m left to write the verdict"
        )


def _skill_section(name: str) -> str:
    """The text of one `## ` section of the skill, up to the next same-level heading."""
    text = _SKILL.read_text(encoding="utf-8")
    start = text.find(f"## {name}")
    assert start != -1, f"{_SKILL.name} has no '## {name}' section"
    end = text.find("\n## ", start + 1)
    return text[start:] if end == -1 else text[start:end]


def test_skill_budget_figures_match_the_workflow():
    # The skill states the budget in minutes and the workflow configures it; nothing else ties the
    # two together, so a budget change there would leave the skill quoting the old figures while
    # the reminders count against the new ones.
    #
    # Numbers are collected as a set, not by occurrence count: the section states the target three
    # times, the soft limit once and the hard limit twice, and any rewording moves those counts
    # without meaning anything. Collection is confined to the three shapes the section uses for a
    # budget figure -- inside a bold span, directly qualifying "minute", or labelling a stage --
    # and to this section alone, because a whole-file digit scan also picks up the numbered What
    # to inspect list. The shapes overlap on purpose: each figure is caught by more than one, so
    # restyling the section cannot drop a value and read as agreement.
    section = _skill_section(_BUDGET_SECTION)
    bold = (n for span in re.findall(r"\*\*(.+?)\*\*", section) for n in re.findall(r"\d+", span))
    qualifying_minutes = re.findall(r"(\d+)[- ]minutes?\b", section)
    stage_labels = re.findall(r"\bPast (\d+)\b", section)
    stated = {int(n) for n in (*bold, *qualifying_minutes, *stage_labels)}
    configured = {seconds // 60 for seconds in _BUDGET_SEC.values()}
    assert stated == configured, (
        f"the skill's '{_BUDGET_SECTION}' figures drifted from {_WORKFLOW.name}'s "
        f"{sorted(_BUDGET_VARS.values())}; symmetric difference: {sorted(stated ^ configured)}"
    )


def test_skill_stage_labels_quote_the_configured_budgets():
    # The set above proves the section quotes no figure the workflow does not configure; it cannot
    # prove each stage quotes the right one. Renumbering the stages after a budget change keeps the
    # same figures in the section while pointing the reminders at the wrong ones, and dropping a
    # figure from one label leaves the set intact whenever another mention survives elsewhere.
    # Only the first line of each numbered item is read, which is where the stage label sits, so
    # rewording the body of a stage cannot satisfy this.
    section = _skill_section(_BUDGET_SECTION)
    labels = re.findall(r"(?m)^(\d+)\.[ \t]+(.+)$", section)
    assert [number for number, _ in labels] == [str(tier) for tier in _TIERS], (
        f"the skill's '{_BUDGET_SECTION}' numbers {[number for number, _ in labels]} against the hook's tiers {_TIERS}"
    )
    for (number, label), key in zip(labels, _SKILL_STAGE_BUDGETS, strict=True):
        expected = _BUDGET_SEC[key] // 60
        assert expected in {int(n) for n in re.findall(r"\d+", label)}, (
            f"stage {number} of the skill's '{_BUDGET_SECTION}' does not quote the "
            f"{_BUDGET_VARS[key]} figure {expected}: {label!r}"
        )


def test_final_tier_defers_to_a_section_the_skill_actually_has():
    # Deferring to the skill removes one definition of "critical" but adds a reference that can
    # dangle: renaming the section there would leave the last nudge of the review pointing at
    # nothing. The name is read back out of the hook so this cannot pass by agreeing with itself.
    named = re.search(r"critical under the skill's (.+?) criteria", _SCRIPT.read_text(encoding="utf-8"))
    assert named is not None, "the final tier no longer defers to a named skill section"
    section = named.group(1)
    assert section == _CRITERIA_SECTION
    headings = re.findall(r"^#+ (.+)$", _SKILL.read_text(encoding="utf-8"), re.MULTILINE)
    assert section in headings, f"{_SKILL.name} has no '{section}' section; its headings are {headings}"


def _final_tier_rule() -> str:
    """The rule the last nudge of the review states, as the model receives it."""
    match = re.search(r"The rule at this point: (.+?)\"\n", _SCRIPT.read_text(encoding="utf-8"))
    assert match is not None, "the final tier no longer states a rule"
    return match.group(1)


def test_final_tier_does_not_restate_the_criteria():
    # An enumeration here is a second definition of "critical" that drifts from the skill's, and a
    # short list reads as exhaustive at the moment the model is deciding.
    enumerated = ("correctness", "preservation", "safety/security", "breaking changes")
    restated = [name for name in enumerated if name in _final_tier_rule()]
    assert not restated, f"the final tier restates {restated} instead of deferring to the skill"


def test_final_tier_and_the_skill_agree_an_unexamined_criterion_counts():
    # Two copies of one rule, read tens of minutes and many tool calls apart: the skill at the
    # start, this nudge at the wall. They have drifted before, and the half that drops the clause
    # is the half that tells a review with a skipped criterion and two nits to land. Deferring to
    # the skill does not cover this -- that settles what "critical" means, not what the rule ranges
    # over -- so the clause has to be present in the nudge itself.
    #
    # This pins wording, which the figure-based guards above do not have to: fail here and the fix
    # is to say the same thing in both places again, updating the constant if the phrasing moved.
    assert _UNEXAMINED_CRITERION_CLAUSE in _final_tier_rule(), (
        f"the final tier states the rule without '{_UNEXAMINED_CRITERION_CLAUSE}'"
    )
    # Markdown wraps the skill's copy mid-clause, and where it wraps means nothing.
    stated = " ".join(_skill_section(_BUDGET_SECTION).split())
    assert _UNEXAMINED_CRITERION_CLAUSE in stated, (
        f"the skill's '{_BUDGET_SECTION}' states the rule without '{_UNEXAMINED_CRITERION_CLAUSE}'"
    )


def test_verdict_path_default_matches_the_stop_hook():
    hook = re.search(r"GREENLIGHT_REVIEW_VERDICT_FILE:-([^}]+)\}", _SCRIPT.read_text(encoding="utf-8"))
    stop = re.search(r'^VERDICT_FILE="([^"]+)"', _STOP_HOOK.read_text(encoding="utf-8"), re.MULTILINE)
    assert hook is not None
    assert stop is not None
    assert hook.group(1) == stop.group(1)


def _readme_section(name: str) -> str:
    """The text of one `### ` subsection of the README, up to the next heading of any level."""
    text = _README.read_text(encoding="utf-8")
    start = text.find(f"### {name}")
    assert start != -1, f"{_README.name} has no '### {name}' section"
    end = text.find("\n#", start + 1)
    return text[start:] if end == -1 else text[start:end]


def _readme_figure(section: str, name: str) -> int:
    """The first number the README states after naming the setting ``name``."""
    match = re.search(rf"`{re.escape(name)}`[^0-9]{{0,60}}(\d+)", section)
    assert match is not None, f"the README's '{_README_BUDGET_SECTION}' states no figure for {name}"
    return int(match.group(1))


def test_readme_budget_figures_match_their_sources():
    # The README restates the whole budget in prose for a human reader, and every figure in it has
    # a source elsewhere: the workflow for the three budgets and the model step timeout, the hook
    # for the two reminder intervals (which reach this file as the constants above, pinned to the
    # hook's own defaults by test_interval_defaults_match_the_hook_source). Nothing but this ties
    # the prose to any of them. Each figure is located by the setting it belongs to rather than by
    # position, so the surrounding sentence can be rewritten freely.
    section = _readme_section(_README_BUDGET_SECTION)
    for key, var in _BUDGET_VARS.items():
        configured = _BUDGET_SEC[key] // 60
        assert _readme_figure(section, var) == configured, f"the README quotes {var} against {_WORKFLOW.name}"
    for var, default, _tier in _INTERVAL_CASES:
        assert _readme_figure(section, var) == default, f"the README quotes {var} against {_SCRIPT.name}"
    # The timeout has no setting name to anchor to, and is the one figure written as "N-minute".
    timeouts = {int(n) for n in re.findall(r"(\d+)-minute", section)}
    assert _model_step_timeout_min() in timeouts, (
        f"the README's '{_README_BUDGET_SECTION}' quotes {sorted(timeouts)} for the model step "
        f"timeout; {_WORKFLOW.name} sets {_model_step_timeout_min()}"
    )
