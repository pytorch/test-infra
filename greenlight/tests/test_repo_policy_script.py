"""Spec tests for ``.claude/hooks/greenlight/repo-policy.py``, the repository-policy staging script.

The script lives outside the greenlight package and runs under the runner's system python3, so it is
exercised as a subprocess against throwaway git repositories, as the reviewer workflow runs it.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / ".claude" / "hooks" / "greenlight" / "repo-policy.py"
_POLICY = ".github/greenlight/review.md"
_SECTIONS = ("User-facing surface", "Merge-gating workflows", "Lint gate", "Test layout")
_SECRET = "do-not-echo-this-line"


def _policy(*, meta: bool = False, drop: str = "") -> bytes:
    lines = ["# policy", _SECRET]
    lines += [f"## {name}\ntext" for name in _SECTIONS if name != drop]
    if meta:
        lines.append("### Meta-internal only\nclass")
    return ("\n".join(lines) + "\n").encode()


_VALID = _policy()
_VALID_PRIMARY = _policy(meta=True)


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        [sys.executable, str(_SCRIPT), *args], capture_output=True, text=True, check=False
    )


def _git(repo: Path, *args: str) -> None:
    subprocess.run(  # noqa: S603
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],  # noqa: S607
        check=True,
        capture_output=True,
    )


def _repo(tmp_path: Path, files: dict[str, bytes], links: dict[str, str] | None = None) -> Path:
    repo = tmp_path / "trusted"
    repo.mkdir()
    _git(repo, "init", "-q")
    for path, data in files.items():
        (repo / path).parent.mkdir(parents=True, exist_ok=True)
        (repo / path).write_bytes(data)
    for path, target in (links or {}).items():
        (repo / path).parent.mkdir(parents=True, exist_ok=True)
        (repo / path).symlink_to(target)
    (repo / "README").write_text("x\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "main")
    return repo


def _claude(tmp_path: Path, builtin: bytes | None = None) -> tuple[Path, Path]:
    claude = tmp_path / "ws" / ".claude"
    slot = claude / "skills" / "greenlight-review" / "repo-policy.md"
    slot.parent.mkdir(parents=True)
    if builtin is not None:
        slot.write_bytes(builtin)
    return claude, slot


def _stage(repo: str, trusted: Path, claude: Path) -> subprocess.CompletedProcess[str]:
    result = _run("stage", repo, str(trusted), str(claude))
    assert result.returncode == 0, result.stderr
    assert _SECRET not in result.stderr
    return result


def test_script_is_present_and_executable():
    assert _SCRIPT.is_file()
    assert os.access(_SCRIPT, os.X_OK)


def test_a_valid_file_of_another_repo_is_staged(tmp_path):
    trusted = _repo(tmp_path, {_POLICY: _VALID})
    claude, slot = _claude(tmp_path, builtin=_VALID_PRIMARY)

    result = _stage("pytorch/vision", trusted, claude)

    assert result.stdout == "staged=true\n"
    assert slot.read_bytes() == _VALID
    assert not slot.is_symlink()


def test_another_repo_without_a_file_has_no_slot(tmp_path):
    trusted = _repo(tmp_path, {})
    claude, slot = _claude(tmp_path, builtin=_VALID_PRIMARY)

    result = _stage("pytorch/vision", trusted, claude)

    assert result.stdout == "staged=false\n"
    assert not slot.exists()
    assert "absent" in result.stderr


def test_the_primary_without_a_file_keeps_its_checked_builtin(tmp_path):
    trusted = _repo(tmp_path, {".github/workflows/x.yml": b"x\n"})
    claude, slot = _claude(tmp_path, builtin=_VALID_PRIMARY)

    assert _stage("pytorch/pytorch", trusted, claude).stdout == "staged=true\n"
    assert slot.read_bytes() == _VALID_PRIMARY


@pytest.mark.parametrize("builtin", [None, _VALID], ids=["missing", "no-meta-heading"])
def test_the_primary_without_a_file_and_without_a_good_builtin_has_no_slot(tmp_path, builtin):
    trusted = _repo(tmp_path, {})
    claude, slot = _claude(tmp_path, builtin=builtin)

    result = _stage("pytorch/pytorch", trusted, claude)

    assert result.stdout == "staged=false\n"
    assert not slot.exists()
    assert "the built-in policy" in result.stderr


def test_a_symlinked_builtin_is_never_followed(tmp_path):
    trusted = _repo(tmp_path, {})
    claude, slot = _claude(tmp_path)
    outside = tmp_path / "outside.md"
    outside.write_bytes(_VALID_PRIMARY)
    slot.symlink_to(outside)

    result = _stage("pytorch/pytorch", trusted, claude)

    assert result.stdout == "staged=false\n"
    assert not slot.is_symlink()
    assert "not a regular file" in result.stderr
    assert outside.read_bytes() == _VALID_PRIMARY


def test_the_primarys_own_file_replaces_the_builtin_without_following_a_symlinked_slot(tmp_path):
    own = _VALID_PRIMARY + b"own\n"
    trusted = _repo(tmp_path, {_POLICY: own})
    claude, slot = _claude(tmp_path)
    outside = tmp_path / "outside.md"
    outside.write_bytes(b"untouched\n")
    slot.symlink_to(outside)

    assert _stage("pytorch/pytorch", trusted, claude).stdout == "staged=true\n"
    assert not slot.is_symlink()
    assert slot.read_bytes() == own
    assert outside.read_bytes() == b"untouched\n"


def test_the_file_comes_from_the_commit_never_the_working_tree(tmp_path):
    trusted = _repo(tmp_path, {_POLICY: _VALID})
    planted = tmp_path / "planted.md"
    planted.write_bytes(_VALID + b"planted\n")
    (trusted / _POLICY).unlink()
    (trusted / _POLICY).symlink_to(planted)
    claude, slot = _claude(tmp_path)

    assert _stage("pytorch/vision", trusted, claude).stdout == "staged=true\n"
    assert slot.read_bytes() == _VALID


@pytest.mark.parametrize(
    ("files", "links", "problem"),
    [
        ({"elsewhere/greenlight/review.md": _VALID}, {".github": "elsewhere"}, ".github is not a directory"),
        ({"elsewhere/review.md": _VALID}, {".github/greenlight": "../elsewhere"}, ".github/greenlight is not a"),
        ({"elsewhere.md": _VALID}, {_POLICY: "../../elsewhere.md"}, "not a regular file"),
        ({_POLICY + "/inner": _VALID}, {}, "not a regular file"),
        ({".github": _VALID}, {}, ".github is not a directory"),
    ],
    ids=["github-symlink", "greenlight-symlink", "file-symlink", "file-is-a-directory", "github-is-a-file"],
)
def test_a_path_that_is_not_trees_and_a_regular_file_fails_closed(tmp_path, files, links, problem):
    trusted = _repo(tmp_path, files, links)
    claude, slot = _claude(tmp_path, builtin=_VALID_PRIMARY)

    for repo in ("pytorch/vision", "pytorch/pytorch"):
        result = _stage(repo, trusted, claude)
        assert result.stdout == "staged=false\n"
        assert problem in result.stderr
        assert not slot.exists()


def test_an_executable_file_is_not_a_regular_file(tmp_path):
    trusted = _repo(tmp_path, {_POLICY: _VALID})
    (trusted / _POLICY).chmod(0o755)
    _git(trusted, "commit", "-q", "-am", "x")
    claude, slot = _claude(tmp_path)

    result = _stage("pytorch/vision", trusted, claude)

    assert result.stdout == "staged=false\n"
    assert "not a regular file" in result.stderr
    assert not slot.exists()


@pytest.mark.parametrize(
    ("repo", "data", "problem"),
    [
        ("pytorch/vision", _policy(drop="Lint gate"), "missing the section '## Lint gate'"),
        ("pytorch/pytorch", _VALID, "missing the heading '### Meta-internal only'"),
        ("pytorch/vision", _VALID_PRIMARY, "the heading '### Meta-internal only' is only for pytorch/pytorch"),
        ("pytorch/vision", _VALID + b"x" * 65536, "bytes, over the 65536-byte cap"),
        ("pytorch/vision", _VALID + b"\xff\n", "not UTF-8"),
        ("pytorch/vision", b"", "missing the section '## User-facing surface'"),
    ],
    ids=["missing-section", "primary-without-heading", "other-with-heading", "oversized", "not-utf8", "empty"],
)
def test_a_file_failing_a_content_check_removes_the_slot(tmp_path, repo, data, problem):
    trusted = _repo(tmp_path, {_POLICY: data})
    claude, slot = _claude(tmp_path, builtin=_VALID_PRIMARY)

    result = _stage(repo, trusted, claude)

    assert result.stdout == "staged=false\n"
    assert problem in result.stderr
    assert not slot.exists()


@pytest.mark.parametrize("repo", ["PyTorch/PyTorch", "pytorch/..", "pytorch/.", "meta/x", "pytorch/a/b", ""])
def test_a_bad_repo_is_an_unexpected_error(tmp_path, repo):
    trusted = _repo(tmp_path, {_POLICY: _VALID})
    claude, slot = _claude(tmp_path, builtin=_VALID_PRIMARY)

    result = _run("stage", repo, str(trusted), str(claude))

    assert (result.returncode, result.stdout) == (1, "")
    assert slot.read_bytes() == _VALID_PRIMARY


def test_a_checkout_that_is_not_a_repository_is_an_unexpected_error(tmp_path):
    claude, _slot = _claude(tmp_path)
    result = _run("stage", "pytorch/vision", str(tmp_path / "missing"), str(claude))
    assert (result.returncode, result.stdout) == (1, "")


def test_missing_arguments_fail():
    assert _run("stage", "pytorch/vision").returncode != 0
    assert _run().returncode != 0


def _touches(tmp_path: Path, diff: str | bytes) -> str:
    path = tmp_path / "pr.diff"
    path.write_bytes(diff.encode() if isinstance(diff, str) else diff)
    result = _run("touches", str(path))
    assert result.returncode == 0, result.stderr
    return result.stdout


def _file(old: str, new: str, *headers: str, minus: str = "", plus: str = "") -> str:
    lines = [f"diff --git {old} {new}", *headers]
    if minus:
        lines += [f"--- {minus}", f"+++ {plus}", "@@ -1 +1 @@", "-a", "+b"]
    return "\n".join(lines) + "\n"


_UNRELATED = _file("a/README", "b/README", "index 1..2 100644", minus="a/README", plus="b/README")


@pytest.mark.parametrize(
    "diff",
    [
        _file("a/.github/greenlight", "b/.github/greenlight", "new file mode 120000", minus="/dev/null", plus="b/x"),
        _file("a/.github/greenlight/config.yml", "b/.github/greenlight/config.yml", minus="a/x", plus="b/x"),
        _file("a/.github/greenlight/review.md", "b/docs/review.md", "rename from .github/greenlight/review.md"),
        _file("a/docs/x.md", "b/docs/y.md", "copy from docs/x.md", "copy to .github/greenlight/review.md"),
        _file("a/.github/greenlight/review.md", "b/.github/greenlight/review.md", "deleted file mode 100644"),
        _file('"a/.github/greenlight/r\\303\\251.md"', '"b/.github/greenlight/r\\303\\251.md"'),
        _file("a/x", '"b/.github/greenlight/\\tx"'),
        _file("a/.github", "b/.github", "new file mode 120000", minus="/dev/null", plus="b/.github"),
        _file("a/x b/.github/greenlight/y", "b/x b/.github/greenlight/y"),
        _file("a/x", "b/x", minus='"a/.github/greenlight/\\"q"', plus="b/x"),
        _file("a/x", "b/x", minus="a/x", plus="b/.github/greenlight/a b\t"),
    ],
    ids=[
        "the-directory-itself",
        "a-file-under-it",
        "rename-out-of-it",
        "copy-into-it",
        "deletion",
        "quoted-path",
        "quoted-new-side",
        "github-symlink",
        "ambiguous-unquoted-pair",
        "quoted-old-header",
        "tab-terminated-new-header",
    ],
)
def test_a_diff_touching_the_greenlight_directory(tmp_path, diff):
    assert _touches(tmp_path, _UNRELATED + diff) == "touches=true\n"


@pytest.mark.parametrize(
    "diff",
    [
        "",
        _UNRELATED,
        _file("a/.github/greenlightx/a", "b/.github/greenlightx/a", minus="a/x", plus="b/x"),
        _file("a/.github/workflows/x.yml", "b/.github/workflows/x.yml", minus="a/x", plus="b/x"),
        _UNRELATED + "+++ b/.github/greenlight/review.md\n-diff --git a/.github/greenlight b/.github/greenlight\n",
    ],
    ids=["empty", "unrelated", "sibling-prefix", "other-github-dir", "hunk-lines-are-content"],
)
def test_a_diff_not_touching_it(tmp_path, diff):
    assert _touches(tmp_path, diff) == "touches=false\n"


@pytest.mark.parametrize(
    "diff",
    [
        "diff --git nothing-here\n",
        'diff --git "a/unterminated\n',
        'diff --git "a/x\\q" "b/x"\n',
        'diff --git "a/x""b/x"\n',
        "preamble\n" + _UNRELATED,
        _file("a/x", "b/x", 'rename from "bad\\q"'),
        _file("a/x", "b/x", minus="x", plus="b/x"),
        _file("a/x", "b/x", minus='"a/x" tail', plus="b/x"),
    ],
    ids=[
        "no-prefix",
        "unterminated",
        "bad-escape",
        "no-space",
        "preamble",
        "bad-rename",
        "unprefixed-header",
        "text-after-quote",
    ],
)
def test_an_unparseable_header_counts_as_touching(tmp_path, diff):
    assert _touches(tmp_path, diff) == "touches=true\n"


def test_a_missing_diff_is_an_unexpected_error(tmp_path):
    result = _run("touches", str(tmp_path / "missing.diff"))
    assert (result.returncode, result.stdout) == (1, "")


def test_check_passes_a_valid_file_and_lists_problems_otherwise(tmp_path):
    good, bad = tmp_path / "good.md", tmp_path / "bad.md"
    good.write_bytes(_VALID_PRIMARY)
    bad.write_bytes(_policy(drop="Test layout"))

    assert _run("check", str(good), "--repo", "pytorch/pytorch").returncode == 0
    result = _run("check", str(bad), "--repo", "pytorch/vision")
    assert result.returncode == 1
    assert "missing the section '## Test layout'" in result.stderr
    assert _SECRET not in result.stderr


def test_check_refuses_a_symlink_and_a_missing_file(tmp_path):
    good = tmp_path / "good.md"
    good.write_bytes(_VALID)
    link = tmp_path / "link.md"
    link.symlink_to(good)

    result = _run("check", str(link), "--repo", "pytorch/vision")
    assert (result.returncode, "not a regular file" in result.stderr) == (1, True)
    result = _run("check", str(tmp_path / "missing.md"), "--repo", "pytorch/vision")
    assert (result.returncode, "absent" in result.stderr) == (1, True)
