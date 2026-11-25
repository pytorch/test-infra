"""``greenlight target``: the reviewer workflow's input gate (``workflow_target``)."""

from __future__ import annotations

import base64

import pytest
from github import GithubException, UnknownObjectException

from greenlight import cli, workflow_target
from greenlight.constants import REPO_CONFIG_PATH, TARGET_REPO
from greenlight.exit_codes import EXIT_FAILURE, EXIT_OK

SHA = "a" * 40
_VISION = "pytorch/vision"
_CONFIG = "status_comment: greenlight\nsafety: gate\neligibility: write_permission\nmode: shadow\n"
_DRCI_ACTIVE = "status_comment: drci\nsafety: pytorchbot\neligibility: merge_rules\nmode: active\n"


def _identity(repo: str = _VISION, **changes: object) -> dict[str, object]:
    return {"full_name": repo, "private": False, "default_branch": "main", "archived": False, **changes}


def _contents(text: str) -> dict[str, object]:
    data = text.encode()
    return {"type": "file", "size": len(data), "content": base64.b64encode(data).decode()}


class _Requester:
    def __init__(self, answers: dict[str, object]) -> None:
        self.answers = answers
        self.calls: list[str] = []

    def requestJsonAndCheck(self, verb: str, url: str) -> tuple[dict[str, str], object]:
        assert verb == "GET"
        self.calls.append(url)
        answer = self.answers[url]
        if isinstance(answer, BaseException):
            raise answer
        return {}, answer


class _Client:
    def __init__(self, identity: object, contents: object, repo: str = _VISION) -> None:
        self.requester = _Requester(
            {f"/repos/{repo}": identity, f"/repos/{repo}/contents/{REPO_CONFIG_PATH}": contents}
        )
        self.closed = 0

    def close(self) -> None:
        self.closed += 1


def _builder(client: _Client | None = None) -> workflow_target.BuildClient:
    def build():
        if client is None:
            raise AssertionError("the primary must make no read")
        return client

    return build


def _main(argv: list[str], client: _Client | None = None) -> int:
    if "--head-sha" not in argv:
        argv = [*argv, "--head-sha", SHA]
    args = cli.build_parser().parse_args(["target", *argv])
    return workflow_target.run(args, build_client=_builder(client))


def _outputs(text: str) -> dict[str, str]:
    lines = text.splitlines()
    pairs = dict(line.split("=", 1) for line in lines)
    assert len(pairs) == len(lines)
    return pairs


def test_an_empty_repo_is_the_primary_with_no_read(capsys):
    assert _main(["--strict", "--pr", "123", "--head-sha", SHA]) == EXIT_OK

    captured = capsys.readouterr()
    assert _outputs(captured.out) == {
        "repo": TARGET_REPO,
        "name": "pytorch",
        "pr": "123",
        "head_sha": SHA,
        "checkout": "pytorch",
        "drci_poke": "true",
    }
    assert captured.err == ""


def test_the_repo_defaults_to_empty(capsys):
    assert _main(["--strict", "--pr", "7"]) == EXIT_OK

    assert _outputs(capsys.readouterr().out)["repo"] == TARGET_REPO


@pytest.mark.parametrize("mode", [["--strict"], ["--from-review", "--repo", TARGET_REPO, "--drci-poke", "true"]])
def test_the_head_sha_is_required_in_both_modes(capsys, mode):
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["target", *mode, "--pr", "1"])
    assert _main([*mode, "--pr", "1", "--head-sha", ""]) == EXIT_FAILURE
    assert "head_sha" in capsys.readouterr().err


def test_a_served_repo_passes_the_live_checks_and_closes_its_client(capsys):
    client = _Client(_identity(), _contents(_CONFIG))

    assert _main(["--strict", "--repo", _VISION, "--pr", "9", "--head-sha", SHA], client) == EXIT_OK

    assert _outputs(capsys.readouterr().out) == {
        "repo": _VISION,
        "name": "vision",
        "pr": "9",
        "head_sha": SHA,
        "checkout": "target",
        "drci_poke": "false",
    }
    assert client.requester.calls == [f"/repos/{_VISION}", f"/repos/{_VISION}/contents/{REPO_CONFIG_PATH}"]
    assert client.closed == 1


def test_a_safety_only_repo_is_accepted_and_never_pokes(capsys):
    client = _Client(_identity(), _contents(_CONFIG + "future_key: x\n"))

    assert _main(["--strict", "--repo", _VISION, "--pr", "1"], client) == EXIT_OK

    assert _outputs(capsys.readouterr().out)["drci_poke"] == "false"


@pytest.mark.parametrize(
    ("config", "poke"),
    [(_DRCI_ACTIVE, "true"), (_DRCI_ACTIVE.replace("active", "shadow"), "false")],
    ids=["active", "shadow"],
)
def test_a_drci_entry_pokes_only_when_served_and_active(monkeypatch, capsys, config, poke):
    monkeypatch.setattr("greenlight.repo_config.DRCI_STATUS_COMMENT_REPOS", frozenset({_VISION}))
    monkeypatch.setattr("greenlight.repo_config.PYTORCHBOT_GUARDED_REPOS", frozenset({_VISION}))
    client = _Client(_identity(), _contents(config))

    assert _main(["--strict", "--repo", _VISION, "--pr", "1"], client) == EXIT_OK

    assert _outputs(capsys.readouterr().out)["drci_poke"] == poke


@pytest.mark.parametrize(
    ("identity", "contents", "message"),
    [
        (_identity(private=True), None, "it is private"),
        (_identity(archived=True), None, "it is archived"),
        (_identity(full_name="pytorch/Vision"), _contents(_CONFIG), "GitHub names it"),
        (_identity(default_branch="master"), _contents(_CONFIG), "its default branch is 'master'"),
        (_identity(), UnknownObjectException(404), "neither served nor safety-only"),
        (_identity(), _contents("mode: [\n"), "neither served nor safety-only"),
        (_identity(), GithubException(500), "neither served nor safety-only"),
        (UnknownObjectException(404), None, "UnknownObjectException"),
        ({"full_name": _VISION}, None, "unexpected shape"),
    ],
    ids=[
        "private",
        "archived",
        "renamed",
        "default-branch",
        "no-config",
        "invalid-config",
        "unreadable-config",
        "no-repo",
        "bad-identity",
    ],
)
def test_a_repo_failing_a_live_check_is_refused(capsys, identity, contents, message):
    client = _Client(identity, contents)

    assert _main(["--strict", "--repo", _VISION, "--pr", "1"], client) == EXIT_FAILURE

    captured = capsys.readouterr()
    assert captured.out == ""
    assert message in captured.err
    assert client.closed == 1


@pytest.mark.parametrize(
    "repo",
    [
        "pytorch/pytorch",
        "PyTorch/PyTorch",
        "pytorch/PyTorch",
        "PYTORCH/PYTORCH",
        "pytorch/vision ",
        " pytorch/vision",
        "pytorch/vision\nname=evil",
        "pytorch/.",
        "pytorch/..",
        "pytorch/a/b",
        "pytorch/",
        "facebook/vision",
        "vision",
    ],
)
def test_a_repo_of_the_wrong_shape_is_refused_offline(capsys, repo):
    assert _main(["--strict", "--repo", repo, "--pr", "1"]) == EXIT_FAILURE

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "greenlight target:" in captured.err


@pytest.mark.parametrize(
    ("repo", "valid"),
    [
        ("pytorch/pytorch", True),
        ("pytorch/PyTorch", True),
        ("pytorch/vision", True),
        ("pytorch/a.b_c-d", True),
        ("pytorch/...", True),
        ("PyTorch/vision", False),
        ("pytorch/.", False),
        ("pytorch/..", False),
        ("pytorch/a/b", False),
        ("pytorch/", False),
        ("pytorch/vision\n", False),
        (" pytorch/vision", False),
        ("facebook/vision", False),
        ("vision", False),
    ],
)
def test_is_repo_name_is_the_pattern_without_dot_names(repo, valid):
    assert workflow_target.is_repo_name(repo) is valid


@pytest.mark.parametrize("pr", ["1", "9", "10", "190000"])
def test_require_pr_returns_a_plain_positive_number(pr):
    assert workflow_target.require_pr(pr) == pr


@pytest.mark.parametrize("pr", ["0", "012", "1.5", "-1", "١٢", "", " 1", "1 ", "1\n", "1e3", "+1", "0x1", "²"])
def test_require_pr_refuses_anything_else(pr):
    with pytest.raises(ValueError, match="pr must be a positive decimal number without leading zeros"):
        workflow_target.require_pr(pr)


@pytest.mark.parametrize("pr", ["0", "012", "1.5", "-1", "١٢", "", " 1", "1 ", "1\n", "1e3", "+1", "0x1", "²"])
def test_a_pr_that_is_not_a_plain_positive_number_is_refused(capsys, pr):
    assert _main(["--strict", "--pr", pr]) == EXIT_FAILURE

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "pr must be" in captured.err


@pytest.mark.parametrize("head_sha", ["a" * 39, "a" * 41, "g" * 40, f"{'a' * 40}\n", "main"])
def test_a_bad_head_sha_is_refused(capsys, head_sha):
    assert _main(["--strict", "--pr", "1", "--head-sha", head_sha]) == EXIT_FAILURE

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "head_sha" in captured.err


def _review(input_repo: str, repo: str, poke: str, pr: str = "4", head_sha: str = SHA) -> list[str]:
    flags = {"--input-repo": input_repo, "--repo": repo, "--drci-poke": poke, "--pr": pr, "--head-sha": head_sha}
    return ["--from-review", *(part for flag, value in flags.items() for part in (flag, value))]


@pytest.mark.parametrize(
    ("input_repo", "repo", "name", "checkout", "poke"),
    [("", TARGET_REPO, "pytorch", "pytorch", "true"), (_VISION, _VISION, "vision", "target", "false")],
)
def test_from_review_re_emits_the_reviews_values_with_no_read(capsys, input_repo, repo, name, checkout, poke):
    assert _main(_review(input_repo, repo, poke)) == EXIT_OK

    assert _outputs(capsys.readouterr().out) == {
        "repo": repo,
        "name": name,
        "pr": "4",
        "head_sha": SHA,
        "checkout": checkout,
        "drci_poke": poke,
    }


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (_review("", "", "true"), "is not pytorch/<name>"),
        (_review("pytorch/PyTorch", "pytorch/PyTorch", "false"), "spelling"),
        (_review("pytorch/..", "pytorch/..", "false"), "is not pytorch/<name>"),
        (_review(_VISION, "pytorch/audio", "false"), "is not the dispatch's"),
        (_review("", _VISION, "false"), "is not the dispatch's"),
        (_review(_VISION, TARGET_REPO, "true"), "is not the dispatch's"),
        (_review(TARGET_REPO, TARGET_REPO, "true"), "only through an empty repo"),
        (_review(_VISION, _VISION, ""), "drci_poke"),
        (_review(_VISION, _VISION, "True"), "drci_poke"),
        (_review(_VISION, _VISION, "false", pr="01"), "pr must be"),
        (_review(_VISION, _VISION, "false", head_sha="main"), "head_sha"),
    ],
    ids=[
        "empty-repo",
        "primary-spelling",
        "dot-name",
        "other-repo",
        "other-repo-for-the-primary",
        "primary-for-another-repo",
        "explicit-primary-input",
        "empty-poke",
        "odd-poke",
        "bad-pr",
        "bad-head",
    ],
)
def test_from_review_refuses_a_mismatch_or_a_value_of_the_wrong_shape(capsys, argv, message):
    assert _main(argv) == EXIT_FAILURE

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "greenlight target:" in captured.err
    assert message in captured.err


def test_exactly_one_mode_is_required():
    parser = cli.build_parser()
    for argv in (["target", "--pr", "1"], ["target", "--strict", "--from-review", "--pr", "1"]):
        with pytest.raises(SystemExit):
            parser.parse_args(argv)


def test_another_repo_needs_a_token(monkeypatch, capsys):
    for name in workflow_target.TOKEN_VARIABLES:
        monkeypatch.delenv(name, raising=False)

    args = cli.build_parser().parse_args(["target", "--strict", "--repo", _VISION, "--pr", "1", "--head-sha", SHA])
    assert workflow_target.run(args) == EXIT_FAILURE

    assert "GITHUB_TOKEN" in capsys.readouterr().err


def test_the_token_comes_from_the_environment(monkeypatch):
    built: list[str] = []
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setenv("GH_TOKEN", "t0k")

    def build(token: str) -> _Client:
        built.append(token)
        return _Client(_identity(), None)

    monkeypatch.setattr("greenlight.github_client.build_authz_client", build)

    assert workflow_target._client_from_env().requester.calls == []  # type: ignore[attr-defined]
    assert built == ["t0k"]


def test_the_checkout_rule_names_one_directory_per_repo():
    assert workflow_target.checkout_dirname(TARGET_REPO) == "pytorch"
    assert workflow_target.checkout_dirname(_VISION) == "target"
    assert workflow_target.checkout_dirname("PyTorch/PyTorch") == "target"


def test_the_cli_routes_target_without_logging_to_stdout(capsys):
    assert cli.main(["target", "--strict", "--pr", "5", "--repo", "PyTorch/pytorch", "--head-sha", SHA]) == EXIT_FAILURE

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "PyTorch/pytorch" in captured.err
