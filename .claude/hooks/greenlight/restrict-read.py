#!/usr/bin/env python3
"""PreToolUse hook: confine the reviewer's Read/Glob/Grep to the reviewed checkout.

Read/Glob/Grep are otherwise unrestricted by path, so the untrusted model could read the
OIDC credentials in /proc/self/environ or $GITHUB_ENV and the scoped checkout token in
./pytorch/.git/config. This is deny-by-default: a target is allowed only when its
os.path.realpath (symlinks and '..' resolved, because the ./pytorch tree is attacker-
controlled) lands under an allowed root with an os.sep boundary, and never when the resolved
path carries a .git component. exit 2 blocks with a stderr reason; exit 0 defers to the normal
permission flow. Depends only on the standard library so it runs under the CI system python3,
and fails closed on ANY error: claude-code-action treats every non-2 exit as non-blocking, so
main() converts any unexpected exception into a blocking exit 2.
"""

from __future__ import annotations

import json
import os
import sys

_SCRATCH_BASENAME_PREFIX = "greenlight-"
_ALLOWED_DESC = "./pytorch, ./.claude/skills, ./.claude/hooks, and /tmp/greenlight-* scratch"


def _deny(reason: str) -> int:
    print(reason, file=sys.stderr)
    return 2


def _scratch_prefix() -> str:
    # /tmp is a symlink on macOS (-> /private/tmp); realpath it so this prefix matches the
    # realpath of the target on both the CI runner (/tmp) and dev machines (/private/tmp).
    return os.path.realpath("/tmp") + os.sep + _SCRATCH_BASENAME_PREFIX  # noqa: S108


def _allowed_roots(workspace: str) -> list[str]:
    roots = [
        os.path.join(workspace, "pytorch"),
        os.path.join(workspace, ".claude", "skills"),
        os.path.join(workspace, ".claude", "hooks"),
    ]
    return [os.path.realpath(root) for root in roots]


def _under_root(resolved: str, root: str) -> bool:
    return resolved == root or resolved.startswith(root + os.sep)


def _reject_dotdot(field: str, value: str) -> int:
    if ".." in value:
        return _deny(f"read blocked: '..' is not allowed in {field}.")
    return 0


def _reject_glob_syntax(field: str, value: object) -> int:
    # pattern (Glob) / glob (Grep) are glob syntax, not paths: a '..' or a leading '/' escapes the
    # confined search path. Grep's 'pattern' is a search regex where '..' is legitimate ("any two
    # chars"), so it is never routed here.
    if not isinstance(value, str):
        return 0
    denied = _reject_dotdot(field, value)
    if denied:
        return denied
    if value.startswith("/"):
        return _deny(f"read blocked: an absolute {field} is not allowed; pass a relative glob under ./pytorch.")
    return 0


def _check_target(target: str, workspace: str) -> int:
    resolved = os.path.realpath(target)
    # Lowercase the components: a case-insensitive filesystem serves ./pytorch/.GIT/config too.
    if ".git" in [part.lower() for part in resolved.split(os.sep)]:
        return _deny(f"read blocked: '.git' is off-limits ({resolved}).")
    if resolved.startswith(_scratch_prefix()):
        return 0
    if any(_under_root(resolved, root) for root in _allowed_roots(workspace)):
        return 0
    return _deny(f"read blocked: {resolved} is outside the allowed roots ({_ALLOWED_DESC}).")


def _check_read(tool_input: dict[str, object], workspace: str) -> int:
    file_path = tool_input.get("file_path")
    if not isinstance(file_path, str) or not file_path:
        return _deny("read blocked: Read requires a file_path under ./pytorch.")
    denied = _reject_dotdot("file_path", file_path)
    if denied:
        return denied
    return _check_target(file_path, workspace)


def _check_search_path(tool_input: dict[str, object], workspace: str) -> int:
    path = tool_input.get("path")
    if not isinstance(path, str) or not path:
        return _deny(f"read blocked: reads are confined to {_ALLOWED_DESC}; pass an explicit path under ./pytorch.")
    denied = _reject_dotdot("path", path)
    if denied:
        return denied
    return _check_target(path, workspace)


def _check_glob(tool_input: dict[str, object], workspace: str) -> int:
    denied = _reject_glob_syntax("pattern", tool_input.get("pattern"))
    if denied:
        return denied
    return _check_search_path(tool_input, workspace)


def _check_grep(tool_input: dict[str, object], workspace: str) -> int:
    denied = _reject_glob_syntax("glob", tool_input.get("glob"))
    if denied:
        return denied
    return _check_search_path(tool_input, workspace)


def _handle(raw_event: str) -> int:
    try:
        event = json.loads(raw_event)
    except (json.JSONDecodeError, ValueError) as exc:
        return _deny(f"read blocked: unparseable hook event ({exc}).")
    if not isinstance(event, dict):
        return _deny("read blocked: hook event is not a JSON object.")

    workspace = os.environ.get("GITHUB_WORKSPACE", "")
    if not workspace:
        return _deny("read blocked: GITHUB_WORKSPACE is unset.")

    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}

    tool_name = event.get("tool_name")
    if tool_name == "Read":
        return _check_read(tool_input, workspace)
    if tool_name == "Glob":
        return _check_glob(tool_input, workspace)
    if tool_name == "Grep":
        return _check_grep(tool_input, workspace)
    return _deny(f"read blocked: unsupported tool {tool_name!r}.")


def main() -> int:
    try:
        return _handle(sys.stdin.read())
    except Exception as exc:  # every non-2 exit is non-blocking upstream, so any error must deny
        return _deny(f"read blocked: unexpected error: {exc!r}")


if __name__ == "__main__":
    raise SystemExit(main())
