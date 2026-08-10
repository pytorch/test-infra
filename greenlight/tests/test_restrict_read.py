"""Spec tests for the read-confinement PreToolUse hook.

The hook is a standalone script outside the greenlight package, so it is exercised as a
subprocess under the same interpreter (the way claude-code-action invokes it) rather than
imported. Deny-by-default: a Read/Glob/Grep target is allowed only when its os.path.realpath
lands under $GITHUB_WORKSPACE/pytorch, .claude/skills, .claude/hooks, or the /tmp/greenlight-*
scratch prefix, and never when it carries a .git component or a '..'. exit 0 allows, exit 2
blocks. Living outside the greenlight package, these tests do not affect --cov=greenlight.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[2] / ".claude" / "hooks" / "greenlight" / "restrict-read.py"

_SCRATCH_DIFF = "/tmp/greenlight-pr.diff"  # noqa: S108
_SCRATCH_ABSENT_JSON = "/tmp/greenlight-pr.json"  # noqa: S108


def _run(event: dict[str, object], *, workspace: Path | None) -> subprocess.CompletedProcess[str]:
    assert _SCRIPT.is_file(), f"hook script not found at {_SCRIPT}"
    env = dict(os.environ)
    if workspace is None:
        env.pop("GITHUB_WORKSPACE", None)
    else:
        env["GITHUB_WORKSPACE"] = str(workspace)
    return subprocess.run(  # noqa: S603
        [sys.executable, str(_SCRIPT)],
        input=json.dumps(event),
        capture_output=True,
        text=True,
        env=env,
        cwd=str(workspace) if workspace is not None else None,
        check=False,
    )


def _event(tool_name: str, **tool_input: object) -> dict[str, object]:
    return {"tool_name": tool_name, "tool_input": tool_input}


def _workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    (ws / "pytorch").mkdir(parents=True)
    return ws


def test_script_is_present_and_executable():
    assert _SCRIPT.is_file()
    assert os.access(_SCRIPT, os.X_OK)


def test_read_file_under_pytorch_allowed(tmp_path):
    ws = _workspace(tmp_path)
    target = ws / "pytorch" / "torch" / "foo.py"
    target.parent.mkdir(parents=True)
    target.write_text("x", encoding="utf-8")
    result = _run(_event("Read", file_path=str(target)), workspace=ws)
    assert result.returncode == 0, result.stderr


def test_read_under_claude_skills_allowed(tmp_path):
    ws = _workspace(tmp_path)
    target = ws / ".claude" / "skills" / "greenlight-review" / "SKILL.md"
    target.parent.mkdir(parents=True)
    target.write_text("x", encoding="utf-8")
    result = _run(_event("Read", file_path=str(target)), workspace=ws)
    assert result.returncode == 0, result.stderr


def test_read_under_claude_hooks_allowed(tmp_path):
    ws = _workspace(tmp_path)
    target = ws / ".claude" / "hooks" / "greenlight" / "restrict-read.py"
    target.parent.mkdir(parents=True)
    target.write_text("x", encoding="utf-8")
    result = _run(_event("Read", file_path=str(target)), workspace=ws)
    assert result.returncode == 0, result.stderr


def test_read_scratch_diff_allowed(tmp_path):
    ws = _workspace(tmp_path)
    result = _run(_event("Read", file_path=_SCRATCH_DIFF), workspace=ws)
    assert result.returncode == 0, result.stderr


def test_read_absent_scratch_json_allowed(tmp_path):
    # The hook must never stat for existence: an allowlisted-but-absent scratch path is allowed.
    ws = _workspace(tmp_path)
    assert not os.path.exists(_SCRATCH_ABSENT_JSON)
    result = _run(_event("Read", file_path=_SCRATCH_ABSENT_JSON), workspace=ws)
    assert result.returncode == 0, result.stderr


def test_glob_with_path_under_pytorch_allowed(tmp_path):
    ws = _workspace(tmp_path)
    result = _run(_event("Glob", path=str(ws / "pytorch"), pattern="**/*.py"), workspace=ws)
    assert result.returncode == 0, result.stderr


def test_grep_with_path_under_pytorch_allowed(tmp_path):
    ws = _workspace(tmp_path)
    result = _run(_event("Grep", path=str(ws / "pytorch"), pattern="def ", glob="*.py"), workspace=ws)
    assert result.returncode == 0, result.stderr


def test_read_etc_passwd_denied(tmp_path):
    ws = _workspace(tmp_path)
    result = _run(_event("Read", file_path="/etc/passwd"), workspace=ws)
    assert result.returncode == 2
    assert "outside the allowed roots" in result.stderr


def test_read_proc_self_environ_denied(tmp_path):
    ws = _workspace(tmp_path)
    result = _run(_event("Read", file_path="/proc/self/environ"), workspace=ws)
    assert result.returncode == 2


def test_read_git_config_under_pytorch_denied(tmp_path):
    ws = _workspace(tmp_path)
    target = ws / "pytorch" / ".git" / "config"
    result = _run(_event("Read", file_path=str(target)), workspace=ws)
    assert result.returncode == 2
    assert ".git" in result.stderr


def test_read_symlink_in_pytorch_to_outside_denied(tmp_path):
    # realpath (not a literal compare) resolves the symlink out of the checkout, so it is denied.
    ws = _workspace(tmp_path)
    link = ws / "pytorch" / "sneaky"
    link.symlink_to("/etc/passwd")
    result = _run(_event("Read", file_path=str(link)), workspace=ws)
    assert result.returncode == 2


def test_read_dotdot_traversal_denied(tmp_path):
    ws = _workspace(tmp_path)
    target = str(ws / "pytorch") + "/../etc/passwd"
    result = _run(_event("Read", file_path=target), workspace=ws)
    assert result.returncode == 2
    assert ".." in result.stderr


def test_read_missing_file_path_denied(tmp_path):
    ws = _workspace(tmp_path)
    result = _run({"tool_name": "Read", "tool_input": {}}, workspace=ws)
    assert result.returncode == 2


def test_glob_without_path_denied(tmp_path):
    ws = _workspace(tmp_path)
    result = _run(_event("Glob", pattern="**/*.py"), workspace=ws)
    assert result.returncode == 2
    assert "explicit path" in result.stderr


def test_grep_without_path_denied(tmp_path):
    ws = _workspace(tmp_path)
    result = _run(_event("Grep", pattern="def "), workspace=ws)
    assert result.returncode == 2
    assert "explicit path" in result.stderr


def test_glob_pattern_with_dotdot_denied(tmp_path):
    ws = _workspace(tmp_path)
    result = _run(_event("Glob", path=str(ws / "pytorch"), pattern="../*.py"), workspace=ws)
    assert result.returncode == 2
    assert ".." in result.stderr


def test_read_sibling_pytorch_prefix_denied(tmp_path):
    # The os.sep boundary must not let a sibling that merely shares the 'pytorch' prefix through.
    ws = _workspace(tmp_path)
    evil = ws / "pytorch-evil" / "foo.py"
    evil.parent.mkdir(parents=True)
    evil.write_text("x", encoding="utf-8")
    result = _run(_event("Read", file_path=str(evil)), workspace=ws)
    assert result.returncode == 2


def test_read_claude_non_skills_denied(tmp_path):
    # .claude itself is not an allowed root; only .claude/skills and .claude/hooks are.
    ws = _workspace(tmp_path)
    target = ws / ".claude" / "settings.local.json"
    target.parent.mkdir(parents=True)
    target.write_text("{}", encoding="utf-8")
    result = _run(_event("Read", file_path=str(target)), workspace=ws)
    assert result.returncode == 2


def test_workspace_unset_denied():
    result = _run(_event("Read", file_path="/etc/passwd"), workspace=None)
    assert result.returncode == 2
    assert "GITHUB_WORKSPACE" in result.stderr


def test_unparseable_event_denied(tmp_path):
    ws = _workspace(tmp_path)
    result = subprocess.run(  # noqa: S603
        [sys.executable, str(_SCRIPT)],
        input="{ not json",
        capture_output=True,
        text=True,
        env={**os.environ, "GITHUB_WORKSPACE": str(ws)},
        check=False,
    )
    assert result.returncode == 2


def test_read_nul_byte_in_file_path_denied(tmp_path):
    # An embedded NUL makes os.path.realpath raise ValueError; the fail-closed wrapper in main()
    # must turn that into a blocking exit 2 rather than an uncaught exit 1 (which is non-blocking).
    ws = _workspace(tmp_path)
    result = _run(_event("Read", file_path=str(ws / "pytorch" / "foo\x00.py")), workspace=ws)
    assert result.returncode == 2


def test_grep_regex_dotdot_pattern_allowed(tmp_path):
    # Grep's 'pattern' is a search regex, so '..' ("any two chars") must NOT be blocked.
    ws = _workspace(tmp_path)
    result = _run(_event("Grep", path=str(ws / "pytorch"), pattern="a..b"), workspace=ws)
    assert result.returncode == 0, result.stderr


def test_glob_absolute_pattern_denied(tmp_path):
    ws = _workspace(tmp_path)
    result = _run(_event("Glob", path=str(ws / "pytorch"), pattern="/etc/*"), workspace=ws)
    assert result.returncode == 2
    assert "absolute" in result.stderr


def test_grep_absolute_glob_denied(tmp_path):
    ws = _workspace(tmp_path)
    result = _run(_event("Grep", path=str(ws / "pytorch"), glob="/etc/*"), workspace=ws)
    assert result.returncode == 2
    assert "absolute" in result.stderr


def test_read_uppercase_git_component_denied(tmp_path):
    ws = _workspace(tmp_path)
    result = _run(_event("Read", file_path=str(ws / "pytorch" / ".GIT" / "config")), workspace=ws)
    assert result.returncode == 2
    assert ".git" in result.stderr
