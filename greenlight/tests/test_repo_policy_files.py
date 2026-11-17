"""Pins the review policy's layout: the general skill plus the one repository policy it reads."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_POLICY = ROOT / ".claude/skills/greenlight-review"
_SKILL = _POLICY / "SKILL.md"
_REPO_POLICY = _POLICY / "repo-policy.md"
_REPO_POLICY_PATH = ".claude/skills/greenlight-review/repo-policy.md"
_REPO_OWN_DIR = ".github/greenlight/"
_REQUIRED_HEADINGS = ("User-facing surface", "Merge-gating workflows", "Lint gate", "Test layout")
_META_INTERNAL = re.compile(r"^### Meta-internal only[ \t]*$", re.MULTILINE)


def _level_two_headings(text: str) -> set[str]:
    return {heading.strip() for heading in re.findall(r"^## (.+)$", text, re.MULTILINE)}


def test_the_policy_files_are_regular_files() -> None:
    for path in (_SKILL, _REPO_POLICY):
        assert path.is_file(), f"{path.relative_to(ROOT)} is not a file"
        assert not path.is_symlink(), f"{path.relative_to(ROOT)} is a symlink"


def test_the_repository_policy_defines_the_required_terms() -> None:
    missing = set(_REQUIRED_HEADINGS) - _level_two_headings(_REPO_POLICY.read_text(encoding="utf-8"))
    assert not missing, f"{_REPO_POLICY.name} lacks the required section(s) {sorted(missing)}"


def test_the_repository_policy_holds_the_meta_internal_class() -> None:
    assert _META_INTERNAL.search(_REPO_POLICY.read_text(encoding="utf-8"))
    assert not _META_INTERNAL.search(_SKILL.read_text(encoding="utf-8"))


def test_the_skill_names_the_repository_policy_and_the_repos_own_directory() -> None:
    text = _SKILL.read_text(encoding="utf-8")
    assert _REPO_POLICY_PATH in text
    assert _REPO_OWN_DIR in text


def test_no_per_repo_policy_directory_remains() -> None:
    assert not (_POLICY / "repos").exists()
