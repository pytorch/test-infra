#!/usr/bin/env python3
"""PreToolUse hook: confine the reviewer's Read/Glob/Grep to the reviewed checkout.

The reviewed checkout is the workspace directory named by the optional first argument: absent
means ./pytorch, and only the literals "pytorch" and "target" are accepted; any other argument
denies every read. Read/Glob/Grep are otherwise unrestricted by path, so the untrusted model
could read the OIDC credentials in /proc/self/environ or $GITHUB_ENV and the scoped checkout
token in the checkout's .git/config. This is deny-by-default: a target is allowed only when its
os.path.realpath (symlinks and '..' resolved, because the checkout tree is attacker-
controlled) lands under an allowed root with an os.sep boundary, and never when the resolved
path carries a .git component. exit 2 blocks with a stderr reason; exit 0 allows — silently deferring to the normal
permission flow, except a path-less Glob/Grep, which exits 0 with an "allow" decision that
rewrites the search path (see below). Read and an explicit Glob/Grep path stay deny-by-default; a path-less
Glob/Grep is not denied but rewritten to search the checkout via an exit-0
hookSpecificOutput.updatedInput "allow" decision. That rewrite relies on the reviewer CLI
honoring updatedInput; a CLI that ignored it would fall back to a workspace-root search.
Depends only on the standard library so it runs under the CI system python3, and fails closed
on ANY error: claude-code-action treats every non-2 exit as non-blocking, so main() converts
any unexpected exception into a blocking exit 2.
"""

from __future__ import annotations

import json
import os
import sys
from typing import NamedTuple

_SCRATCH_BASENAME_PREFIX = "greenlight-"
_DEFAULT_CHECKOUT = "pytorch"
_CHECKOUTS = ("pytorch", "target")


class _Scope(NamedTuple):
    workspace: str
    checkout: str

    @property
    def checkout_dir(self) -> str:
        return os.path.join(self.workspace, self.checkout)

    @property
    def allowed_desc(self) -> str:
        return f"./{self.checkout}, ./.claude/skills, ./.claude/hooks, and /tmp/greenlight-* scratch"


def _deny(reason: str) -> int:
    print(reason, file=sys.stderr)
    return 2


def _scratch_prefix() -> str:
    # /tmp is a symlink on macOS (-> /private/tmp); realpath it so this prefix matches the
    # realpath of the target on both the CI runner (/tmp) and dev machines (/private/tmp).
    return os.path.realpath("/tmp") + os.sep + _SCRATCH_BASENAME_PREFIX  # noqa: S108


def _checkout_arg(argv: list[str]) -> str | None:
    """The checkout directory the arguments name, or None when they name none of the accepted ones."""
    if not argv:
        return _DEFAULT_CHECKOUT
    if len(argv) == 1 and argv[0] in _CHECKOUTS:
        return argv[0]
    return None


def _allowed_roots(scope: _Scope) -> list[str]:
    roots = [
        scope.checkout_dir,
        os.path.join(scope.workspace, ".claude", "skills"),
        os.path.join(scope.workspace, ".claude", "hooks"),
    ]
    return [os.path.realpath(root) for root in roots]


def _under_root(resolved: str, root: str) -> bool:
    return resolved == root or resolved.startswith(root + os.sep)


def _reject_dotdot(field: str, value: str) -> int:
    if ".." in value:
        return _deny(f"read blocked: '..' is not allowed in {field}.")
    return 0


def _reject_glob_syntax(field: str, value: object, scope: _Scope) -> int:
    # pattern (Glob) / glob (Grep) are glob syntax, not paths: a '..' or a leading '/' escapes the
    # confined search path. Grep's 'pattern' is a search regex where '..' is legitimate ("any two
    # chars"), so it is never routed here.
    if not isinstance(value, str):
        return 0
    denied = _reject_dotdot(field, value)
    if denied:
        return denied
    if value.startswith("/"):
        return _deny(
            f"read blocked: an absolute {field} is not allowed; pass a relative glob under ./{scope.checkout}."
        )
    return 0


def _check_target(target: str, scope: _Scope) -> int:
    resolved = os.path.realpath(target)
    # Lowercase the components: a case-insensitive filesystem serves a checkout's .GIT/config too.
    if ".git" in [part.lower() for part in resolved.split(os.sep)]:
        return _deny(f"read blocked: '.git' is off-limits ({resolved}).")
    if resolved.startswith(_scratch_prefix()):
        return 0
    if any(_under_root(resolved, root) for root in _allowed_roots(scope)):
        return 0
    return _deny(f"read blocked: {resolved} is outside the allowed roots ({scope.allowed_desc}).")


def _check_read(tool_input: dict[str, object], scope: _Scope) -> int:
    file_path = tool_input.get("file_path")
    if not isinstance(file_path, str) or not file_path:
        return _deny(f"read blocked: Read requires a file_path under ./{scope.checkout}.")
    denied = _reject_dotdot("file_path", file_path)
    if denied:
        return denied
    return _check_target(file_path, scope)


def _allow_with_default_path(tool_input: dict[str, object], scope: _Scope) -> int:
    # updatedInput replaces the ENTIRE tool input, so copy every original field and set
    # 'path' last (an attacker-supplied empty/junk path cannot survive). Absolute, not
    # CWD-relative, so the search root is pinned to the checkout regardless of the tool's
    # working directory and matches the checkout's allowed root by construction.
    updated = dict(tool_input)
    updated["path"] = scope.checkout_dir
    decision = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": f"path-less Glob/Grep defaulted to ./{scope.checkout}",
            "updatedInput": updated,
        }
    }
    print(json.dumps(decision))
    return 0


def _check_search_path(tool_input: dict[str, object], scope: _Scope) -> int:
    path = tool_input.get("path")
    if not isinstance(path, str) or not path:
        return _allow_with_default_path(tool_input, scope)
    denied = _reject_dotdot("path", path)
    if denied:
        return denied
    return _check_target(path, scope)


def _check_glob(tool_input: dict[str, object], scope: _Scope) -> int:
    denied = _reject_glob_syntax("pattern", tool_input.get("pattern"), scope)
    if denied:
        return denied
    return _check_search_path(tool_input, scope)


def _check_grep(tool_input: dict[str, object], scope: _Scope) -> int:
    denied = _reject_glob_syntax("glob", tool_input.get("glob"), scope)
    if denied:
        return denied
    return _check_search_path(tool_input, scope)


def _handle(raw_event: str, argv: list[str]) -> int:
    checkout = _checkout_arg(argv)
    if checkout is None:
        return _deny(f"read blocked: the checkout argument {argv!r} is not one of {list(_CHECKOUTS)}.")
    try:
        event = json.loads(raw_event)
    except (json.JSONDecodeError, ValueError) as exc:
        return _deny(f"read blocked: unparseable hook event ({exc}).")
    if not isinstance(event, dict):
        return _deny("read blocked: hook event is not a JSON object.")

    workspace = os.environ.get("GITHUB_WORKSPACE", "")
    if not workspace:
        return _deny("read blocked: GITHUB_WORKSPACE is unset.")
    scope = _Scope(workspace, checkout)

    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}

    tool_name = event.get("tool_name")
    if tool_name == "Read":
        return _check_read(tool_input, scope)
    if tool_name == "Glob":
        return _check_glob(tool_input, scope)
    if tool_name == "Grep":
        return _check_grep(tool_input, scope)
    return _deny(f"read blocked: unsupported tool {tool_name!r}.")


def main() -> int:
    try:
        return _handle(sys.stdin.read(), sys.argv[1:])
    except Exception as exc:  # every non-2 exit is non-blocking upstream, so any error must deny
        return _deny(f"read blocked: unexpected error: {exc!r}")


if __name__ == "__main__":
    raise SystemExit(main())
