"""The harness's access to its own pytorch clone: commits by sha, diffs, and monthly
corpus snapshots with the TESTS list each snapshot's own discover_tests.py computes."""

import io
import json
import logging
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from torchci.td.llm import corpus, diff
from torchci.td.llm.cache import ensure_dir


logger = logging.getLogger(__name__)

GIT_SLOW_TIMEOUT_SECONDS = 600
FETCH_BATCH = 100
DIFFS_FILE = "diffs.v2.jsonl"
TESTS_FILE = "TESTS.json"
TESTS_CODE = (
    "import json, runpy, sys; print(json.dumps(runpy.run_path(sys.argv[1])['TESTS']))"
)
# Corpus name -> whether corpus.build adds a unit per test function.
CORPORA = {"skeleton": False, "skeleton+functions": True}


def git(repo: Path, *args: str, stdin: Optional[str] = None) -> str:
    return diff.git(repo, *args, stdin=stdin, timeout=GIT_SLOW_TIMEOUT_SECONDS).stdout


def resolve(repo: Path, revs: list[str]) -> dict[str, str]:
    """Revision -> commit sha, for the revisions that resolve to a commit."""
    lines = "".join(f"{r}^{{commit}}\n" for r in revs)
    out = git(
        repo, "cat-file", "--batch-check=%(objectname) %(objecttype)", stdin=lines
    )
    pairs = (line.split(" ") for line in out.splitlines())
    return {r: p[0] for r, p in zip(revs, pairs) if p[-1] == "commit"}


def present(repo: Path, revs: list[str]) -> set[str]:
    return set(resolve(repo, revs))


def fetch_missing(repo: Path, shas: set[str]) -> tuple[set[str], int]:
    """Fetch absent commits by sha from origin in batches: the shas still absent, and
    how many were fetched."""
    invalid = sorted(s for s in shas if not diff.SHA_RE.match(s))
    if invalid:
        raise ValueError(f"not commit shas: {invalid[:3]}")
    missing = sorted(shas - present(repo, sorted(shas)))
    fetch = ["fetch", "--quiet", "--no-tags", "origin", "--end-of-options"]
    for i in range(0, len(missing), FETCH_BATCH):
        batch = missing[i : i + FETCH_BATCH]
        try:
            git(repo, *fetch, *batch)
        except subprocess.CalledProcessError:
            for sha in batch:
                try:
                    git(repo, *fetch, sha)
                except subprocess.CalledProcessError as e:
                    logger.warning("cannot fetch %s: %s", sha, e.stderr.strip()[-200:])
    absent = shas - present(repo, sorted(shas))
    return absent, len(missing) - len(absent)


def diff_text(repo: Path, rev: str) -> str:
    """The retriever's diff (diff.git_diff) for `A..B`, or for `A...B` from the merge
    base, between commits of the clone."""
    if "..." in rev:
        base, head = rev.split("...")
        base = git(repo, "merge-base", "--end-of-options", base, head).strip()
    else:
        base, head = rev.split("..")
    shas = resolve(repo, [base, head])
    return diff.git_diff(repo, shas[base], head=shas[head])


def load_diffs(
    repo: Path, cache_dir: Path, revs: set[str]
) -> dict[str, dict[str, Any]]:
    """Query chunks and changed paths per diff, appended to `<cache>/DIFFS_FILE`.
    A diff git cannot produce is left out (and logged)."""
    path = cache_dir / DIFFS_FILE
    known: dict[str, dict[str, Any]] = {}
    text = path.read_text() if path.exists() else ""
    for line in text.splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("skipping a torn line of %s", DIFFS_FILE)
            continue
        known[record["rev"]] = record
    with open(path, "a") as f:
        if text and not text.endswith("\n"):
            f.write("\n")
        for rev in sorted(revs - set(known)):
            try:
                text = diff_text(repo, rev)
            except (subprocess.SubprocessError, KeyError, diff.DiffError) as e:
                logger.warning("git diff %s failed: %s %s", rev, type(e).__name__, e)
                continue
            chunks, paths = diff.query_chunks(text), diff.changed_paths(text)
            known[rev] = {"rev": rev, "chunks": chunks, "paths": paths}
            f.write(json.dumps(known[rev]) + "\n")
            f.flush()
    return {rev: known[rev] for rev in revs if rev in known}


@dataclass
class CorpusSnapshot:
    commit: str
    tests: frozenset[str]
    units: dict[str, list[corpus.Unit]]


def _extract(repo: Path, commit: str, root: Path) -> None:
    tmp = Path(tempfile.mkdtemp(dir=root.parent, prefix=".extract-"))
    try:
        # git archive writes binary tar data, which diff.git (text) would mangle.
        archive = subprocess.run(
            ["git", "-C", str(repo), "archive", commit, "test", "tools/testing"],
            capture_output=True,
            check=True,
            timeout=GIT_SLOW_TIMEOUT_SECONDS,
        ).stdout
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(tmp, filter="data")
        (tmp / "no-cpp-tests").mkdir()
        script = tmp / "tools" / "testing" / "discover_tests.py"
        env = {
            "PATH": os.environ.get("PATH", ""),
            "CPP_TESTS_DIR": str(tmp / "no-cpp-tests"),
        }
        tests = subprocess.run(
            [sys.executable, "-I", "-c", TESTS_CODE, str(script)],
            capture_output=True,
            text=True,
            check=True,
            cwd=tmp,
            env=env,
            timeout=GIT_SLOW_TIMEOUT_SECONDS,
        ).stdout
        (tmp / TESTS_FILE).write_text(tests)
        os.replace(tmp, root)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def snapshot(repo: Path, cache_dir: Path, month: str) -> CorpusSnapshot:
    """Main's last commit before the month starts: its test corpus, units for every
    corpus kind, and the TESTS that commit's discover_tests.py computes (no C++ tests)."""
    commit = git(repo, "rev-list", "-1", f"--before={month}-01T00:00:00Z", "main")
    commit = commit.strip()
    if not commit:
        raise RuntimeError(f"main has no commit before {month}-01")
    root = ensure_dir(cache_dir / "corpus") / commit
    if not (root / TESTS_FILE).exists():
        _extract(repo, commit, root)
    tests = frozenset(json.loads((root / TESTS_FILE).read_text()))
    units = {name: corpus.build(root / "test", f) for name, f in CORPORA.items()}
    return CorpusSnapshot(commit, tests, units)
