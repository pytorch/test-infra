"""Spec tests for the fail-closed loaded-instructions detector hook.

The detector is a standalone hook script outside the greenlight package, so it is exercised as a
subprocess under the same interpreter rather than imported. The contract is deny-root: a loaded
instruction file is a violation when it resolves under an ``--untrusted-root`` (the reviewed
checkout) by EITHER its realpath (catching an outside symlink that points in) OR its lexical
normpath (catching an inside symlink that escapes out); ``memory_type`` is never consulted.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / ".claude" / "hooks" / "greenlight" / "assert-loaded-instructions.py"

# Sentinel distinguishing "omit this key" from a JSON null when building manifest entries.
_OMIT = object()


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    assert _SCRIPT.is_file(), f"detector script not found at {_SCRIPT}"
    return subprocess.run(  # noqa: S603
        [sys.executable, str(_SCRIPT), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _sentinel(tmp_path: Path) -> str:
    path = tmp_path / "hooks_ran.sentinel"
    path.write_text("ok\n", encoding="utf-8")
    return str(path)


def _manifest(tmp_path: Path, lines: list[str]) -> str:
    path = tmp_path / "loaded_instructions.jsonl"
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")
    return str(path)


def _entry(file_path: object = _OMIT, memory_type: object = _OMIT) -> str:
    obj: dict[str, object] = {"load_reason": "test"}
    if memory_type is not _OMIT:
        obj["memory_type"] = memory_type
    if file_path is not _OMIT:
        obj["file_path"] = file_path
    return json.dumps(obj)


def _untrusted_root(tmp_path: Path) -> str:
    root = tmp_path / "ws" / "pytorch"
    root.mkdir(parents=True)
    return str(root)


def test_detector_script_is_present():
    assert _SCRIPT.is_file()


def test_pass_empty_manifest_with_sentinel(tmp_path):
    result = _run(
        "--manifest",
        _manifest(tmp_path, []),
        "--sentinel",
        _sentinel(tmp_path),
        "--untrusted-root",
        _untrusted_root(tmp_path),
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith("OK:")


def test_pass_missing_manifest_with_sentinel(tmp_path):
    missing = str(tmp_path / "does-not-exist.jsonl")
    result = _run(
        "--manifest",
        missing,
        "--sentinel",
        _sentinel(tmp_path),
        "--untrusted-root",
        _untrusted_root(tmp_path),
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith("OK:")


def test_fail_missing_sentinel(tmp_path):
    missing = str(tmp_path / "no.sentinel")
    result = _run(
        "--manifest",
        _manifest(tmp_path, []),
        "--sentinel",
        missing,
        "--untrusted-root",
        _untrusted_root(tmp_path),
    )
    assert result.returncode == 1
    assert "sentinel" in result.stderr


def test_fail_entry_under_untrusted_root(tmp_path):
    untrusted = tmp_path / "ws" / "pytorch"
    untrusted.mkdir(parents=True)
    evil = untrusted / "CLAUDE.md"
    manifest = _manifest(tmp_path, [_entry(file_path=str(evil), memory_type="Project")])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", str(untrusted))
    assert result.returncode == 1
    assert os.path.realpath(str(evil)) in result.stderr


def test_fail_nested_entry_under_untrusted_root(tmp_path):
    untrusted = tmp_path / "ws" / "pytorch"
    untrusted.mkdir(parents=True)
    evil = untrusted / "torch" / "_dynamo" / "CLAUDE.md"
    manifest = _manifest(tmp_path, [_entry(file_path=str(evil), memory_type="Local")])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", str(untrusted))
    assert result.returncode == 1
    assert os.path.realpath(str(evil)) in result.stderr


def test_pass_trusted_sibling_claude_md_outside_untrusted_root(tmp_path):
    # $GITHUB_WORKSPACE/greenlight/CLAUDE.md is a trusted test-infra file and a sibling of the
    # untrusted pytorch checkout. The old allow-root model false-positived on it; deny-root must not.
    untrusted = tmp_path / "ws" / "pytorch"
    untrusted.mkdir(parents=True)
    trusted = tmp_path / "ws" / "greenlight" / "CLAUDE.md"
    manifest = _manifest(tmp_path, [_entry(file_path=str(trusted), memory_type="Project")])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", str(untrusted))
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith("OK:")


def test_pass_user_home_claude_md_outside_untrusted_root(tmp_path):
    untrusted = tmp_path / "ws" / "pytorch"
    untrusted.mkdir(parents=True)
    home_claude = tmp_path / "home" / ".claude" / "CLAUDE.md"
    manifest = _manifest(tmp_path, [_entry(file_path=str(home_claude), memory_type="User")])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", str(untrusted))
    assert result.returncode == 0, result.stderr


def test_fail_memory_type_ignored_when_path_under_untrusted_root(tmp_path):
    # memory_type is never consulted: even a User-typed entry is a violation when its path
    # resolves under the untrusted checkout. This is what makes the check drift-proof.
    untrusted = tmp_path / "ws" / "pytorch"
    untrusted.mkdir(parents=True)
    evil = untrusted / "CLAUDE.md"
    manifest = _manifest(tmp_path, [_entry(file_path=str(evil), memory_type="User")])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", str(untrusted))
    assert result.returncode == 1
    assert os.path.realpath(str(evil)) in result.stderr


def test_fail_realpath_canonicalization_symlink_into_untrusted_root(tmp_path):
    untrusted = tmp_path / "ws" / "pytorch"
    untrusted.mkdir(parents=True)
    real_file = untrusted / "CLAUDE.md"
    real_file.write_text("x", encoding="utf-8")
    # A symlink OUTSIDE the untrusted root that resolves INTO it. A plain lexical check would pass
    # this; only realpath canonicalization catches that it points back under the checkout.
    link = tmp_path / "sneaky-link.md"
    link.symlink_to(real_file)
    manifest = _manifest(tmp_path, [_entry(file_path=str(link), memory_type="Project")])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", str(untrusted))
    assert result.returncode == 1
    assert os.path.realpath(str(real_file)) in result.stderr


def test_fail_lexical_path_under_root_when_inside_symlink_escapes_untrusted_root(tmp_path):
    # Blind spot for a realpath-only check: a symlink dir INSIDE the untrusted root points OUT to an
    # external tree. The loaded file's lexical path stays under the root (pytorch/sub/inner/CLAUDE.md)
    # while its realpath escapes to ws/ext/inner/CLAUDE.md. realpath alone reports it OUTSIDE and
    # misses it; the lexical normpath check is what catches it.
    untrusted = tmp_path / "ws" / "pytorch"
    untrusted.mkdir(parents=True)
    external = tmp_path / "ws" / "ext"
    external_claude = external / "inner" / "CLAUDE.md"
    external_claude.parent.mkdir(parents=True)
    external_claude.write_text("x", encoding="utf-8")
    inside_link = untrusted / "sub"
    inside_link.symlink_to(external)
    loaded = inside_link / "inner" / "CLAUDE.md"
    # Precondition proving this is the blind spot: realpath resolves to the external sibling tree,
    # which is NOT under the untrusted root, so a realpath-only check would let it through.
    assert os.path.realpath(str(loaded)) == os.path.realpath(str(external_claude))
    manifest = _manifest(tmp_path, [_entry(file_path=str(loaded), memory_type="Project")])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", str(untrusted))
    assert result.returncode == 1
    assert os.path.normpath(os.path.abspath(str(loaded))) in result.stderr


def test_pass_sibling_prefix_is_not_under_untrusted_root(tmp_path):
    # Shares the ``pytorch`` prefix but is a sibling directory, not a child; the ``+ os.sep`` guard
    # must not flag it.
    untrusted = tmp_path / "ws" / "pytorch"
    untrusted.mkdir(parents=True)
    sibling = tmp_path / "ws" / "pytorch-evil" / "CLAUDE.md"
    manifest = _manifest(tmp_path, [_entry(file_path=str(sibling), memory_type="Project")])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", str(untrusted))
    assert result.returncode == 0, result.stderr


def test_fail_entry_under_second_untrusted_root(tmp_path):
    root_a = tmp_path / "ws" / "pytorch"
    root_a.mkdir(parents=True)
    root_b = tmp_path / "ws" / "other-untrusted"
    root_b.mkdir(parents=True)
    evil = root_b / "CLAUDE.md"
    manifest = _manifest(tmp_path, [_entry(file_path=str(evil), memory_type="Project")])
    result = _run(
        "--manifest",
        manifest,
        "--sentinel",
        _sentinel(tmp_path),
        "--untrusted-root",
        str(root_a),
        "--untrusted-root",
        str(root_b),
    )
    assert result.returncode == 1
    assert os.path.realpath(str(evil)) in result.stderr


def test_pass_multiple_untrusted_roots_entry_outside_all(tmp_path):
    root_a = tmp_path / "ws" / "pytorch"
    root_a.mkdir(parents=True)
    root_b = tmp_path / "ws" / "other-untrusted"
    root_b.mkdir(parents=True)
    good = tmp_path / "ws" / "greenlight" / "CLAUDE.md"
    manifest = _manifest(tmp_path, [_entry(file_path=str(good), memory_type="Project")])
    result = _run(
        "--manifest",
        manifest,
        "--sentinel",
        _sentinel(tmp_path),
        "--untrusted-root",
        str(root_a),
        "--untrusted-root",
        str(root_b),
    )
    assert result.returncode == 0, result.stderr


def test_fail_lists_every_violation(tmp_path):
    untrusted = tmp_path / "ws" / "pytorch"
    untrusted.mkdir(parents=True)
    evil_a = untrusted / "CLAUDE.md"
    evil_b = untrusted / "third_party" / "CLAUDE.md"
    manifest = _manifest(
        tmp_path,
        [_entry(file_path=str(evil_a), memory_type="Project"), _entry(file_path=str(evil_b), memory_type="Local")],
    )
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", str(untrusted))
    assert result.returncode == 1
    assert os.path.realpath(str(evil_a)) in result.stderr
    assert os.path.realpath(str(evil_b)) in result.stderr


def test_pass_tolerates_trailing_blank_lines(tmp_path):
    untrusted = tmp_path / "ws" / "pytorch"
    untrusted.mkdir(parents=True)
    good = tmp_path / "ws" / "greenlight" / "CLAUDE.md"
    manifest = _manifest(tmp_path, [_entry(file_path=str(good), memory_type="Project"), "", ""])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", str(untrusted))
    assert result.returncode == 0, result.stderr


def test_fail_malformed_json_line(tmp_path):
    untrusted = _untrusted_root(tmp_path)
    manifest = _manifest(tmp_path, ["{not valid json"])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", untrusted)
    assert result.returncode == 1
    assert "malformed" in result.stderr
    assert "{not valid json" in result.stderr


def test_fail_non_object_json_line(tmp_path):
    untrusted = _untrusted_root(tmp_path)
    manifest = _manifest(tmp_path, ["[1, 2, 3]"])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", untrusted)
    assert result.returncode == 1
    assert "not a JSON object" in result.stderr


@pytest.mark.parametrize(
    "raw_entry",
    [
        _entry(memory_type="Project"),  # file_path key absent
        _entry(file_path="", memory_type="Project"),  # empty string
        _entry(file_path=123, memory_type="Project"),  # non-string
        _entry(file_path=None, memory_type="Project"),  # explicit JSON null
    ],
)
def test_fail_invalid_file_path(tmp_path, raw_entry):
    untrusted = _untrusted_root(tmp_path)
    manifest = _manifest(tmp_path, [raw_entry])
    result = _run("--manifest", manifest, "--sentinel", _sentinel(tmp_path), "--untrusted-root", untrusted)
    assert result.returncode == 1
    assert "file_path" in result.stderr


def test_missing_required_untrusted_root_is_usage_error(tmp_path):
    result = _run("--manifest", _manifest(tmp_path, []), "--sentinel", _sentinel(tmp_path))
    assert result.returncode == 2
    assert "untrusted-root" in result.stderr
