"""Read-only git access to the pytorch clone for the scorer's context: a change's files,
significant line counts and commit messages, diffed the way pytorch's TD job diffs it."""

import subprocess
from pathlib import Path
from typing import Any, Optional

from torchci.td.llm import pytorch_repo
from torchci.td.llm.diff import SHA_RE
from torchci.td.scorer import spec


GIT_BATCH = 1000
# The ref the clone's copy of pytorch main is read from: the remote-tracking branch of
# a fresh clone, else a local branch (explicit refs: a tag named main would win over
# the bare name).
MAIN_REFS = ("refs/remotes/origin/main", "refs/heads/main")


def significant(path: str) -> bool:
    return not path.startswith(spec.NON_SIGNIFICANT_PREFIXES) and not path.endswith(
        spec.NON_SIGNIFICANT_SUFFIXES
    )


def parse_numstat(out: str) -> dict[str, dict[str, Any]]:
    """`git log -M -z --numstat --format=%x01%H` output -> per commit its changed paths
    (a rename as its new path, as `git diff --name-only` lists it) and the added /
    deleted lines of its significant paths (binary files count 0)."""
    commits: dict[str, dict[str, Any]] = {}
    for block in out.split("\x01")[1:]:
        sha, _, rest = block.partition("\0")
        tokens = iter(rest.lstrip("\n").split("\0"))
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
        commits[sha.strip()] = {
            "files": files,
            "sig_added": added,
            "sig_deleted": deleted,
        }
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


def merge_base(repo: Path, a: str, b: str) -> Optional[str]:
    try:
        out = pytorch_repo.git(repo, "merge-base", "--end-of-options", a, b).strip()
    except subprocess.SubprocessError:
        return None
    return out if SHA_RE.match(out) else None


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
