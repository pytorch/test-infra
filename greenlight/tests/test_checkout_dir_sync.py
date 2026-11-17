"""Pins the checkout-directory rule of ``workflow_target``, and the repo-name shape, to their copies.

The reviewer workflow checks the reviewed repo out into the directory ``greenlight target`` names,
the read-confinement hook (``.claude/hooks/greenlight/restrict-read.py``) accepts only those names as
its argument, and the policy replay harness (``tools/torchci/greenlight_replay/checkout.py``) lays
out its workspaces by the same rule. Neither can import greenlight, so both are read as source.
"""

from __future__ import annotations

import ast
from pathlib import Path

from greenlight import repo_config
from greenlight.constants import TARGET_REPO
from greenlight.workflow_target import OTHER_CHECKOUT, PRIMARY_CHECKOUT

ROOT = Path(__file__).resolve().parents[2]
_HARNESS = ROOT / "tools" / "torchci" / "greenlight_replay" / "checkout.py"
_HOOK = ROOT / ".claude" / "hooks" / "greenlight" / "restrict-read.py"


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


def test_the_harness_accepts_the_repo_name_shape_repos_yaml_accepts():
    pattern = _constant_call_argument(_module(_HARNESS), "_REVIEWED_REPO")
    assert pattern == repo_config.REPO_NAME.pattern


def _constant_call_argument(module: ast.Module, name: str) -> object:
    for node in module.body:
        if (
            isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)
            and isinstance(node.value, ast.Call)
        ):
            return ast.literal_eval(node.value.args[0])
    raise AssertionError(f"no top-level {name} = <call>(<literal>) assignment")
