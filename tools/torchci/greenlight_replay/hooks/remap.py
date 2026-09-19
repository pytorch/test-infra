#!/usr/bin/env python3
"""PreToolUse hook: give each concurrent replay run its own copy of the scratch paths.

The greenlight-review skill names three absolute paths -- ``/tmp/greenlight-pr.diff``,
``/tmp/greenlight-pr.json`` and ``/tmp/greenlight-verdict.json``. In CI that is safe,
because a runner hosts exactly one review. A replay runs many reviewers at once on one
machine, where those three globals would have the reviewers reading each other's diffs and
overwriting each other's verdicts. The skill is the artifact under test, so it cannot be
edited to fix this; instead every ``Read``, ``Write``, ``Glob`` or ``Grep`` naming one of the three is rewritten,
via the PreToolUse ``updatedInput`` mechanism, to the same basename inside the per-run
directory named by ``$GREENLIGHT_REPLAY_RUN_DIR``.

Two separate gatekeepers judge the same tool call, and they judge DIFFERENT paths. Measured
on CLI 2.1.267, 2026-09-18, with a third observer hook recording what it was handed:

* ``updatedInput`` is NOT chained between hooks. Every PreToolUse hook on a call receives
  the original event, whatever an earlier hook returned, and the rewrite is applied once
  after all of them have run -- and only if none denied, because a deny outranks an allow.
  ``restrict-read.py`` and ``restrict-write.sh`` therefore judge the un-remapped
  ``/tmp/greenlight-*`` path, which both already permit; that is what lets this rewrite be
  additive instead of a fork of the production hooks.
* ``--restricted`` is enforced AFTER the rewrite, against the REWRITTEN path. It is the
  gatekeeper the remapped path actually has to satisfy, and it confines the file tools to
  the ``--add-dir`` roots -- so the run directory must be passed as its own ``--add-dir``.
  It is a sibling of the reviewer's workspace, not a child, so adding the workspace does not
  cover it, and without it every read of the diff fails with "outside the allowed working
  directories".

Because the read sandbox never sees the rewritten path, keeping the run directory under
``restrict-read.py``'s scratch prefix (``realpath('/tmp') + '/greenlight-'``, a plain string
prefix, so any nesting beneath it passes) is defence in depth rather than load-bearing
today: it is what makes the design survive a future CLI that does chain ``updatedInput``,
where a run directory outside the prefix would instead deny every read.
``run_dir_violation`` holds the two together -- this hook refuses to run at all against a
directory the read sandbox would reject, so a divergence surfaces as a loud refusal rather
than as a review conducted with no inputs.

One thing this hook deliberately does not rescue. A corporate ``llm-rules`` SessionStart
hook injects context telling the model to read a file under
``~/.claude/projects/<slug>/<session>/tool-results/``. That path can never satisfy
``restrict-read.py``, and because a deny wins over an allow no rewrite here can make the
read succeed -- the reviewer is instead told, through the harness's appended system prompt,
that no such file applies to it. The denial itself is harmless; it costs one turn.
"""

from __future__ import annotations

import json
import os
import sys


__all__ = [
    "DIFF_BASENAME",
    "METADATA_BASENAME",
    "REMAPPED_BASENAMES",
    "RUN_DIR_ENV",
    "VERDICT_BASENAME",
    "remapped_path",
    "run_dir_violation",
    "scratch_prefix",
]

RUN_DIR_ENV = "GREENLIGHT_REPLAY_RUN_DIR"

# Kept equal to the paths the greenlight-review skill names. A basename that the skill
# starts using but that is missing here is not an error the model reports: the run simply
# shares that file with every other concurrent run. These are restated rather than imported
# from ``inputs`` because this module is executed as a bare script by the reviewer, under a
# python3 that has no torchci on its path; ``runner`` asserts the two agree.
DIFF_BASENAME = "greenlight-pr.diff"
METADATA_BASENAME = "greenlight-pr.json"
VERDICT_BASENAME = "greenlight-verdict.json"

REMAPPED_BASENAMES = (DIFF_BASENAME, METADATA_BASENAME, VERDICT_BASENAME)

_SCRATCH_BASENAME_PREFIX = "greenlight-"

# Read and Write name a scratch file through "file_path"; Glob and Grep name a search root
# through "path". Both are rewritten: restrict-read.py admits any /tmp/greenlight-* target,
# so a search left un-remapped would reach the SHARED /tmp rather than this run's directory.
_PATH_FIELD_BY_TOOL = {
    "Read": "file_path",
    "Write": "file_path",
    "Glob": "path",
    "Grep": "path",
}


def scratch_prefix() -> str:
    """The prefix ``restrict-read.py`` accepts, resolved the same way it resolves it.

    /tmp is a symlink on macOS, so the realpath is what a target path is compared against.
    """
    return os.path.realpath("/tmp") + os.sep + _SCRATCH_BASENAME_PREFIX  # noqa: S108


def _originals() -> dict[str, str]:
    return {f"/tmp{os.sep}{name}": name for name in REMAPPED_BASENAMES}  # noqa: S108


def run_dir_violation(run_dir: str) -> str | None:
    """Why ``run_dir`` is unusable as a remap target, or None when it is usable."""
    if not run_dir:
        return f"{RUN_DIR_ENV} is unset"
    if not os.path.isabs(run_dir):
        return f"{RUN_DIR_ENV} must be an absolute path, got {run_dir!r}"
    resolved = os.path.realpath(run_dir)
    prefix = scratch_prefix()
    if not resolved.startswith(prefix):
        return (
            f"{RUN_DIR_ENV}={run_dir!r} resolves to {resolved!r}, which is outside the "
            f"read sandbox's allowed scratch prefix {prefix!r}; every remapped read would "
            "be denied"
        )
    return None


def remapped_path(run_dir: str, original: str) -> str | None:
    """The per-run stand-in for one of the skill's three globals, else None."""
    basename = _originals().get(original)
    if basename is None:
        return None
    return os.path.join(os.path.realpath(run_dir), basename)


def _deny(reason: str) -> int:
    print(reason, file=sys.stderr)
    return 2


def _allow_with(tool_input: dict[str, object], field: str, target: str) -> int:
    # updatedInput replaces the ENTIRE tool input, so every original field is copied and the
    # path set last: Write's content must survive, and no supplied field may win.
    updated = dict(tool_input)
    updated[field] = target
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "greenlight replay per-run scratch path",
                    "updatedInput": updated,
                }
            }
        )
    )
    return 0


def _handle(raw_event: str) -> int:
    try:
        event = json.loads(raw_event)
    except (json.JSONDecodeError, ValueError) as exc:
        return _deny(f"remap blocked: unparseable hook event ({exc}).")
    if not isinstance(event, dict):
        return _deny("remap blocked: hook event is not a JSON object.")

    tool_name = event.get("tool_name")
    if not isinstance(tool_name, str):
        return 0
    field = _PATH_FIELD_BY_TOOL.get(tool_name)
    if field is None:
        return 0

    run_dir = os.environ.get(RUN_DIR_ENV, "")
    violation = run_dir_violation(run_dir)
    if violation is not None:
        return _deny(f"remap blocked: {violation}.")

    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    named = tool_input.get(field)
    if not isinstance(named, str):
        return 0
    target = remapped_path(run_dir, named)
    if target is None:
        return 0
    return _allow_with(tool_input, field, target)


def main() -> int:
    try:
        return _handle(sys.stdin.read())
    except Exception as exc:
        # Sharing a scratch path across concurrent reviews corrupts both of them, so an
        # unexpected fault here blocks rather than letting the call through unremapped.
        return _deny(f"remap blocked: unexpected error: {exc!r}")


if __name__ == "__main__":
    raise SystemExit(main())
