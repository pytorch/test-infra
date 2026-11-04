"""The query side: a PR's diff against its base, split into hunk chunks."""

import http.client
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import urllib.request
from pathlib import Path
from typing import Optional


logger = logging.getLogger(__name__)

GIT_TIMEOUT_SECONDS = 120
DIFF_MAX_BYTES = 20 * 1024 * 1024
API_TIMEOUT_SECONDS = 30
API_MAX_BYTES = 5 * 1024 * 1024
GITHUB_REPO = "pytorch/pytorch"
CHUNK_CHARS = 2000
DEFAULT_BRANCH = "origin/main"
PARENT_OF_HEAD = "HEAD^"
SOURCE_EXTENSIONS = (
    ".py",
    ".pyi",
    ".cpp",
    ".cc",
    ".c",
    ".h",
    ".hpp",
    ".cu",
    ".cuh",
    ".mm",
    ".m",
)
EXCLUDED_PREFIXES = ("third_party/",)
# Pin every diff.* setting that changes the hunks or the paths git prints, so a
# local git configuration cannot change the chunks.
DIFF_CONFIG = [
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    "diff.srcPrefix=a/",
    "diff.dstPrefix=b/",
    "diff.algorithm=myers",
    "diff.interHunkContext=0",
    "diff.submodule=short",
    "diff.renames=true",
    "diff.relative=false",
    "diff.suppressBlankEmpty=false",
    f"diff.orderFile={os.devnull}",
]

# Anchored with \A and \Z, so match, fullmatch and search all mean "the whole string".
SHA_RE = re.compile(r"\A[0-9a-f]{40}\Z")

_REF = re.compile(r"[A-Za-z0-9._/-]+")
_PR_DIGITS = re.compile(r"[0-9]+")
_TAG_PR = re.compile(r"refs/tags/.*/(\d+)", re.ASCII)
_DIFF_HEADER = "diff --git "
_STANZA = re.compile(r"(?m)^(?=diff --git )")
_HUNK = re.compile(r"(?m)^(?=@@ )")
_QUOTED_ESCAPE = re.compile(rb"\\([0-7]{3}|.)")
_QUOTED_CHARS = {b"a": 7, b"b": 8, b"t": 9, b"n": 10, b"v": 11, b"f": 12, b"r": 13}


class DiffError(RuntimeError):
    pass


def _is_ref(value: str) -> bool:
    return bool(_REF.fullmatch(value)) and not value.startswith("-")


def _checked_ref(value: str) -> str:
    if not _is_ref(value):
        raise ValueError(f"refusing git ref or sha {value!r}")
    return value


def _checked_rev(value: str) -> str:
    return value if value == PARENT_OF_HEAD else _checked_ref(value)


def git(
    repo: Path,
    *args: str,
    timeout: float = GIT_TIMEOUT_SECONDS,
    check: bool = True,
    stdin: Optional[str] = None,
) -> "subprocess.CompletedProcess[str]":
    """Run `git -C repo <args>` and capture its output as text."""
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        input=stdin,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=timeout,
        check=check,
    )


def git_diff(repo: Path, base: str, head: str = "HEAD") -> str:
    """`git diff <base> <head>`, keeping the first DIFF_MAX_BYTES of a larger diff."""
    command = ["git", "-C", str(repo)]
    for setting in DIFF_CONFIG:
        command += ["-c", setting]
    command += ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3"]
    command += ["--end-of-options", _checked_rev(base), _checked_rev(head)]
    timed_out = threading.Event()
    with tempfile.TemporaryFile() as stderr, subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=stderr
    ) as proc:

        def kill() -> None:
            timed_out.set()
            proc.kill()

        timer = threading.Timer(GIT_TIMEOUT_SECONDS, kill)
        timer.start()
        try:
            assert proc.stdout is not None
            out = proc.stdout.read(DIFF_MAX_BYTES)
            truncated = bool(proc.stdout.read(1))
            if truncated:
                proc.kill()
            proc.wait()
        finally:
            timer.cancel()
        if timed_out.is_set():
            raise DiffError(f"git diff timed out after {GIT_TIMEOUT_SECONDS}s")
        if not truncated and proc.returncode != 0:
            stderr.seek(0)
            message = stderr.read().decode("utf-8", errors="replace").strip()
            raise DiffError(f"git diff {base} {head} failed: {message[-500:]}")
    if truncated:
        logger.warning("diff longer than %d bytes, keeping the start", DIFF_MAX_BYTES)
    return out.decode("utf-8", errors="replace")


def _unquote(name: str) -> str:
    """A path as git prints it: C-quoted, with octal UTF-8 bytes, when unusual."""
    if not (len(name) >= 2 and name[0] == name[-1] == '"'):
        return name
    raw = _QUOTED_ESCAPE.sub(
        lambda m: (
            bytes([int(m[1], 8)])
            if len(m[1]) == 3
            else bytes([_QUOTED_CHARS.get(m[1], m[1][0])])
        ),
        name[1:-1].encode(),
    )
    return raw.decode("utf-8", errors="replace")


def _side(name: str) -> str:
    """The path of a `---`/`+++` name: no a/ or b/ prefix, "" for /dev/null."""
    # git ends the name with a tab when the path holds a space.
    name = name.rstrip("\t")
    if name == "/dev/null":
        return ""
    path = _unquote(name)
    return path[2:] if path[:2] in ("a/", "b/") else path


def _header_path(header: str) -> str:
    """The path of a `diff --git a/P b/P` line, "" when its two sides differ."""
    names = header[len(_DIFF_HEADER) :]
    middle = len(names) // 2
    if len(names) % 2 and names[middle] == " ":
        old, new = _side(names[:middle]), _side(names[middle + 1 :])
        if old == new:
            return old
    return ""


def _stanzas(diff: str) -> list[str]:
    return [s for s in _STANZA.split(diff) if s.startswith(_DIFF_HEADER)]


def _stanza_paths(stanza: str) -> tuple[str, str]:
    """(old path, new path) of a file stanza, read only from its extended header,
    never from hunk bodies; "" for the missing side of an addition or deletion."""
    header, _, rest = stanza.partition("\n")
    old: Optional[str] = None
    new: Optional[str] = None
    for line in rest.split("\n"):
        if line.startswith("@@ "):
            break
        if line.startswith("--- "):
            old = _side(line[4:])
        elif line.startswith("+++ "):
            new = _side(line[4:])
        elif line.startswith("rename from "):
            old = _unquote(line[len("rename from ") :])
        elif line.startswith("rename to "):
            new = _unquote(line[len("rename to ") :])
    if old is None and new is None:
        old = new = _header_path(header)
    return old or "", new or ""


def changed_paths(diff: str) -> list[str]:
    """Every path the diff's file stanzas touch, old and new sides, sorted."""
    paths = {path for stanza in _stanzas(diff) for path in _stanza_paths(stanza)}
    paths.discard("")
    return sorted(paths)


def query_chunks(diff: str, max_chunks: int = 64) -> list[str]:
    """One chunk per hunk (led by its file's `diff --git` line), source files first,
    round-robin across files so every file's first hunk comes before any second."""
    source: list[list[str]] = []
    other: list[list[str]] = []
    for stanza in _stanzas(diff):
        hunks = _HUNK.split(stanza)[1:]
        old, new = _stanza_paths(stanza)
        path = new or old
        if not hunks or path.startswith(EXCLUDED_PREFIXES):
            continue
        header = stanza.split("\n", 1)[0]
        chunks = [f"{header}\n{hunk}"[:CHUNK_CHARS] for hunk in hunks]
        (source if path.endswith(SOURCE_EXTENSIONS) else other).append(chunks)
    files = source + other
    result: list[str] = []
    depth = 0
    while len(result) < max_chunks and any(depth < len(f) for f in files):
        for chunks in files:
            if depth < len(chunks) and len(result) < max_chunks:
                result.append(chunks[depth])
        depth += 1
    return result


def pr_number_from(event_pr: Optional[str], github_ref: Optional[str]) -> Optional[int]:
    """The PR number of the event, else of a ciflow tag ref (refs/tags/<...>/<N>)."""
    if event_pr:
        if not _PR_DIGITS.fullmatch(event_pr):
            raise ValueError(f"not a PR number: {event_pr!r}")
        return int(event_pr)
    match = _TAG_PR.fullmatch(github_ref or "")
    return int(match.group(1)) if match else None


def pr_base_from_api(pr_number: int, token: Optional[str]) -> tuple[str, Optional[str]]:
    """The PR's (base ref, base sha) from the GitHub REST API. The ref is returned as
    given: resolve_base skips one that is not a usable ref and keeps the sha."""
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}/pulls/{int(pr_number)}",
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=API_TIMEOUT_SECONDS) as response:
        body = response.read(API_MAX_BYTES + 1)
    if len(body) > API_MAX_BYTES:
        raise ValueError(f"GitHub API response over {API_MAX_BYTES} bytes")
    try:
        base = json.loads(body)["base"]
        ref, sha = base["ref"], base.get("sha")
    except (KeyError, TypeError) as e:
        raise ValueError(f"unexpected GitHub API response: {e!r}") from None
    if not isinstance(ref, str):
        raise ValueError("unexpected GitHub API response: base ref is not a string")
    if sha is not None and not (isinstance(sha, str) and SHA_RE.fullmatch(sha)):
        raise ValueError(f"GitHub API base sha is not 40 hex characters: {sha!r}")
    return ref, sha


def _merge_base(repo: Path, rev: str) -> Optional[str]:
    proc = git(
        repo, "merge-base", "--end-of-options", _checked_ref(rev), "HEAD", check=False
    )
    return proc.stdout.strip() if proc.returncode == 0 else None


def _default_merge_base(repo: Path) -> str:
    merge_base = _merge_base(repo, DEFAULT_BRANCH)
    if merge_base is None:
        raise DiffError(f"git merge-base {DEFAULT_BRANCH} HEAD failed")
    return merge_base


def resolve_base(
    repo: Path,
    pr_number: Optional[int],
    base_ref: Optional[str],
    base_sha: Optional[str],
    token: Optional[str],
) -> str:
    """The commit to diff HEAD against, as pytorch TD's get_merge_base finds it,
    without its compare-API step."""
    if pr_number is None:
        merge_base = _default_merge_base(repo)
        head = git(repo, "rev-parse", "--verify", "HEAD", check=False)
        if head.returncode != 0:
            raise DiffError("git rev-parse HEAD failed")
        return PARENT_OF_HEAD if merge_base == head.stdout.strip() else merge_base
    if not base_ref and not base_sha:
        try:
            base_ref, base_sha = pr_base_from_api(pr_number, token)
        except (OSError, http.client.HTTPException, ValueError) as e:
            # Diffing against main still gives a usable, if wider, query.
            logger.warning("no base for PR %d from the GitHub API: %s", pr_number, e)
    candidates: list[str] = []
    for value, prefix in [(base_ref, "origin/"), (base_sha, "")]:
        if value and _is_ref(value):
            candidates.append(prefix + value)
        elif value:
            # An unusable base still leaves the default branch to diff against.
            logger.warning("ignoring the PR base %r: not a git ref or sha", value)
    for candidate in candidates:
        found = _merge_base(repo, candidate)
        if found is not None:
            return found
    return _default_merge_base(repo)
