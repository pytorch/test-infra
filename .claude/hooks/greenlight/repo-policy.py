#!/usr/bin/env python3
"""The reviewed repository's own review policy: stage it for the reviewer, and keep PRs off it.

A repository keeps its GreenLight review policy at ``.github/greenlight/review.md`` on its default
branch. Three commands, shared by the reviewer workflow (``greenlight-pr-review.yml``) and the policy
replay harness:

- ``stage REPO TRUSTED_CHECKOUT CLAUDE_DIR`` fills the one slot the general policy reads,
  ``CLAUDE_DIR/skills/greenlight-review/repo-policy.md``. The slot is removed first unless REPO is
  pytorch/pytorch, whose built-in policy it holds. The repository's file is read from the git objects
  of TRUSTED_CHECKOUT (a checkout of its default branch), never through the filesystem: ``.github``
  and ``.github/greenlight`` must be trees and ``review.md`` a regular blob, so no symlink on the path
  is ever followed, into the untrusted checkout beside it or anywhere else. A file that passes the
  content checks replaces the slot; one that fails them removes it. An absent file leaves
  pytorch/pytorch on its built-in (checked the same way) and every other repository without a
  policy. Prints ``staged=true`` when the slot holds a checked policy, else ``staged=false``.
- ``touches DIFF_FILE`` prints ``touches=true`` when the unified diff touches ``.github/greenlight``
  or anything under it, or the path ``.github`` itself, on either side of any file, or when a header
  cannot be parsed; else ``touches=false``.
- ``check FILE --repo REPO`` runs the content checks alone, for a repository's own CI.

Problems go to stderr as fixed texts (a section name from this file, a byte count), never as file
content. ``stage`` and ``touches`` exit 0 on every policy outcome and non-zero only on an unexpected
error (bad arguments, git missing or failing), printing nothing to stdout then. Standard library only,
so it runs under the runner's system python3.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import subprocess
import sys
import tempfile
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

PRIMARY_REPO = "pytorch/pytorch"
REPO_RE = re.compile(r"pytorch/[A-Za-z0-9._-]+")
POLICY_DIRS = (".github", "greenlight")
POLICY_NAME = "review.md"
SLOT = ("skills", "greenlight-review", "repo-policy.md")
MAX_BYTES = 65536
REQUIRED_SECTIONS = ("User-facing surface", "Merge-gating workflows", "Lint gate", "Test layout")
META_INTERNAL = "Meta-internal only"

_GUARDED_DIR = "/".join(POLICY_DIRS)
POLICY_PATH = f"{_GUARDED_DIR}/{POLICY_NAME}"
_SECTION_RE = re.compile(r"^## (.+?)[ \t]*\r?$", re.MULTILINE)
_META_INTERNAL_RE = re.compile(rf"^### {META_INTERNAL}[ \t]*\r?$", re.MULTILINE)
_TREE = ("040000", "tree")
_REGULAR_BLOB = ("100644", "blob")


def _require_repo(repo: str) -> str:
    name = repo.partition("/")[2]
    if not REPO_RE.fullmatch(repo) or name in (".", "..") or (repo != PRIMARY_REPO and repo.lower() == PRIMARY_REPO):
        raise ValueError(f"repo {repo!r} is not pytorch/<name>")
    return repo


def content_problems(data: bytes, repo: str) -> list[str]:
    """Every problem of a policy file's bytes for ``repo``, as fixed texts."""
    if len(data) > MAX_BYTES:
        return [f"{len(data)} bytes, over the {MAX_BYTES}-byte cap"]
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return ["not UTF-8"]
    sections = set(_SECTION_RE.findall(text))
    problems = [f"missing the section '## {name}'" for name in REQUIRED_SECTIONS if name not in sections]
    has_meta = _META_INTERNAL_RE.search(text) is not None
    if repo == PRIMARY_REPO and not has_meta:
        problems.append(f"missing the heading '### {META_INTERNAL}', required for {PRIMARY_REPO}")
    elif repo != PRIMARY_REPO and has_meta:
        problems.append(f"the heading '### {META_INTERNAL}' is only for {PRIMARY_REPO}")
    return problems


def _git_env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env["GIT_LITERAL_PATHSPECS"] = "1"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


def _git(checkout: str, *args: str) -> bytes:
    return subprocess.run(  # noqa: S603
        ["git", "-C", checkout, *args],  # noqa: S607
        capture_output=True,
        check=True,
        env=_git_env(),
    ).stdout


def _entry(checkout: str, tree: str, name: str) -> tuple[str, str, str] | None:
    """The mode, type and object of ``name`` directly in ``tree``, or None when it has no such entry."""
    for record in _git(checkout, "ls-tree", "-z", tree, "--", name).split(b"\0"):
        if not record:
            continue
        meta, _, path = record.partition(b"\t")
        mode, kind, obj = meta.decode("ascii").split(" ")
        if path == name.encode():
            return mode, kind, obj
    return None


def read_policy(checkout: str) -> tuple[bytes | None, list[str]]:
    """The policy file's bytes from the checkout's HEAD (None when absent), or the problems of its path."""
    tree = "HEAD"
    for depth, name in enumerate(POLICY_DIRS):
        found = _entry(checkout, tree, name)
        if found is None:
            return None, []
        if found[:2] != _TREE:
            return None, [f"{'/'.join(POLICY_DIRS[: depth + 1])} is not a directory"]
        tree = found[2]
    found = _entry(checkout, tree, POLICY_NAME)
    if found is None:
        return None, []
    if found[:2] != _REGULAR_BLOB:
        return None, ["not a regular file"]
    size = int(_git(checkout, "cat-file", "-s", found[2]))
    if size > MAX_BYTES:
        return None, [f"{size} bytes, over the {MAX_BYTES}-byte cap"]
    return _git(checkout, "cat-file", "blob", found[2]), []


def _remove(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        return


def _write(path: str, data: bytes) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=directory, prefix=".repo-policy-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    except BaseException:
        _remove(temporary)
        raise


def file_problems(path: str, repo: str) -> list[str]:
    """Every problem of the policy file at ``path`` (never followed when it is a symlink) for ``repo``."""
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return ["not a regular file"]
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return ["absent"]
    with os.fdopen(fd, "rb") as handle:
        return content_problems(handle.read(MAX_BYTES + 1), repo)


def stage(repo: str, checkout: str, claude_dir: str) -> tuple[bool, list[str]]:
    """Fill or clear the slot: whether it holds a checked policy, and the problems found."""
    slot = os.path.join(claude_dir, *SLOT)
    if repo != PRIMARY_REPO:
        _remove(slot)
    data, problems = read_policy(checkout)
    source = f"{repo} {POLICY_PATH}"
    if data is None and not problems:
        if repo != PRIMARY_REPO:
            return False, [f"{source}: absent"]
        source, problems = "the built-in policy", file_problems(slot, repo)
    elif data is not None:
        problems = content_problems(data, repo)
    if problems:
        _remove(slot)
        return False, [f"{source}: {problem}" for problem in problems]
    if data is not None:
        _write(slot, data)
    return True, []


_ESCAPES = {"a": 7, "b": 8, "t": 9, "n": 10, "v": 11, "f": 12, "r": 13, '"': 34, "\\": 92}


def _unquote(text: str, start: int) -> tuple[str, int]:
    """The git C-style quoted path starting at ``text[start] == '"'``, and the index past its closing quote."""
    out = bytearray()
    index = start + 1
    while index < len(text):
        char = text[index]
        if char == '"':
            return out.decode("utf-8", "surrogateescape"), index + 1
        if char != "\\":
            out += char.encode("utf-8", "surrogateescape")
            index += 1
            continue
        escape = text[index + 1 : index + 2]
        if escape in _ESCAPES:
            out.append(_ESCAPES[escape])
            index += 2
        elif re.fullmatch(r"[0-3][0-7]{2}", text[index + 1 : index + 4]):
            out.append(int(text[index + 1 : index + 4], 8))
            index += 4
        else:
            raise ValueError("bad escape in a quoted path")
    raise ValueError("unterminated quoted path")


def _path(value: str, prefix: str) -> str:
    """One whole header value: ``<prefix>path``, its quoted form, or ``/dev/null`` (as '')."""
    if value == "/dev/null":
        return ""
    if value.startswith('"'):
        unquoted, end = _unquote(value, 0)
        if end != len(value):
            raise ValueError("text after a quoted path")
        value = unquoted
    if not value.startswith(prefix):
        raise ValueError("a path without its prefix")
    return value[len(prefix) :]


def _git_line_paths(rest: str) -> list[str]:
    """Every reading of ``diff --git``'s ``a/X b/Y``: an unquoted pair splits at any ' b/'."""
    if rest.startswith('"'):
        first, end = _unquote(rest, 0)
        if rest[end : end + 1] != " ":
            raise ValueError("no second path")
        return [_path(first, "a/"), _path(rest[end + 1 :], "b/")]
    paths: list[str] = []
    for split in [match.start() for match in re.finditer(' (?="?b/)', rest)]:
        try:
            paths += [_path(rest[:split], "a/"), _path(rest[split + 1 :], "b/")]
        except ValueError:
            continue
    if not paths:
        raise ValueError("unparseable diff --git line")
    return paths


_HEADER_KEYWORDS = ("rename from ", "rename to ", "copy from ", "copy to ")


def _guarded(path: str) -> bool:
    return path in (POLICY_DIRS[0], _GUARDED_DIR) or path.startswith(_GUARDED_DIR + "/")


def diff_paths(diff: str) -> list[str]:
    """Every path the diff's file headers name; ``ValueError`` on a header it cannot read.

    Hunk lines always start with a space, ``+``, ``-`` or ``\\``, so none can pass for a ``diff --git``
    line; the other header lines are read only between that line and the file's first hunk.
    """
    paths: list[str] = []
    state = "preamble"
    for line in diff.split("\n"):
        line = line.removesuffix("\r")
        if line.startswith("diff --git "):
            paths += _git_line_paths(line[len("diff --git ") :])
            state = "header"
        elif state == "preamble":
            if line.strip():
                raise ValueError("text before the first diff --git line")
        elif state == "hunk":
            continue
        elif line.startswith("@@"):
            state = "hunk"
        elif line.startswith(("--- ", "+++ ")):
            paths.append(_path(line[4:].removesuffix("\t"), "a/" if line[0] == "-" else "b/"))
        elif keyword := next((word for word in _HEADER_KEYWORDS if line.startswith(word)), None):
            paths.append(_path(line[len(keyword) :], ""))
    return paths


def touches(diff: bytes) -> bool:
    try:
        return any(_guarded(path) for path in diff_paths(diff.decode("utf-8", "surrogateescape")))
    except ValueError:
        return True


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="repo-policy.py", description="The reviewed repository's own review policy.")
    commands = parser.add_subparsers(dest="command", required=True)
    staging = commands.add_parser("stage", help="fill or clear the repository-policy slot")
    staging.add_argument("repo")
    staging.add_argument("trusted_checkout")
    staging.add_argument("claude_dir")
    touching = commands.add_parser("touches", help="whether a diff touches the repository's GreenLight files")
    touching.add_argument("diff_file")
    checking = commands.add_parser("check", help="run the content checks on a policy file")
    checking.add_argument("file")
    checking.add_argument("--repo", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "touches":
            with open(args.diff_file, "rb") as handle:
                verdict = touches(handle.read())
            print(f"touches={'true' if verdict else 'false'}")
            return 0
        repo = _require_repo(args.repo)
        if args.command == "check":
            problems = file_problems(args.file, repo)
        else:
            staged, problems = stage(repo, args.trusted_checkout, args.claude_dir)
        for problem in problems:
            print(f"repo-policy: {problem}", file=sys.stderr)
        if args.command == "check":
            return 1 if problems else 0
        print(f"staged={'true' if staged else 'false'}")
        return 0
    except Exception as exc:
        print(f"repo-policy: unexpected error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
