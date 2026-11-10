"""Read-only git access to the pytorch clone for the scorer's context: a change's files,
significant line counts and commit messages, diffed the way pytorch's TD job diffs it."""

import re
import subprocess
from pathlib import Path
from typing import Any, Optional

from torchci.td.llm import pytorch_repo
from torchci.td.llm.diff import SHA_RE
from torchci.td.scorer import spec


GIT_BATCH = 1000
REVERT_SUBJECTS = ("Revert ", "Back out")
REVERTS_RE = re.compile(r"This reverts commit ([0-9a-f]{40})")
# The ref the clone's copy of pytorch main is read from: the remote-tracking branch of
# a fresh clone, else a local branch (explicit refs: a tag named main would win over
# the bare name).
MAIN_REFS = ("refs/remotes/origin/main", "refs/heads/main")


def significant(path: str) -> bool:
    return not path.startswith(spec.NON_SIGNIFICANT_PREFIXES) and not path.endswith(
        spec.NON_SIGNIFICANT_SUFFIXES
    )


def numstat_change(tokens_text: str) -> dict[str, Any]:
    """One change's `--numstat -z -M` records -> its changed paths (a rename as its new
    path, as `git diff --name-only` lists it) and the added / deleted lines of its
    significant paths (binary files count 0)."""
    tokens = iter(tokens_text.lstrip("\n").split("\0"))
    files, added, deleted = [], 0, 0
    for token in tokens:
        parts = token.lstrip("\n").split("\t", 2)
        if len(parts) != 3:
            continue
        a, d, path = parts
        if not path:
            next(tokens, "")
            path = next(tokens, "")
        files.append(path)
        if significant(path):
            added += int(a) if a.isdigit() else 0
            deleted += int(d) if d.isdigit() else 0
    return {"files": files, "sig_added": added, "sig_deleted": deleted}


def parse_numstat(out: str) -> dict[str, dict[str, Any]]:
    """`git log -M -z --numstat --format=%x01%H` output -> per commit its numstat_change.
    A block whose key is not a sha is skipped: a path holding \x01 splits a commit's
    records, and its tail must not pass for a commit."""
    commits: dict[str, dict[str, Any]] = {}
    for block in out.split("\x01")[1:]:
        sha, _, rest = block.partition("\0")
        if SHA_RE.match(sha.strip()):
            commits[sha.strip()] = numstat_change(rest)
    return commits


def main_commits(repo: Path, shas: list[str]) -> dict[str, dict[str, Any]]:
    """Changed files, significant line counts and message of the commits the clone has
    (each against its first parent, as TD diffs a landed change)."""
    have = sorted(pytorch_repo.present(repo, [s for s in shas if SHA_RE.match(s)]))
    out: dict[str, dict[str, Any]] = {}
    for i in range(0, len(have), GIT_BATCH):
        stdin = "".join(f"{s}\n" for s in have[i : i + GIT_BATCH])
        log = ["log", "--no-walk=unsorted", "--stdin", "--no-ext-diff"]
        stats = pytorch_repo.git(
            repo, *log, "-M", "-z", "--numstat", "--format=%x01%H", stdin=stdin
        )
        out.update(parse_numstat(stats))
        bodies = pytorch_repo.git(repo, *log, "--format=%x00%H%n%B", stdin=stdin)
        for block in bodies.split("\0")[1:]:
            sha, _, body = block.partition("\n")
            if sha in out:
                out[sha]["message"] = body
    return out


def main_ref(repo: Path) -> Optional[str]:
    """The clone's pytorch main commit."""
    found = pytorch_repo.resolve(repo, list(MAIN_REFS))
    return next((found[r] for r in MAIN_REFS if r in found), None)


def reverted_sha(message: str) -> Optional[str]:
    """The commit a revert's message names (its first `This reverts commit <sha>`) when
    its subject starts with one of REVERT_SUBJECTS; None otherwise."""
    if not message.startswith(REVERT_SUBJECTS):
        return None
    found = REVERTS_RE.search(message)
    return found.group(1) if found else None


def main_history(repo: Path, since: int) -> list[dict[str, Any]]:
    """The first-parent commits of the clone's main (main_ref) with committer time >=
    `since` (unix seconds), oldest first: each {"sha", "time", "files", "reverts"}, with
    files against the first parent as parse_numstat lists them and `reverts` the sha of
    the older commit of this history the commit reverts (reverted_sha), else None."""
    head = main_ref(repo)
    if head is None:
        raise RuntimeError(f"no main branch in {repo}")
    log = ["log", "--first-parent", f"--max-age={int(since)}", "--no-ext-diff", head]
    changes = parse_numstat(
        pytorch_repo.git(repo, *log, "-M", "-z", "--numstat", "--format=%x01%H")
    )
    meta = pytorch_repo.git(repo, *log, "--format=%x00%H%x00%ct%x00%B").split("\0")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i in range(len(meta) - 3, 0, -3):
        sha, ct, message = meta[i].strip(), int(meta[i + 1]), meta[i + 2]
        if ct < since:
            continue
        target = reverted_sha(message)
        out.append(
            {
                "sha": sha,
                "time": ct,
                "files": changes.get(sha, {}).get("files", []),
                "reverts": target if target in seen else None,
            }
        )
        seen.add(sha)
    return out


def merge_base(repo: Path, a: str, b: str) -> Optional[str]:
    try:
        out = pytorch_repo.git(repo, "merge-base", "--end-of-options", a, b).strip()
    except subprocess.SubprocessError:
        return None
    return out if SHA_RE.match(out) else None


def diff_numstat(repo: Path, base: str, head: str) -> dict[str, Any]:
    """numstat_change of a PR head against its merge base (`git diff --numstat -M`)."""
    out = pytorch_repo.git(
        repo, "diff", "--numstat", "-z", "-M", "--end-of-options", base, head
    )
    return numstat_change(out)


def pr_change(repo: Path, base: str, head: str) -> tuple[list[str], str]:
    """A PR head's changed files against its merge base, as TD's query_changed_files
    lists them, and the `git log <base>..<head>` text MentionedInPR searches."""
    names = pytorch_repo.git(
        repo, "diff", "--name-only", "-M", "-z", "--end-of-options", base, head
    )
    log = pytorch_repo.git(
        repo,
        "log",
        "--pretty=medium",
        "--no-decorate",
        "--no-color",
        "--end-of-options",
        f"{base}..{head}",
    )
    return [f for f in names.split("\0") if f], log
