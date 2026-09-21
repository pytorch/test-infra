"""Compose the ``--settings`` layer the reviewer runs under.

The replay's whole claim is that it exercises the policy PR's reviewer, so the hooks come
from the policy tree rather than from a copy kept here: a PR that changes ``restrict-read.py``
or the pacing reminder is then actually under test. Only one hook is the harness's own, the
per-run path remap, and it is registered last.

Two hooks the workflow registers are deliberately absent, and both absences are load-bearing
rather than oversights.

``validate-on-stop.sh`` is NOT registered. It hardcodes ``/tmp/greenlight-verdict.json`` and
takes no override -- unlike ``budget-reminder.sh``, which honours
``GREENLIGHT_REVIEW_VERDICT_FILE`` -- so under the per-run path remap it would watch a file
the reviewer never writes and refuse every stop. Each run would then loop until the CLI gave
up, at full price, and produce nothing. Its job is refusing a stop without a valid verdict,
and the runner does that instead by validating against the policy's schema and retrying once.

The instruction-loading detector's ``SessionStart`` and ``InstructionsLoaded`` hooks are also
absent. They exist to leave a manifest and a sentinel for a later CI step to assert on, and
there is no such step here; the sanitize pass they check still runs.
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any

from torchci.greenlight_replay.hooks import remap
from torchci.greenlight_replay.policy import Policy


__all__ = [
    "BUDGET_HOOK_TIMEOUT_S",
    "REMAP_MATCHER",
    "SETTINGS_FILENAME",
    "MissingHookError",
    "assert_hooks_present",
    "missing_hooks",
    "write_settings",
]


class MissingHookError(RuntimeError):
    """A hook script the settings layer registers is not there to run."""


SETTINGS_FILENAME = "settings.json"

# Pinned rather than left to the CLI default, which is measured in minutes: a hung pacing
# reminder would spend the very budget it exists to protect, once per tool call.
BUDGET_HOOK_TIMEOUT_S = 5

# The reviewer's output style in CI. Named here because it travels with the hooks: both
# reach the reviewer through this one file.
OUTPUT_STYLE = "Concise"

# Matches restrict-read.py's own coverage. Read and Write are the tools that name the
# skill's three scratch paths directly; Glob and Grep are here because the read sandbox
# admits any /tmp/greenlight-* search path, which would otherwise reach the SHARED /tmp
# rather than this run's directory.
REMAP_MATCHER = "Read|Write|Glob|Grep"


def _script(path: Path, *, interpreter: str = "") -> str:
    """A hook command line, shell-quoted.

    The CLI runs these through a shell, so a workdir containing a space would otherwise
    split one path into two words. Nothing rejects the resulting command: a hook that
    cannot exec does not deny, so ALL THREE PreToolUse hooks would drop out silently --
    the read sandbox, the write sandbox, and the per-run path remap together. Losing the
    remap alone turns a parallel sweep into every reviewer sharing one diff and one
    verdict file.
    """
    quoted = shlex.quote(str(path))
    return f"{interpreter} {quoted}" if interpreter else quoted


def _hook_scripts(policy: Policy) -> list[Path]:
    hooks = policy.hooks_dir
    return [
        hooks / "restrict-write.sh",
        hooks / "restrict-read.py",
        hooks / "budget-reminder.sh",
        Path(remap.__file__).resolve(),
    ]


def missing_hooks(policy: Policy) -> list[Path]:
    """Hook scripts the settings layer would register that are not on disk.

    Checked once at sweep startup rather than per run, because the failure it guards is a
    property of the policy tree and identical for every pull request. It has to be checked
    somewhere: a hook that cannot exec does not deny, so a missing script silently removes
    a sandbox rather than failing, and the quoting above is only half the defence.
    """
    return [script for script in _hook_scripts(policy) if not script.is_file()]


def assert_hooks_present(policy: Policy) -> None:
    """Raise unless every hook the settings layer registers can actually run."""
    missing = missing_hooks(policy)
    if missing:
        raise MissingHookError(
            "hook scripts are missing, so the sandbox they provide would silently not "
            f"load: {', '.join(str(path) for path in missing)}"
        )


def _matcher(
    matcher: str, command: str, *, timeout: int | None = None
) -> dict[str, Any]:
    hook: dict[str, Any] = {"type": "command", "command": command}
    if timeout is not None:
        hook["timeout"] = timeout
    return {"matcher": matcher, "hooks": [hook]}


def write_settings(policy: Policy, run_dir: Path) -> Path:
    """Write the settings file for one run and return its path.

    The remap is registered alongside the production sandboxes rather than replacing them:
    every PreToolUse hook is handed the ORIGINAL tool input, so ``restrict-read.py`` and
    ``restrict-write.sh`` go on judging the un-remapped ``/tmp/greenlight-*`` paths they
    already permit, and the rewrite is applied afterwards.
    """
    hooks = policy.hooks_dir
    settings = {
        "hooks": {
            "PreToolUse": [
                _matcher("Write|Edit", _script(hooks / "restrict-write.sh")),
                _matcher(
                    "Read|Glob|Grep",
                    _script(hooks / "restrict-read.py", interpreter="python3"),
                ),
                _matcher(
                    REMAP_MATCHER,
                    _script(Path(remap.__file__).resolve(), interpreter="python3"),
                ),
            ],
            "PostToolUse": [
                _matcher(
                    "*",
                    _script(hooks / "budget-reminder.sh"),
                    timeout=BUDGET_HOOK_TIMEOUT_S,
                ),
            ],
        },
        "outputStyle": OUTPUT_STYLE,
    }
    path = Path(run_dir) / SETTINGS_FILENAME
    path.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    return path
