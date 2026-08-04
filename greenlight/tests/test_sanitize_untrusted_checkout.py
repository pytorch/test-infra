"""Spec tests for the untrusted-checkout sanitizer hook.

The sanitizer is a standalone shell script outside the greenlight package, so it is exercised as a
subprocess (invoked via bash, the way the reviewer workflow calls it) rather than imported.
"""

import os
import shutil
import subprocess
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[2] / ".claude" / "hooks" / "greenlight" / "sanitize-untrusted-checkout.sh"
_BASH = shutil.which("bash") or "bash"


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    assert _SCRIPT.is_file(), f"sanitizer script not found at {_SCRIPT}"
    return subprocess.run(  # noqa: S603
        [_BASH, str(_SCRIPT), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _write(path: Path, content: str = "x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _empty_skills_src(tmp_path: Path) -> str:
    """A valid second arg whose skills tree is absent, so the restore pass is a no-op."""
    src = tmp_path / "skills_src_empty"
    src.mkdir()
    return str(src)


def _skills_src(tmp_path: Path) -> str:
    """A trusted source carrying skills to restore plus a rules tree that must NOT be restored."""
    src = tmp_path / "skills_src"
    _write(src / ".claude" / "skills" / "foo" / "SKILL.md", "trusted-skill")
    _write(src / ".claude" / "rules" / "evil.md", "nope")
    return str(src)


def _populate_untrusted(root: Path) -> None:
    for forbidden in [
        "CLAUDE.md",
        "CLAUDE.local.md",
        "AGENTS.md",
        ".cursorrules",
        ".claude/rules/r.md",
        ".claude/skills/old/SKILL.md",
        ".claude/settings.json",
        ".github/copilot-instructions.md",
        "torch/_dynamo/CLAUDE.md",
        "third_party/CLAUDE.local.md",
        "subpkg/AGENTS.md",
    ]:
        _write(root / forbidden)
    for legit in ["torch/foo.py", "README.md", "docs/CLAUDE_GUIDE.md", ".github/workflows/ci.yml"]:
        _write(root / legit)


def test_script_is_present_and_executable():
    assert _SCRIPT.is_file()
    assert os.access(_SCRIPT, os.X_OK)


def test_strips_forbidden_files_root_and_nested(tmp_path):
    untrusted = tmp_path / "pytorch"
    _populate_untrusted(untrusted)
    result = _run(str(untrusted), _empty_skills_src(tmp_path))
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith("sanitize ok")
    for gone in [
        "CLAUDE.md",
        "CLAUDE.local.md",
        "AGENTS.md",
        ".cursorrules",
        ".claude",
        ".github/copilot-instructions.md",
        "torch/_dynamo/CLAUDE.md",
        "third_party/CLAUDE.local.md",
        "subpkg/AGENTS.md",
    ]:
        assert not (untrusted / gone).exists(), f"{gone} should be stripped"
    for kept in ["torch/foo.py", "README.md", "docs/CLAUDE_GUIDE.md", ".github/workflows/ci.yml"]:
        assert (untrusted / kept).is_file(), f"{kept} should survive"


def test_restores_only_skills_from_trusted_source(tmp_path):
    untrusted = tmp_path / "pytorch"
    _populate_untrusted(untrusted)
    result = _run(str(untrusted), _skills_src(tmp_path))
    assert result.returncode == 0, result.stderr
    assert (untrusted / ".claude" / "skills" / "foo" / "SKILL.md").is_file()
    # The restored .claude may hold ONLY the skills subtree.
    assert sorted(p.name for p in (untrusted / ".claude").iterdir()) == ["skills"]
    # A non-skills tree present in the source is never restored.
    assert not (untrusted / ".claude" / "rules").exists()
    # The untrusted checkout's own pre-existing skill is replaced by the trusted tree.
    assert not (untrusted / ".claude" / "skills" / "old").exists()


def test_restore_is_noop_without_source_skills(tmp_path):
    untrusted = tmp_path / "pytorch"
    _write(untrusted / ".claude" / "rules" / "r.md")
    _write(untrusted / "keep.py")
    result = _run(str(untrusted), _empty_skills_src(tmp_path))
    assert result.returncode == 0, result.stderr
    assert not (untrusted / ".claude").exists()
    assert (untrusted / "keep.py").is_file()


def test_symlink_file_named_claude_md_removed_target_survives(tmp_path):
    outside = _write(tmp_path / "outside" / "secret.md", "secret")
    untrusted = tmp_path / "pytorch"
    untrusted.mkdir()
    link = untrusted / "CLAUDE.md"
    os.symlink(outside, link)
    result = _run(str(untrusted), _empty_skills_src(tmp_path))
    assert result.returncode == 0, result.stderr
    # lexists is false only when neither the symlink nor a file remains at the path.
    assert not os.path.lexists(link)
    assert outside.is_file()
    assert outside.read_text(encoding="utf-8") == "secret"


def test_symlink_dir_named_claude_removed_target_survives(tmp_path):
    target_dir = tmp_path / "outside_claude"
    _write(target_dir / "keep.txt", "keep")
    untrusted = tmp_path / "pytorch"
    untrusted.mkdir()
    os.symlink(target_dir, untrusted / ".claude", target_is_directory=True)
    result = _run(str(untrusted), _empty_skills_src(tmp_path))
    assert result.returncode == 0, result.stderr
    assert not os.path.lexists(untrusted / ".claude")
    assert target_dir.is_dir()
    assert (target_dir / "keep.txt").is_file()


def test_sibling_claude_above_arg_dir_survives(tmp_path):
    _write(tmp_path / ".claude" / "keep.txt", "above")
    untrusted = tmp_path / "pytorch"
    _write(untrusted / "CLAUDE.md")
    result = _run(str(untrusted), _empty_skills_src(tmp_path))
    assert result.returncode == 0, result.stderr
    # A .claude one level above the arg dir is out of scope and must be untouched.
    assert (tmp_path / ".claude" / "keep.txt").is_file()
    assert not (untrusted / "CLAUDE.md").exists()


def test_up_symlink_is_not_descended(tmp_path):
    # Reachable only by descending the 'up' symlink; its survival proves find never followed it.
    parent_forbidden = _write(tmp_path / "CLAUDE.md", "parent")
    untrusted = tmp_path / "pytorch"
    _write(untrusted / "CLAUDE.md")
    os.symlink("..", untrusted / "up", target_is_directory=True)
    result = _run(str(untrusted), _empty_skills_src(tmp_path))
    assert result.returncode == 0, result.stderr
    assert parent_forbidden.is_file()
    assert not (untrusted / "CLAUDE.md").exists()
    # 'up' is not a forbidden name, so the symlink node itself is left in place.
    assert os.path.islink(untrusted / "up")


def test_no_arguments_fail():
    result = _run()
    assert result.returncode != 0
    assert "usage" in result.stderr


def test_single_argument_fails(tmp_path):
    result = _run(str(tmp_path))
    assert result.returncode != 0
    assert "usage" in result.stderr


def test_nonexistent_untrusted_dir_fails(tmp_path):
    result = _run(str(tmp_path / "does-not-exist"), _empty_skills_src(tmp_path))
    assert result.returncode != 0
    assert "missing or not a directory" in result.stderr


def test_untrusted_arg_that_is_a_file_fails(tmp_path):
    afile = _write(tmp_path / "afile", "x")
    result = _run(str(afile), _empty_skills_src(tmp_path))
    assert result.returncode != 0
    assert "not a directory" in result.stderr


def test_symlinked_untrusted_arg_is_rejected(tmp_path):
    # find's default -P walk does not descend a symlinked start point, so a
    # symlinked arg must be refused outright, not silently no-op'd (fail-open).
    target = tmp_path / "real_pytorch"
    _write(target / "CLAUDE.md")
    link = tmp_path / "link_pytorch"
    os.symlink(target, link, target_is_directory=True)
    result = _run(str(link), _empty_skills_src(tmp_path))
    assert result.returncode != 0
    assert "symlink" in result.stderr
    # Refused before stripping: the real target is untouched, proving the script
    # did not follow the link and then falsely report success.
    assert (target / "CLAUDE.md").is_file()


def test_trailing_double_slash_arg_verifies_ok(tmp_path):
    # A raw '//' suffix used to survive the single '%/' strip and make the verify
    # pass's exact-path allowlist miss the restored .claude — a spurious failure.
    untrusted = tmp_path / "pytorch"
    _populate_untrusted(untrusted)
    result = _run(str(untrusted) + "//", _skills_src(tmp_path))
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith("sanitize ok")
    assert not (untrusted / "CLAUDE.md").exists()
    assert not (untrusted / "torch" / "_dynamo" / "CLAUDE.md").exists()
    # Restore and the exact-path verify allowlist both work under the canonical path.
    assert (untrusted / ".claude" / "skills" / "foo" / "SKILL.md").is_file()
    assert sorted(p.name for p in (untrusted / ".claude").iterdir()) == ["skills"]


def test_forbidden_files_in_trusted_skills_source_are_scrubbed(tmp_path):
    # main's skills tree is trusted and today holds no instruction files, but if
    # one ever appeared the restore must not reintroduce a loadable memory file.
    src = tmp_path / "skills_src_tainted"
    _write(src / ".claude" / "skills" / "foo" / "SKILL.md", "trusted-skill")
    _write(src / ".claude" / "skills" / "foo" / "CLAUDE.md", "sneaky")
    _write(src / ".claude" / "skills" / "bar" / ".claude" / "rules" / "x.md", "nested")
    untrusted = tmp_path / "pytorch"
    _populate_untrusted(untrusted)
    result = _run(str(untrusted), str(src))
    assert result.returncode == 0, result.stderr
    # A legit, non-forbidden skill file survives the scrub.
    assert (untrusted / ".claude" / "skills" / "foo" / "SKILL.md").is_file()
    # A CLAUDE.md and a nested .claude planted in the source are scrubbed.
    assert not (untrusted / ".claude" / "skills" / "foo" / "CLAUDE.md").exists()
    assert not (untrusted / ".claude" / "skills" / "bar" / ".claude").exists()
    assert "trusted skills restored" in result.stdout


def test_success_message_reports_restored_skills(tmp_path):
    untrusted = tmp_path / "pytorch"
    _write(untrusted / "CLAUDE.md")
    result = _run(str(untrusted), _skills_src(tmp_path))
    assert result.returncode == 0, result.stderr
    assert "trusted skills restored" in result.stdout


def test_success_message_reports_no_skills_to_restore(tmp_path):
    untrusted = tmp_path / "pytorch"
    _write(untrusted / "CLAUDE.md")
    result = _run(str(untrusted), _empty_skills_src(tmp_path))
    assert result.returncode == 0, result.stderr
    assert "no skills to restore" in result.stdout
