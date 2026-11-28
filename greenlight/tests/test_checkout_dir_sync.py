"""Pins the checkout-directory rule of ``workflow_target``, and the repo-name shape, to their copies.

The reviewer workflow checks the reviewed repo out into the directory ``greenlight target`` names,
the read-confinement hook (``.claude/hooks/greenlight/restrict-read.py``) accepts only those names as
its argument, and the policy replay harness (``tools/torchci/greenlight_replay/checkout.py``) lays
out its workspaces by the same rule. The harness and the policy staging script
(``.claude/hooks/greenlight/repo-policy.py``) accept the repo names ``greenlight target`` accepts.
None of them can import greenlight, so all are read as source.
"""

from __future__ import annotations

import ast
import importlib.util
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from greenlight import workflow_target
from greenlight.constants import TARGET_REPO
from greenlight.workflow_target import OTHER_CHECKOUT, PRIMARY_CHECKOUT, REPO_NAME_RE

if TYPE_CHECKING:
    from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]
_HARNESS = ROOT / "tools" / "torchci" / "greenlight_replay" / "checkout.py"
_HOOK = ROOT / ".claude" / "hooks" / "greenlight" / "restrict-read.py"
_STAGING = ROOT / ".claude" / "hooks" / "greenlight" / "repo-policy.py"
_HARNESS_QUERY = ROOT / "tools" / "torchci" / "greenlight_decisions" / "query.py"


def _module(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _function(module: ast.Module, name: str) -> ast.FunctionDef:
    found = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == name]
    assert len(found) == 1, f"expected one top-level def {name}, found {len(found)}"
    return found[0]


def _constant(module: ast.Module, name: str) -> object:
    for node in module.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == name for target in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError(f"no top-level {name} assignment")


def test_the_harness_checkout_dirname_maps_the_primary_to_pytorch_and_every_other_repo_to_target():
    function = _function(_module(_HARNESS), "checkout_dirname")
    assert ast.unparse(function.args) == "repo: str"
    assert function.returns is not None
    assert ast.unparse(function.returns) == "str"
    [ternary] = [node for node in ast.walk(function) if isinstance(node, ast.IfExp)]
    assert isinstance(ternary.body, ast.Constant)
    assert ternary.body.value == PRIMARY_CHECKOUT
    assert isinstance(ternary.orelse, ast.Constant)
    assert ternary.orelse.value == OTHER_CHECKOUT
    compared = [node.value for node in ast.walk(ternary.test) if isinstance(node, ast.Constant)]
    assert compared == [TARGET_REPO]
    assert isinstance(ternary.test, ast.Compare)
    assert isinstance(ternary.test.ops[0], ast.Eq)


def test_the_harness_lists_exactly_the_two_checkout_directories():
    assert _constant(_module(_HARNESS), "CHECKOUT_DIRNAMES") == (PRIMARY_CHECKOUT, OTHER_CHECKOUT)


def test_the_hook_accepts_exactly_the_two_checkout_directories_and_defaults_to_the_primarys():
    hook = _module(_HOOK)
    assert _constant(hook, "_CHECKOUTS") == (PRIMARY_CHECKOUT, OTHER_CHECKOUT)
    assert _constant(hook, "_DEFAULT_CHECKOUT") == PRIMARY_CHECKOUT


def test_the_harness_and_the_staging_script_accept_the_repo_name_shape_greenlight_target_accepts():
    assert _constant_call_argument(_module(_HARNESS), "_REVIEWED_REPO") == REPO_NAME_RE.pattern
    assert _constant_call_argument(_module(_STAGING), "REPO_RE") == REPO_NAME_RE.pattern
    assert _constant(_module(_STAGING), "PRIMARY_REPO") == TARGET_REPO


def _constant_call_argument(module: ast.Module, name: str) -> object:
    for node in module.body:
        if (
            isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)
            and isinstance(node.value, ast.Call)
        ):
            return ast.literal_eval(node.value.args[0])
    raise AssertionError(f"no top-level {name} = <call>(<literal>) assignment")


def _staging_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("repo_policy_script", _STAGING)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _harness_require_repo() -> Any:
    """The harness's ``require_repo`` alone, built from its source: checkout.py imports torchci, which
    greenlight's environment lacks, so only that function and the pattern it reads are compiled."""
    module = _module(_HARNESS)
    source = _HARNESS.read_text(encoding="utf-8")
    wanted = [
        node
        for node in module.body
        if (isinstance(node, ast.FunctionDef) and node.name == "require_repo")
        or (isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "_REVIEWED_REPO" for t in node.targets))
    ]
    assert len(wanted) == 2
    namespace: dict[str, Any] = {"re": re, "DEFAULT_REPO": _constant(_module(_HARNESS_QUERY), "DEFAULT_REPO")}
    for node in wanted:
        segment = ast.get_source_segment(source, node)
        assert segment is not None
        exec(compile(segment, str(_HARNESS), "exec"), namespace)  # noqa: S102
    return namespace["require_repo"]


def _accepts(check: Any, repo: str) -> bool:
    try:
        check(repo)
    except ValueError:
        return False
    return True


@pytest.mark.parametrize(
    ("repo", "accepted"),
    [
        ("pytorch/vision", True),
        (TARGET_REPO, True),
        ("pytorch/.", False),
        ("pytorch/..", False),
        ("PyTorch/pytorch", False),
        ("pytorch/PyTorch", False),
        ("pytorch/a/b", False),
        ("other/x", False),
        ("pytorch/", False),
    ],
)
def test_greenlight_target_the_staging_script_and_the_harness_accept_the_same_repo_names(repo, accepted):
    checks = {
        "greenlight target": workflow_target._require_repo,
        "repo-policy.py": _staging_module()._require_repo,
        "the replay harness": _harness_require_repo(),
    }
    assert {name: _accepts(check, repo) for name, check in checks.items()} == dict.fromkeys(checks, accepted)
