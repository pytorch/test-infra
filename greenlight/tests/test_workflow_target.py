"""``greenlight target``: the reviewer workflow's input gate (``workflow_target``)."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from greenlight import cli, repo_config, workflow_target
from greenlight.constants import TARGET_REPO
from greenlight.exit_codes import EXIT_FAILURE, EXIT_OK

if TYPE_CHECKING:
    from pathlib import Path

SHA = "a" * 40

_CONFIG = repo_config.parse(
    """
repos:
  - repo: pytorch/pytorch
    status_comment: drci
    safety: pytorchbot
    eligibility: merge_rules
    mode: active
  - repo: pytorch/vision
    status_comment: greenlight
    safety: gate
    eligibility: write_permission
    mode: shadow
  - repo: pytorch/audio
    status_comment: greenlight
    safety: gate
    eligibility: write_permission
    mode: shadow
    future_key: x
  - repo: pytorch/text
    status_comment: greenlight
    safety: pytorchbot
    eligibility: write_permission
    mode: shadow
"""
)


def _root(tmp_path: Path, *names: str) -> Path:
    policies = tmp_path / workflow_target.POLICY_DIR
    policies.mkdir(parents=True)
    for name in names:
        (policies / f"{name}.md").write_text("policy\n", encoding="utf-8")
    return tmp_path


def _main(argv: list[str], config: repo_config.RepoConfig, root: Path) -> int:
    args = cli.build_parser().parse_args(["target", *argv])
    return workflow_target.run(args, config=config, root=root)


def _outputs(text: str) -> dict[str, str]:
    lines = text.splitlines()
    pairs = dict(line.split("=", 1) for line in lines)
    assert len(pairs) == len(lines)
    return pairs


def test_the_config_fixture_has_the_entries_the_tests_rely_on():
    assert [entry.repo for entry in _CONFIG.served] == ["pytorch/pytorch", "pytorch/vision"]
    assert [entry.repo for entry, _ in _CONFIG.safety_only] == ["pytorch/audio"]
    assert [repo for repo, _ in _CONFIG.refused] == ["pytorch/text"]


def test_an_empty_repo_is_the_primary(tmp_path, capsys):
    root = _root(tmp_path, "pytorch")

    assert _main(["--pr", "123", "--head-sha", SHA], _CONFIG, root) == EXIT_OK

    captured = capsys.readouterr()
    assert _outputs(captured.out) == {
        "repo": TARGET_REPO,
        "name": "pytorch",
        "pr": "123",
        "head_sha": SHA,
        "checkout": "pytorch",
        "policy": ".claude/skills/greenlight-review/repos/pytorch.md",
        "policy_present": "true",
        "drci_poke": "true",
    }
    assert captured.err == ""


def test_the_repo_defaults_to_empty_and_the_head_sha_is_optional(tmp_path, capsys):
    assert _main(["--pr", "7"], _CONFIG, _root(tmp_path)) == EXIT_OK

    outputs = _outputs(capsys.readouterr().out)
    assert outputs["repo"] == TARGET_REPO
    assert outputs["head_sha"] == ""


def test_a_served_repo_other_than_the_primary(tmp_path, capsys):
    root = _root(tmp_path, "vision")

    assert _main(["--repo", "pytorch/vision", "--pr", "9", "--head-sha", SHA], _CONFIG, root) == EXIT_OK

    assert _outputs(capsys.readouterr().out) == {
        "repo": "pytorch/vision",
        "name": "vision",
        "pr": "9",
        "head_sha": SHA,
        "checkout": "target",
        "policy": ".claude/skills/greenlight-review/repos/vision.md",
        "policy_present": "true",
        "drci_poke": "false",
    }


def test_a_safety_only_repo_is_accepted_and_never_pokes(tmp_path, capsys):
    assert _main(["--repo", "pytorch/audio", "--pr", "1"], _CONFIG, _root(tmp_path, "audio")) == EXIT_OK

    outputs = _outputs(capsys.readouterr().out)
    assert outputs["repo"] == "pytorch/audio"
    assert outputs["checkout"] == "target"
    assert outputs["drci_poke"] == "false"


def test_a_missing_policy_file_is_reported_not_refused(tmp_path, capsys):
    assert _main(["--repo", "pytorch/vision", "--pr", "1"], _CONFIG, _root(tmp_path, "pytorch")) == EXIT_OK

    outputs = _outputs(capsys.readouterr().out)
    assert outputs["policy"] == ".claude/skills/greenlight-review/repos/vision.md"
    assert outputs["policy_present"] == "false"


def test_a_policy_path_that_is_a_directory_is_not_present(tmp_path, capsys):
    root = _root(tmp_path)
    (root / workflow_target.POLICY_DIR / "vision.md").mkdir()

    assert _main(["--repo", "pytorch/vision", "--pr", "1"], _CONFIG, root) == EXIT_OK

    assert _outputs(capsys.readouterr().out)["policy_present"] == "false"


@pytest.mark.parametrize(
    "repo",
    [
        "pytorch/pytorch",
        "PyTorch/PyTorch",
        "pytorch/PyTorch",
        "PYTORCH/PYTORCH",
        "Pytorch/Vision",
        "pytorch/Vision",
        "pytorch/unknown",
        "pytorch/text",
        "pytorch/vision ",
        " pytorch/vision",
        "pytorch/vision\nname=evil",
        "facebook/vision",
        "vision",
    ],
)
def test_a_repo_that_is_not_an_exact_non_primary_entry_is_refused(tmp_path, capsys, repo):
    assert _main(["--repo", repo, "--pr", "1"], _CONFIG, _root(tmp_path, "pytorch", "vision")) == EXIT_FAILURE

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "greenlight target:" in captured.err


@pytest.mark.parametrize("pr", ["0", "012", "1.5", "-1", "١٢", "", " 1", "1 ", "1\n", "1e3", "+1", "0x1", "²"])
def test_a_pr_that_is_not_a_plain_positive_number_is_refused(tmp_path, capsys, pr):
    assert _main(["--pr", pr], _CONFIG, _root(tmp_path, "pytorch")) == EXIT_FAILURE

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "pr must be" in captured.err


@pytest.mark.parametrize("head_sha", ["a" * 39, "a" * 41, "g" * 40, f"{'a' * 40}\n", "main"])
def test_a_bad_head_sha_is_refused(tmp_path, capsys, head_sha):
    assert _main(["--pr", "1", "--head-sha", head_sha], _CONFIG, _root(tmp_path, "pytorch")) == EXIT_FAILURE

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "head_sha" in captured.err


@pytest.mark.parametrize(
    ("text", "poke"),
    [
        ("status_comment: drci\n    safety: pytorchbot\n    eligibility: merge_rules\n    mode: active", True),
        ("status_comment: drci\n    safety: pytorchbot\n    eligibility: merge_rules\n    mode: shadow", False),
        ("status_comment: drci\n    safety: pytorchbot\n    eligibility: merge_rules\n    mode: off", False),
        ("status_comment: drci\n    safety: pytorchbot\n    eligibility: merge_rules\n    mode: bogus", False),
    ],
    ids=["active", "shadow", "off", "safety-only"],
)
def test_the_primary_pokes_dr_ci_only_when_served_and_active(tmp_path, capsys, text, poke):
    config = repo_config.parse(f"repos:\n  - repo: pytorch/pytorch\n    {text}\n")

    assert _main(["--pr", "1"], config, _root(tmp_path)) == EXIT_OK

    assert _outputs(capsys.readouterr().out)["drci_poke"] == ("true" if poke else "false")


def test_a_greenlight_status_comment_never_pokes_dr_ci():
    entry = repo_config.RepoEntry("pytorch/vision", "greenlight", "gate", "write_permission", "shadow")
    active = repo_config.RepoEntry("pytorch/vision", "greenlight", "pytorchbot", "merge_rules", "active")
    for found in (entry, active):
        config = repo_config.RepoConfig(served=(repo_config.BUILTIN_PYTORCH, found), safety_only=(), refused=())
        target = workflow_target.resolve("pytorch/vision", "1", "", config=config, root=workflow_target._default_root())
        assert target.drci_poke is False


def test_a_drci_entry_poke_follows_served_and_mode():
    drci = repo_config.RepoEntry("pytorch/vision", "drci", "gate", "write_permission", "active")
    served = repo_config.RepoConfig(served=(repo_config.BUILTIN_PYTORCH, drci), safety_only=(), refused=())
    safety_only = repo_config.RepoConfig(
        served=(repo_config.BUILTIN_PYTORCH,), safety_only=((drci, "unknown key(s)"),), refused=()
    )
    root = workflow_target._default_root()

    assert workflow_target.resolve("pytorch/vision", "1", "", config=served, root=root).drci_poke is True
    assert workflow_target.resolve("pytorch/vision", "1", "", config=safety_only, root=root).drci_poke is False


def test_a_config_without_the_primary_refuses_the_empty_repo(tmp_path, capsys):
    config = repo_config.RepoConfig(served=(), safety_only=(), refused=())

    assert _main(["--pr", "1"], config, _root(tmp_path)) == EXIT_FAILURE

    captured = capsys.readouterr()
    assert captured.out == ""
    assert TARGET_REPO in captured.err


@pytest.mark.parametrize("name", [".", ".."])
def test_a_dot_name_is_refused_even_when_configured(name):
    entry = repo_config.RepoEntry(f"pytorch/{name}", "greenlight", "gate", "write_permission", "shadow")
    config = repo_config.RepoConfig(served=(repo_config.BUILTIN_PYTORCH, entry), safety_only=(), refused=())

    with pytest.raises(ValueError, match="no usable name"):
        workflow_target.resolve(f"pytorch/{name}", "1", "", config=config, root=workflow_target._default_root())


def test_the_rules_name_one_checkout_and_one_policy_file_per_repo():
    assert workflow_target.checkout_dirname(TARGET_REPO) == "pytorch"
    assert workflow_target.checkout_dirname("pytorch/vision") == "target"
    assert workflow_target.checkout_dirname("PyTorch/PyTorch") == "target"
    assert workflow_target.policy_path("pytorch/vision") == ".claude/skills/greenlight-review/repos/vision.md"


def test_the_default_root_is_the_test_infra_checkout():
    root = workflow_target._default_root()

    assert (root / "greenlight" / "repos.yaml").is_file()
    assert (root / ".github" / "workflows" / "greenlight-pr-review.yml").is_file()


def test_run_reads_the_local_config_and_root_by_default(capsys):
    args = cli.build_parser().parse_args(["target", "--pr", "5"])

    assert workflow_target.run(args) == EXIT_OK

    outputs = _outputs(capsys.readouterr().out)
    assert outputs["repo"] == TARGET_REPO
    assert outputs["checkout"] == "pytorch"


def test_the_cli_routes_target_without_logging_to_stdout(capsys):
    assert cli.main(["target", "--pr", "5", "--repo", "pytorch/not-configured"]) == EXIT_FAILURE

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "pytorch/not-configured" in captured.err
