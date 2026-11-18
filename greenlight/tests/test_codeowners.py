"""Pins who owns GreenLight's control plane and its review policy in ``CODEOWNERS``.

pytorch/test-infra requires no status check, so this suite only detects an edit that hands one of these paths to
other owners; code-owner review of ``CODEOWNERS`` itself is the guard. It evaluates the file as GitHub does: the
last matching line wins, with root-anchored gitignore-style patterns only besides the default ``*``. Every other
path keeps the default owners, so GreenLight's approval alone never merges one; a line with no owners may free a
path for it, never one test-infra's review policy stops on. With GREENLIGHT_LIVE_CONFIG_CHECK=1 it also asks GitHub
whether it accepts every owner.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request
from pathlib import Path

import pytest

from greenlight import constants, repo_config

ROOT = Path(__file__).resolve().parents[2]
TEST_INFRA_POLICY = ROOT / ".claude/skills/greenlight-review/repos/test-infra.md"

CONTROL = ["@jeanschmidt", "@drisspg", "@albanD", "@huydhn", "@izaitsevfb", "@jathu"]
POLICY = ["@jeanschmidt", "@ezyang", "@drisspg", "@albanD"]
DEFAULT = ["@pytorch/team-test-infra"]


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
    assert _RULES[0] == ("*", DEFAULT), "the first line gives every path its default owners"
    for pattern, _owners in _RULES[1:]:
        assert pattern.startswith("/"), pattern
        assert not re.search(r"\*\*|[?\[\]!\\]", pattern), f"{pattern}: syntax this test does not evaluate"


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("greenlight/x.py", True),
        ("torchci/greenlight/x.py", False),
        (".github/workflows/greenlight-x.yml", True),
        (".github/workflows/sub/greenlight-x.yml", False),
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
        ".github/workflows/_lambda-do-release-runners.yml",
        ".github/workflows/lambda-release-tag-runners.yml",
        ".github/actions/setup-uv/action.yml",
        ".github/actions/upload-claude-usage/action.yml",
        "torchci/pages/api/greenlight/report.ts",
        "torchci/lib/greenlight/greenlightConfig.ts",
        "torchci/lib/clickhouse.ts",
        "torchci/next.config.js",
        "torchci/tsconfig.json",
        "aws/lambda/clickhouse-replicator-s3/lambda_function.py",
        "tools/torchci/greenlight_replay/__main__.py",
        "tools/torchci/greenlight_decisions/__main__.py",
        "greenlight/repos.yaml",
        constants.GATE_WORKFLOW_PATH,
        "pyproject.toml",
        "uv.toml",
        "uv.lock",
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


@pytest.mark.parametrize(
    "path",
    [
        ".github/workflows/lint.yml",
        ".github/actions/setup-binary-builds/action.yml",
        ".github/scripts/run_with_env_secrets.py",
        ".github/scale-config.yml",
        "torchci/lib/bot/utils.ts",
        "torchci/pages/api/drci/drci.ts",
        "torchci/components/common/TimeUtils.tsx",
        "torchci/scripts/cancelQueuedJobs.mjs",
        "torchci/CLAUDE.md",
        "tools/scripts/get_stable_cuda_version.py",
        "tools/pkg-helpers/pytorch_pkg_helpers/wheel.py",
        "aws/lambda/log-classifier/ruleset.toml",
        "mise.toml",
        "a/path/no/line/names.txt",
    ],
)
def test_every_other_path_has_the_default_owners(path: str) -> None:
    assert owners_of(path) == DEFAULT


def _hard_stop_paths() -> list[str]:
    """Every existing repo path repos/test-infra.md's hard stops name: a line with no owners must never free one."""
    policy = TEST_INFRA_POLICY.read_text(encoding="utf-8")
    stops = policy[policy.index("## Hard stops") :]
    tokens = re.findall(r"`([^`\s]+)`", stops)
    return sorted({token for token in tokens if (ROOT / token.removesuffix("/")).exists()})


def test_no_hard_stop_path_is_freed_for_greenlight() -> None:
    paths = _hard_stop_paths()
    assert len(paths) >= 20, paths
    freed = [p for p in paths if not owners_of(p.removesuffix("/") + ("/x" if p.endswith("/") else ""))]
    assert not freed, f"repos/test-infra.md stops on these paths, but CODEOWNERS leaves them without owners: {freed}"


@pytest.mark.skipif(
    os.environ.get("GREENLIGHT_LIVE_CONFIG_CHECK") != "1",
    reason="live GitHub check; runs only with GREENLIGHT_LIVE_CONFIG_CHECK=1 (the greenlight-tests workflow)",
)
def test_github_accepts_every_code_owner() -> None:
    """GitHub drops an owner it cannot use (a secret team, one without write) and leaves the path unowned."""
    ref = os.environ.get("GITHUB_SHA")
    if not ref:
        pytest.skip("needs GITHUB_SHA, a commit GitHub has")
    request = urllib.request.Request(
        f"https://api.github.com/repos/pytorch/test-infra/codeowners/errors?ref={ref}",
        headers={"Accept": "application/vnd.github+json"},
    )
    if token := os.environ.get("GITHUB_TOKEN"):
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
        errors = json.loads(response.read())["errors"]
    assert errors == []


@pytest.mark.parametrize("path", [".github/CODEOWNERS", "docs/CODEOWNERS"])
def test_only_the_root_codeowners_exists(path: str) -> None:
    assert not (ROOT / path).exists()


def test_the_test_infra_policy_names_every_control_plane_path() -> None:
    policy = TEST_INFRA_POLICY.read_text(encoding="utf-8")
    stops = policy[policy.index("- Merge authorization:") :]
    named = ["/" + token for token in re.findall(r"`([^`\s]+)`", stops)]
    missing = [
        p
        for p, owners in _RULES
        if owners == CONTROL and p not in named and not any(_matches(n, p.removeprefix("/")) for n in named if "*" in n)
    ]
    assert not missing, f"repos/test-infra.md's merge authorization and code ownership stops do not name {missing}"


def test_test_infra_goes_active_only_once_every_path_has_code_owners() -> None:
    """GreenLight's approval satisfies test-infra's one required approval, so an active entry needs the default
    ``*`` line: without it, GreenLight's approval alone merges any path no other line owns."""
    entry = next((e for e in repo_config.load_local().served if e.repo == "pytorch/test-infra"), None)
    if entry is not None and entry.mode == "active":
        assert _RULES[0][0] == "*", "CODEOWNERS must start with a `*` line"
        assert _RULES[0][1], "the `*` line must name owners"
