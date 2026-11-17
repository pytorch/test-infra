"""Pins who owns GreenLight's control plane and its review policy in ``CODEOWNERS``.

pytorch/test-infra requires no status check, so this suite only detects an edit that hands one of these paths to
other owners; code-owner review of ``CODEOWNERS`` itself is the guard. It evaluates the file as GitHub does: the
last matching line wins, with root-anchored gitignore-style patterns only.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from greenlight import constants

ROOT = Path(__file__).resolve().parents[2]

CONTROL = ["@jeanschmidt", "@drisspg", "@albanD", "@huydhn", "@izaitsevfb", "@jathu"]
POLICY = ["@jeanschmidt", "@ezyang", "@drisspg", "@albanD"]


def _rules() -> list[tuple[str, list[str]]]:
    rules: list[tuple[str, list[str]]] = []
    for line in (ROOT / "CODEOWNERS").read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            pattern, *owners = line.split()
            rules.append((pattern, owners))
    return rules


_RULES = _rules()


def _matches(pattern: str, path: str) -> bool:
    """``/dir/`` covers everything below it, ``*`` stays within one segment, and a plain path matches itself."""
    body = re.escape(pattern.removeprefix("/").removesuffix("/")).replace(r"\*", "[^/]*")
    return re.fullmatch(body + ("/.+" if pattern.endswith("/") else "(/.+)?"), path) is not None


def owners_of(path: str) -> list[str]:
    owners: list[str] = []
    for pattern, line_owners in _RULES:
        if _matches(pattern, path):
            owners = line_owners
    return owners


def test_every_pattern_is_root_anchored_and_supported() -> None:
    for pattern, owners in _RULES:
        assert pattern.startswith("/"), pattern
        assert not re.search(r"\*\*|[?\[\]!\\]", pattern), f"{pattern}: syntax this test does not evaluate"
        assert owners, pattern


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("greenlight/x.py", True),
        ("torchci/greenlight/x.py", False),
        (".github/workflows/greenlight-x.yml", True),
        (".github/workflows/sub/x.yml", True),
        ("tools/.github/workflows/x.yml", False),
        ("pyproject.toml", True),
        ("greenlight/pyproject.toml", True),
        ("tools/pyproject.toml", False),
    ],
)
def test_matching_is_root_anchored(path: str, expected: bool) -> None:
    assert (owners_of(path) == CONTROL) is expected


@pytest.mark.parametrize(
    "path",
    [
        ".github/workflows/lint.yml",
        ".github/workflows/new-push-workflow.yml",
        ".github/actions/checkout/action.yml",
        ".github/actions/new-action/action.yml",
        ".github/workflows/_lambda-do-release-runners.yml",
        ".github/workflows/lambda-release-tag-runners.yml",
        ".github/actions/setup-uv/action.yml",
        ".github/actions/upload-claude-usage/action.yml",
        "torchci/pages/api/greenlight/report.ts",
        "torchci/lib/greenlight/greenlightConfig.ts",
        "torchci/lib/clickhouse.ts",
        "torchci/next.config.js",
        "torchci/tsconfig.json",
        "torchci/package.json",
        "torchci/yarn.lock",
        "torchci/lib/auth/allowList.json",
        "torchci/lib/api/auth.ts",
        "torchci/pages/api/auth/[...nextauth].ts",
        "aws/lambda/clickhouse-replicator-s3/lambda_function.py",
        "tools/torchci/greenlight_replay/__main__.py",
        "tools/torchci/greenlight_decisions/__main__.py",
        "greenlight/repos.yaml",
        constants.GATE_WORKFLOW_PATH,
        "pyproject.toml",
        "uv.toml",
        "uv.lock",
        "mise.toml",
        ".mise.toml",
        "mise.local.toml",
        ".mise.local.toml",
        ".tool-versions",
        ".config/mise/config.toml",
        ".config/mise.toml",
        ".mise/config.toml",
        "mise/config.toml",
        "mise/config.local.toml",
        ".rtx.toml",
        ".rtx.local.toml",
        "CODEOWNERS",
        ".github/CODEOWNERS",
        "docs/CODEOWNERS",
        *sorted(str(p.relative_to(ROOT)) for p in ROOT.glob(".github/workflows/greenlight-*.yml")),
        *sorted(str(p.relative_to(ROOT)) for p in ROOT.glob(".github/scripts/greenlight_*")),
    ],
)
def test_control_plane_is_owned_by_greenlight_owners(path: str) -> None:
    assert owners_of(path) == CONTROL


@pytest.mark.parametrize(
    "path",
    [
        ".claude/skills/ci-metrics/SKILL.md",
        ".claude/settings.json",
        ".claude/hooks/greenlight/restrict-read.py",
        ".claude/skills/greenlight-review/SKILL.md",
        "CLAUDE.md",
        "CLAUDE.local.md",
        "AGENTS.md",
        ".mcp.json",
    ],
)
def test_review_policy_is_owned_by_policy_owners(path: str) -> None:
    assert owners_of(path) == POLICY


@pytest.mark.parametrize("path", [".github/CODEOWNERS", "docs/CODEOWNERS"])
def test_only_the_root_codeowners_exists(path: str) -> None:
    assert not (ROOT / path).exists()
