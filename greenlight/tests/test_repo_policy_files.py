"""Pins the review policy's split into the general skill and one repository file per configured repo."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from greenlight import repo_config

ROOT = Path(__file__).resolve().parents[2]
_POLICY = ROOT / ".claude/skills/greenlight-review"
_SKILL = _POLICY / "SKILL.md"
_REPOS = _POLICY / "repos"
_LOAD_PATTERN = ".claude/skills/greenlight-review/repos/<name>.md"
_REQUIRED_HEADINGS = ("User-facing surface", "Merge-gating workflows", "Lint gate", "Test layout")
_META_INTERNAL = re.compile(r"^### Meta-internal only[ \t]*$", re.MULTILINE)
_PRIMARY_FILE = "pytorch.md"


def _configured_names() -> list[str]:
    """The ``<name>`` of every ``pytorch/<name>`` entry in repos.yaml, served, safety-only or refused alike."""
    items = repo_config._load_document(repo_config._default_path().read_bytes())
    names = [repo.removeprefix("pytorch/") for item in items if (repo := repo_config._repo_name(item)) is not None]
    assert names, "repos.yaml names no pytorch/<name> repo"
    return names


def _repo_files() -> list[Path]:
    files = sorted(_REPOS.glob("*.md"))
    assert files, f"{_REPOS} holds no repository file"
    return files


def _level_two_headings(text: str) -> set[str]:
    return {heading.strip() for heading in re.findall(r"^## (.+)$", text, re.MULTILINE)}


@pytest.mark.parametrize("name", _configured_names())
def test_every_configured_repo_has_a_repository_file(name: str) -> None:
    path = _REPOS / f"{name}.md"
    assert path.is_file(), f"pytorch/{name} is in repos.yaml but {path.relative_to(ROOT)} is missing"
    assert path.read_text(encoding="utf-8").strip(), f"{path.relative_to(ROOT)} is empty"


@pytest.mark.parametrize("path", _repo_files(), ids=lambda path: path.name)
def test_every_repository_file_defines_the_required_terms(path: Path) -> None:
    missing = set(_REQUIRED_HEADINGS) - _level_two_headings(path.read_text(encoding="utf-8"))
    assert not missing, f"{path.name} lacks the required section(s) {sorted(missing)}"


def test_only_the_pytorch_file_holds_the_meta_internal_class() -> None:
    holders = [
        path.name for path in [_SKILL, *_repo_files()] if _META_INTERNAL.search(path.read_text(encoding="utf-8"))
    ]
    assert holders == [_PRIMARY_FILE], f"'### Meta-internal only' is in {holders}, not only {_PRIMARY_FILE}"


def test_the_policy_files_are_regular_files() -> None:
    assert not _REPOS.is_symlink(), f"{_REPOS.relative_to(ROOT)} is a symlink"
    for path in [_SKILL, *_repo_files()]:
        assert path.is_file(), f"{path.relative_to(ROOT)} is not a file"
        assert not path.is_symlink(), f"{path.relative_to(ROOT)} is a symlink"


def test_the_skill_tells_the_model_which_repository_file_to_read() -> None:
    assert _LOAD_PATTERN in _SKILL.read_text(encoding="utf-8")
