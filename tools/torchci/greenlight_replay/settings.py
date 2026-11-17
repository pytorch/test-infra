"""Derive the reviewer's hook settings from the policy's workflow, and compose its ``--settings``.

The review job writes ``.claude/settings.local.json`` from a quoted heredoc, and that
file is what registers the reviewer's sandboxes. The replay reads the same heredoc out of
the arm's workflow (:mod:`.workflow_steps`), substitutes the checkout ``greenlight target``
named for ``__GREENLIGHT_CHECKOUT__`` as the job's ``sed`` does, and refuses what it
cannot reproduce: keys other than ``hooks`` and ``claudeMdExcludes``, an event outside the
five it knows, a hook that is not a command, a ``.claude/hooks`` script that is missing or
cannot run, a PreToolUse or PostToolUse command that runs no such script, sandboxes not
registered on the tools they confine, and SessionStart or InstructionsLoaded commands
other than the two that leave the detector its sentinel and manifest.

What the reviewer runs under is that layer with three changes:

* Each command runs its script from the materialized policy tree by absolute, shell-quoted
  path, outside the reviewer's workspace. The CLI runs hook commands through a shell, so
  an unquoted space would split one path into two words; nothing rejects that command,
  and a hook that cannot exec does not deny, so the sandbox it provides drops out.
* ``Stop`` is dropped. ``validate-on-stop.sh`` hardcodes ``/tmp/greenlight-verdict.json``,
  which the per-run remap moves into the run directory, so it would watch a file the
  reviewer never writes and refuse every stop. Whether a verdict is recorded is decided
  after the session instead, by the record path's own checks.
* The harness's remap hook is appended to PreToolUse, last. Every PreToolUse hook is
  handed the ORIGINAL tool input, so the policy's sandboxes judge the un-remapped
  ``/tmp/greenlight-*`` paths they permit and the rewrite is applied afterwards.

``outputStyle`` comes from the action step's ``with.settings``. ``reviewer_env`` sets
``RUNNER_TEMP`` to the run directory, so the detector's two hooks write there.
"""

from __future__ import annotations

import json
import os
import shlex
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Any, TYPE_CHECKING

from torchci.greenlight_replay.hooks import remap
from torchci.greenlight_replay.workflow_steps import MANIFEST_COMMAND, SENTINEL_COMMAND


if TYPE_CHECKING:
    from torchci.greenlight_replay.policy import Policy


__all__ = [
    "CHECKOUT_PLACEHOLDER",
    "DROPPED_EVENTS",
    "HOOK_EVENTS",
    "REMAP_MATCHER",
    "SETTINGS_FILENAME",
    "MissingHookError",
    "assert_hooks_present",
    "derive_hook_settings",
    "missing_hooks",
    "write_settings",
]


class MissingHookError(RuntimeError):
    """A hook script the settings layer registers is not there to run."""


SETTINGS_FILENAME = "settings.json"
CHECKOUT_PLACEHOLDER = "__GREENLIGHT_CHECKOUT__"
HOOKS_PREFIX = ".claude/hooks/"
PYTHON = "python3"

HOOK_EVENTS = (
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionStart",
    "InstructionsLoaded",
)
DROPPED_EVENTS = frozenset({"Stop"})
SETTINGS_KEYS = frozenset({"hooks", "claudeMdExcludes"})

# The only commands these two events may run: they leave what the detector asserts on.
EVENT_COMMANDS = {
    "SessionStart": SENTINEL_COMMAND,
    "InstructionsLoaded": MANIFEST_COMMAND,
}

# Each sandbox and the tools its matcher must cover, the matcher split on "|".
REQUIRED_SANDBOXES = (
    (".claude/hooks/greenlight/restrict-write.sh", frozenset({"Write", "Edit"})),
    (".claude/hooks/greenlight/restrict-read.py", frozenset({"Read", "Glob", "Grep"})),
)

# Matches restrict-read.py's own coverage plus Write. Read and Write name the skill's
# scratch paths directly; Glob and Grep are here because the read sandbox admits any
# /tmp/greenlight-* search path, which would otherwise reach the SHARED /tmp rather than
# this run's directory.
REMAP_MATCHER = "Read|Write|Glob|Grep"


def derive_hook_settings(
    text: str, root: Path, checkout: str, source: Path
) -> dict[str, Any]:
    """The workflow's hook settings for ``checkout``, refused unless reproducible."""
    try:
        settings = json.loads(text.replace(CHECKOUT_PLACEHOLDER, checkout))
    except ValueError as exc:
        raise ValueError(f"{source}: the hook settings are not JSON: {exc}") from exc
    if (
        not isinstance(settings, dict)
        or not isinstance(settings.get("hooks"), dict)
        or set(settings) - SETTINGS_KEYS
    ):
        raise ValueError(
            f"{source}: the hook settings must hold a hooks object and nothing but "
            f"{', '.join(sorted(SETTINGS_KEYS))}"
        )
    excludes = settings.get("claudeMdExcludes", [])
    if not isinstance(excludes, list) or not all(isinstance(x, str) for x in excludes):
        raise ValueError(f"{source}: claudeMdExcludes is not a list of strings")
    for event, entries in settings["hooks"].items():
        if event not in HOOK_EVENTS:
            raise ValueError(
                f"{source}: the replay does not reproduce hook event {event}"
            )
        for hook in _hooks_of(entries, event, source):
            _check_command(event, hook["command"], Path(root), source)
    for script, tools in REQUIRED_SANDBOXES:
        if not _registered(settings["hooks"].get("PreToolUse", []), script, tools):
            raise ValueError(
                f"{source}: {script} is not registered on a PreToolUse matcher covering "
                f"{', '.join(sorted(tools))}"
            )
    return settings


def _hooks_of(entries: Any, event: str, source: Path) -> list[Mapping[str, Any]]:
    if not isinstance(entries, list):
        raise ValueError(f"{source}: the {event} hooks are not a list")
    hooks: list[Mapping[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
            raise ValueError(f"{source}: a {event} entry holds no hooks list")
        if not isinstance(entry.get("matcher", ""), str):
            raise ValueError(f"{source}: a {event} matcher is not a string")
        for hook in entry["hooks"]:
            if (
                not isinstance(hook, dict)
                or hook.get("type") != "command"
                or not isinstance(hook.get("command"), str)
            ):
                raise ValueError(f"{source}: a {event} hook is not a command: {hook!r}")
            hooks.append(hook)
    return hooks


def _check_command(event: str, command: str, root: Path, source: Path) -> None:
    expected = EVENT_COMMANDS.get(event)
    if expected is not None:
        if command != expected:
            raise ValueError(
                f"{source}: the {event} hook runs {command!r}; the replay reproduces "
                f"only {expected!r}"
            )
        return
    parsed = _hook_script(command)
    if parsed is None:
        raise ValueError(
            f"{source}: the {event} hook {command!r} runs no {HOOKS_PREFIX} script as a "
            "plain command line the replay can relocate"
        )
    interpreter, script, _ = parsed
    path = root / script
    if not path.is_file():
        raise ValueError(f"{source}: the {event} hook runs {script}, which is missing")
    if interpreter is None and not os.access(path, os.X_OK):
        raise ValueError(f"{source}: the {event} hook runs {script}, not executable")


def _hook_script(command: str) -> tuple[str | None, str, list[str]] | None:
    """``(interpreter, script, args)`` for ``[python3] .claude/hooks/<path> [args]``.

    Only a command line that round-trips through ``shlex`` qualifies: anything with
    shell syntax in it could not be rebuilt around a relocated path unchanged.
    """
    try:
        argv = shlex.split(command)
    except ValueError:
        return None
    if not argv or shlex.join(argv) != command:
        return None
    index = 1 if argv[0] == PYTHON else 0
    if len(argv) <= index or not argv[index].startswith(HOOKS_PREFIX):
        return None
    if ".." in PurePosixPath(argv[index]).parts:
        return None
    return (argv[0] if index else None), argv[index], argv[index + 1 :]


def _registered(
    entries: list[Mapping[str, Any]], script: str, tools: frozenset[str]
) -> bool:
    return any(
        set(str(entry.get("matcher", "")).split("|")) >= tools
        and any(
            (_hook_script(hook["command"]) or (None, None, None))[1] == script
            for hook in entry["hooks"]
        )
        for entry in entries
    )


def _registered_events(policy: Policy) -> dict[str, list[Mapping[str, Any]]]:
    return {
        event: entries
        for event, entries in policy.hook_settings["hooks"].items()
        if event not in DROPPED_EVENTS
    }


def _script_path(policy: Policy, script: str) -> Path:
    return Path(os.path.abspath(Path(policy.root) / script))


def _hook_scripts(policy: Policy) -> list[Path]:
    scripts = [
        _script_path(policy, parsed[1])
        for entries in _registered_events(policy).values()
        for entry in entries
        for hook in entry["hooks"]
        if (parsed := _hook_script(hook["command"])) is not None
    ]
    return [*scripts, Path(remap.__file__).resolve()]


def missing_hooks(policy: Policy) -> list[Path]:
    """Hook scripts the settings layer would register that are not on disk.

    Checked once at sweep startup rather than per run, because the failure it guards is a
    property of the policy tree and identical for every pull request. It has to be checked
    somewhere: a hook that cannot exec does not deny, so a missing script silently removes
    a sandbox rather than failing, and the quoting is only half the defence.
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


def _relocated(policy: Policy, hook: Mapping[str, Any]) -> dict[str, Any]:
    parsed = _hook_script(hook["command"])
    if parsed is None:
        return dict(hook)
    interpreter, script, args = parsed
    argv = [str(_script_path(policy, script)), *args]
    return {
        **hook,
        "command": shlex.join([interpreter, *argv] if interpreter else argv),
    }


def write_settings(policy: Policy, run_dir: Path) -> Path:
    """Write the settings file for one run and return its path."""
    hooks = {
        event: [
            {**entry, "hooks": [_relocated(policy, hook) for hook in entry["hooks"]]}
            for entry in entries
        ]
        for event, entries in _registered_events(policy).items()
    }
    remapper = shlex.join([PYTHON, str(Path(remap.__file__).resolve())])
    hooks.setdefault("PreToolUse", []).append(
        {"matcher": REMAP_MATCHER, "hooks": [{"type": "command", "command": remapper}]}
    )
    settings: dict[str, Any] = {"hooks": hooks}
    if "claudeMdExcludes" in policy.hook_settings:
        settings["claudeMdExcludes"] = policy.hook_settings["claudeMdExcludes"]
    if policy.output_style is not None:
        settings["outputStyle"] = policy.output_style
    path = Path(run_dir) / SETTINGS_FILENAME
    path.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    return path
