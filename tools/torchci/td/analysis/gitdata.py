"""Landed commits from the pytorch clone, read-only: changed files, line counts and
messages. Commits the clone does not hold are kept with diff_ok False, never fetched."""

import re
import subprocess
from pathlib import Path
from typing import Any

import pandas as pd
from torchci.td.analysis import config


SHA_RE = re.compile(r"^[0-9a-f]{40}$")
PR_RE = re.compile(r"\(#(\d+)\)\s*$")
GIT_TIMEOUT = 600


def git(repo: Path, *args: str, stdin: str = "") -> str:
    return subprocess.run(
        ["git", "--no-optional-locks", "-C", str(repo), *args],
        input=stdin, capture_output=True, text=True, check=True, timeout=GIT_TIMEOUT,
    ).stdout


def significant(path: str) -> bool:
    return not path.startswith(config.NON_SIGNIFICANT_PREFIXES) and not path.endswith(config.NON_SIGNIFICANT_SUFFIXES)


def parse_log(out: str) -> dict[str, dict[str, Any]]:
    """`git log --format=%x00%H %P%x01%s --numstat` output -> per commit its parent, title,
    files and added / deleted lines (binary files count 0 lines)."""
    commits: dict[str, dict[str, Any]] = {}
    for block in out.split("\x00")[1:]:
        head, _, rest = block.partition("\n")
        ids, _, title = head.partition("\x01")
        sha, *parents = ids.split()
        files, added, deleted, sig_added, sig_deleted = [], 0, 0, 0, 0
        for line in rest.splitlines():
            parts = line.split("\t")
            if len(parts) != 3:
                continue
            a, d, path = parts
            a, d = (int(a) if a.isdigit() else 0), (int(d) if d.isdigit() else 0)
            files.append(path)
            added, deleted = added + a, deleted + d
            if significant(path):
                sig_added, sig_deleted = sig_added + a, sig_deleted + d
        commits[sha] = {
            "parent": parents[0] if parents else "", "title": title, "files": files,
            "added": added, "deleted": deleted, "sig_added": sig_added, "sig_deleted": sig_deleted,
        }
    return commits


def present(repo: Path, shas: list[str]) -> set[str]:
    out = git(repo, "cat-file", "--batch-check=%(objectname) %(objecttype)", stdin="".join(f"{s}\n" for s in shas))
    return {line.split()[0] for line in out.splitlines() if line.endswith(" commit")}


def commits(repo: Path, pushes: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for push in pushes.itertuples():
        shas = [s for s in push.commit_shas if SHA_RE.match(s)]
        for sha in shas:
            rows.append({"sha": sha, "push_sha": push.push_sha, "pushed_at": int(push.pushed_at), "push_size": len(shas)})
    df = pd.DataFrame(rows).drop_duplicates("sha")
    have = present(repo, df["sha"].tolist())
    info = parse_log(git(
        repo, "log", "--no-walk=unsorted", "--stdin", "--no-renames", "--no-ext-diff", "--no-textconv",
        "--format=%x00%H %P%x01%s", "--numstat", stdin="".join(f"{s}\n" for s in sorted(have)),
    )) if have else {}
    df["diff_ok"] = df["sha"].isin(info)
    for col, default in (("parent", ""), ("title", ""), ("files", None), ("added", 0), ("deleted", 0), ("sig_added", 0), ("sig_deleted", 0)):
        df[col] = df["sha"].map(lambda s, c=col, d=default: info.get(s, {}).get(c, d if d is not None else []))
    df["pr_number"] = df["title"].map(lambda t: int(m.group(1)) if (m := PR_RE.search(t)) else 0)
    df["is_revert"] = df["title"].str.startswith('Revert "')
    return df.drop(columns=["title"])


def messages(repo: Path, shas: list[str]) -> dict[str, str]:
    have = present(repo, [s for s in shas if SHA_RE.match(s)])
    if not have:
        return {}
    out = git(repo, "log", "--no-walk=unsorted", "--stdin", "--format=%x00%H%n%B", stdin="".join(f"{s}\n" for s in sorted(have)))
    msgs = {}
    for block in out.split("\x00")[1:]:
        sha, _, body = block.partition("\n")
        msgs[sha] = body
    return msgs


def diff_text(repo: Path, sha: str) -> str:
    """The commit's diff against its parent, as the LLM retriever reads a PR's diff."""
    if not SHA_RE.match(sha):
        raise ValueError(f"not a sha: {sha!r}")
    return git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--end-of-options", f"{sha}^", sha)
