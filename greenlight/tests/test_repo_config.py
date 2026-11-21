from __future__ import annotations

import dataclasses
import json
import logging
import os
import textwrap
import urllib.error
import urllib.request
from typing import TYPE_CHECKING, NoReturn

import pytest
import yaml

from greenlight import merge_authz, repo_config
from greenlight.constants import (
    DISPATCH_REPO,
    FULL_TICK_MINUTES_DEFAULT,
    FULL_TICK_MINUTES_MAX,
    FULL_TICK_MINUTES_MIN,
    MERGE_RULES_PATH,
    REPOS_CONFIG_PATH,
    TARGET_REPO,
)
from greenlight.repo_config import BUILTIN_CONFIG, BUILTIN_PYTORCH, ConfigUnreadable, RepoConfig, RepoEntry
from greenlight.repo_scan import RepoIdentity, identity_problem

if TYPE_CHECKING:
    from pathlib import Path

_PYTORCH = """\
  - repo: pytorch/pytorch
    status_comment: drci
    safety: pytorchbot
    eligibility: merge_rules
    mode: {mode}
"""


def _entry(repo: str, **fields: str) -> str:
    values = {"status_comment": "greenlight", "safety": "gate", "eligibility": "merge_rules", "mode": "shadow"}
    values.update(fields)
    lines = [f"  - repo: {repo}"] + [f"    {key}: {value}" for key, value in values.items() if value != "<absent>"]
    return "\n".join(lines) + "\n"


def _parse(*entries: str, pytorch_mode: str | None = "active") -> RepoConfig:
    body = (_PYTORCH.format(mode=pytorch_mode) if pytorch_mode is not None else "") + "".join(entries)
    return repo_config.parse("repos:\n" + body)


_CHANGE_KEYS = ("change_source", "full_tick_minutes")


def test_the_real_repos_yaml_parses_with_no_problem_and_its_primary_is_the_builtin():
    config = repo_config.load_local()
    written = yaml.safe_load(repo_config._default_path().read_text())["repos"]
    primary = config.served[0]
    pinned = {key: value for key, value in dataclasses.asdict(BUILTIN_PYTORCH).items() if key not in _CHANGE_KEYS}
    [written_primary] = [entry for entry in written if entry["repo"] == TARGET_REPO]

    assert config.problems == ()
    assert {key: value for key, value in dataclasses.asdict(primary).items() if key not in _CHANGE_KEYS} == pinned
    assert primary.change_source in repo_config.CHANGE_SOURCES
    assert FULL_TICK_MINUTES_MIN <= primary.full_tick_minutes <= FULL_TICK_MINUTES_MAX
    assert {key: value for key, value in written_primary.items() if key not in _CHANGE_KEYS} == pinned


def test_a_valid_config_serves_every_entry_in_file_order_with_the_primary_first():
    config = repo_config.parse(
        "repos:\n" + _entry("pytorch/vision") + _PYTORCH.format(mode="active") + _entry("pytorch/audio", mode="off")
    )

    assert [entry.repo for entry in config.served] == [TARGET_REPO, "pytorch/vision", "pytorch/audio"]
    assert config.served[1] == RepoEntry("pytorch/vision", "greenlight", "gate", "merge_rules", "shadow")
    assert config.safety_only == ()
    assert config.refused == ()
    assert config.problems == ()


@pytest.mark.parametrize(
    ("text", "match"),
    [
        pytest.param("repos: [", "not valid YAML", id="bad-yaml"),
        pytest.param("- a\n", "top level must be a mapping", id="top-level-list"),
        pytest.param("", "top level must be a mapping", id="empty"),
        pytest.param("other: 1\n", "repos must be a list", id="no-repos"),
        pytest.param("repos: {a: 1}\n", "repos must be a list", id="repos-not-a-list"),
        pytest.param(b"\xff\xfe\x00", "not valid YAML", id="not-text"),
    ],
)
def test_a_file_that_cannot_be_used_as_a_whole_is_unreadable(text, match):
    with pytest.raises(ConfigUnreadable, match=match):
        repo_config.parse(text)


def test_unknown_top_level_keys_are_ignored_with_a_warning(caplog):
    with caplog.at_level(logging.WARNING, logger="greenlight"):
        config = repo_config.parse("version: 2\nrepos:\n" + _PYTORCH.format(mode="active"))

    assert config.served == (BUILTIN_PYTORCH,)
    assert "unknown top-level key(s) ['version'] ignored" in caplog.text


@pytest.mark.parametrize(
    ("entry", "reason"),
    [
        pytest.param("  - 5\n", "the entry is not a mapping", id="not-a-mapping"),
        pytest.param("  - mode: shadow\n", "repo must be pytorch/<name>", id="no-repo"),
        pytest.param(_entry("meta/vision"), "repo must be pytorch/<name>", id="other-org"),
        pytest.param(_entry("pytorch/vi sion"), "repo must be pytorch/<name>", id="bad-name"),
        pytest.param(_entry("pytorch/vision", mode="<absent>"), "mode is missing", id="missing-field"),
        pytest.param(_entry("pytorch/vision", safety="none"), "safety 'none' is not one of", id="bad-enum"),
        pytest.param(_entry("pytorch/vision", safety="pytorchbot"), "safety: pytorchbot is only for", id="pytorchbot"),
        pytest.param(_entry("pytorch/vision", mode="active"), "safety: gate cannot be active", id="active-gate"),
    ],
)
def test_a_bad_non_primary_entry_is_refused_and_the_rest_still_served(entry, reason):
    config = _parse(entry, _entry("pytorch/audio"))

    assert [served.repo for served in config.served] == [TARGET_REPO, "pytorch/audio"]
    [(repo, why)] = config.refused
    assert reason in why
    assert f"{repo} is refused: {why}" in config.problems


def test_a_non_primary_drci_entry_is_served():
    # Which repos Dr. CI renders is the drci entries themselves, mirrored by torchci's GREENLIGHT_REPOS
    # (tests/test_render_sync.py), so the loader takes drci for any repo.
    config = _parse(_entry("pytorch/vision", status_comment="drci"))

    assert config.refused == ()
    assert config.lookup("pytorch/vision") == (
        RepoEntry("pytorch/vision", "drci", "gate", "merge_rules", "shadow"),
        True,
    )


def test_every_copy_of_a_duplicated_repo_is_refused_case_insensitively():
    config = _parse(_entry("pytorch/vision"), _entry("pytorch/Vision"))

    assert config.served == (BUILTIN_PYTORCH,)
    assert [repo for repo, _ in config.refused] == ["pytorch/vision", "pytorch/Vision"]
    assert all("listed more than once" in reason for _, reason in config.refused)


def test_a_non_primary_entry_with_an_unknown_key_is_safety_only():
    config = _parse(_entry("pytorch/vision", gate_workflow="x"))

    [(entry, reason)] = config.safety_only
    assert entry == RepoEntry("pytorch/vision", "greenlight", "gate", "merge_rules", "shadow")
    assert reason == "unknown key(s) ['gate_workflow']"
    assert config.lookup("pytorch/vision") == (entry, False)


def test_an_unknown_key_never_saves_an_otherwise_refused_entry():
    config = _parse(_entry("pytorch/vision", mode="active", gate_workflow="x"))

    assert config.safety_only == ()
    assert [repo for repo, _ in config.refused] == ["pytorch/vision"]


def test_a_non_primary_entry_without_the_change_keys_takes_their_defaults():
    [_, entry] = _parse(_entry("pytorch/vision")).served

    assert entry.change_source == "github"
    assert entry.full_tick_minutes == FULL_TICK_MINUTES_DEFAULT


@pytest.mark.parametrize(
    ("fields", "reason"),
    [
        pytest.param(
            {"change_source": "hud"}, "change_source 'hud' is not one of ['github', 'clickhouse']", id="bad-source"
        ),
        pytest.param(
            {"full_tick_minutes": "240"},
            "full_tick_minutes is only for change_source: clickhouse",
            id="defaulted-github",
        ),
        pytest.param(
            {"change_source": "github", "full_tick_minutes": "240"},
            "full_tick_minutes is only for change_source: clickhouse",
            id="github",
        ),
        *(
            pytest.param(
                {"change_source": "clickhouse", "full_tick_minutes": written},
                f"full_tick_minutes {shown} is not an integer from 60 to 1440",
                id=f"minutes-{written}",
            )
            for written, shown in [
                ("59", "59"),
                ("1441", "1441"),
                ("0", "0"),
                ("!!bool true", "True"),
                ("'240'", "'240'"),
                ("240.0", "240.0"),
                ("null", "None"),
            ]
        ),
    ],
)
def test_a_bad_change_key_refuses_a_non_primary_entry(fields, reason):
    config = _parse(_entry("pytorch/vision", **fields))

    assert config.served == (BUILTIN_PYTORCH,)
    assert config.refused == (("pytorch/vision", reason),)


@pytest.mark.parametrize("minutes", [FULL_TICK_MINUTES_MIN, 240, FULL_TICK_MINUTES_MAX])
def test_a_clickhouse_non_primary_entry_is_served_with_its_full_tick_minutes(minutes):
    config = _parse(_entry("pytorch/vision", change_source="clickhouse", full_tick_minutes=str(minutes)))

    assert config.problems == ()
    assert config.lookup("pytorch/vision") == (
        RepoEntry("pytorch/vision", "greenlight", "gate", "merge_rules", "shadow", "clickhouse", minutes),
        True,
    )


def test_a_clickhouse_non_primary_entry_without_full_tick_minutes_takes_the_default():
    [_, entry] = _parse(_entry("pytorch/vision", change_source="clickhouse")).served

    assert (entry.change_source, entry.full_tick_minutes) == ("clickhouse", FULL_TICK_MINUTES_DEFAULT)


def test_the_primary_without_the_change_keys_takes_the_builtins_silently(caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        config = _parse()

    assert config.served == (BUILTIN_PYTORCH,)
    assert caplog.text == ""


def test_the_primary_takes_valid_change_keys_from_the_file(caplog):
    text = "repos:\n" + _PYTORCH.format(mode="active") + "    change_source: clickhouse\n    full_tick_minutes: 60\n"
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        config = repo_config.parse(text)

    assert config.served == (dataclasses.replace(BUILTIN_PYTORCH, change_source="clickhouse", full_tick_minutes=60),)
    assert caplog.text == ""


@pytest.mark.parametrize(
    ("lines", "change_source", "logged"),
    [
        pytest.param(["change_source: hud"], "github", "change_source 'hud' is not one of", id="bad-source"),
        pytest.param(
            ["change_source: clickhouse", "full_tick_minutes: 1441"],
            "clickhouse",
            "full_tick_minutes 1441 is not an integer from 60 to 1440; ignored, it stays 240",
            id="bad-minutes",
        ),
        pytest.param(
            ["change_source: clickhouse", "full_tick_minutes: !!bool true"],
            "clickhouse",
            "full_tick_minutes True is not an integer",
            id="bool-minutes",
        ),
        pytest.param(
            ["change_source: github", "full_tick_minutes: 120"],
            "github",
            "full_tick_minutes is only for change_source: clickhouse; ignored, it stays 240",
            id="github-minutes",
        ),
        pytest.param(
            ["full_tick_minutes: 120"], "github", "full_tick_minutes is only for change_source", id="default-minutes"
        ),
        pytest.param(
            ["change_source: hud", "full_tick_minutes: 120"],
            "github",
            "full_tick_minutes is only for change_source",
            id="bad-source-minutes",
        ),
    ],
)
def test_a_bad_change_key_on_the_primary_falls_back_to_the_builtin_with_an_error(caplog, lines, change_source, logged):
    text = "repos:\n" + _PYTORCH.format(mode="active") + "".join(f"    {line}\n" for line in lines)
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        config = repo_config.parse(text)

    assert config.served == (dataclasses.replace(BUILTIN_PYTORCH, change_source=change_source),)
    assert config.problems == ()
    assert f"repos config: {TARGET_REPO} {logged}" in caplog.text


def test_the_primarys_mode_comes_from_the_file_and_its_other_fields_are_pinned(caplog):
    text = "repos:\n" + _entry(TARGET_REPO, status_comment="greenlight", eligibility="write_permission", extra="1")
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        config = repo_config.parse(text)

    assert config.served == (dataclasses.replace(BUILTIN_PYTORCH, mode="shadow"),)
    assert config.problems == ()
    assert "status_comment 'greenlight' ignored; it is pinned to 'drci'" in caplog.text
    assert "safety 'gate' ignored" in caplog.text
    assert "eligibility 'write_permission' ignored" in caplog.text
    assert "unknown key(s) ['extra'] ignored" in caplog.text


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        pytest.param("repos: []\n", "is missing", id="missing"),
        pytest.param("repos:\n" + _PYTORCH.format(mode="active") * 2, "is duplicated", id="duplicated"),
        pytest.param(
            "repos:\n" + _PYTORCH.format(mode="active") + _entry("pytorch/PyTorch"), "is duplicated", id="case-dup"
        ),
        pytest.param("repos:\n" + _PYTORCH.format(mode="paused"), "mode 'paused' is not one of", id="bad-mode"),
        pytest.param("repos:\n" + _entry(TARGET_REPO, mode="<absent>"), "mode None is not one of", id="no-mode"),
    ],
)
def test_a_broken_primary_is_never_refused_but_safety_only_under_the_builtin(text, reason):
    config = repo_config.parse(text)

    assert config.served == ()
    [(entry, why)] = config.safety_only
    assert entry == BUILTIN_PYTORCH
    assert reason in why
    assert all(repo != TARGET_REPO for repo, _ in config.refused)
    assert config.lookup(TARGET_REPO) == (BUILTIN_PYTORCH, False)


def test_lookup_is_by_exact_name_and_misses_refused_and_absent_repos():
    config = _parse(_entry("pytorch/vision"), _entry("pytorch/audio", mode="bogus"))

    assert config.lookup("pytorch/vision") is not None
    assert config.lookup("pytorch/Vision") is None
    assert config.lookup("pytorch/audio") is None
    assert config.lookup("pytorch/text") is None


def test_problems_lists_the_file_error_the_safety_only_reasons_and_the_refusals():
    config = RepoConfig(
        served=(),
        safety_only=((BUILTIN_PYTORCH, "its entry is missing"),),
        refused=(("pytorch/x", "bad"),),
        error="gone",
    )

    assert config.problems == (
        "repos config unreadable: gone",
        f"{TARGET_REPO} is safety-only: its entry is missing",
        "pytorch/x is refused: bad",
    )


def test_load_local_reads_the_given_path(tmp_path: Path) -> None:
    path = tmp_path / "repos.yaml"
    path.write_text("repos:\n" + _PYTORCH.format(mode="off"))

    assert repo_config.load_local(path).served == (dataclasses.replace(BUILTIN_PYTORCH, mode="off"),)


@pytest.mark.parametrize("content", [None, "repos: 5\n"], ids=["missing", "unreadable"])
def test_load_local_falls_back_to_the_builtin_with_the_error_set(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, content: str | None
) -> None:
    path = tmp_path / "repos.yaml"
    if content is not None:
        path.write_text(content)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        config = repo_config.load_local(path)

    assert config.served == BUILTIN_CONFIG.served
    assert config.error is not None
    assert str(path) in config.error
    assert "serving only the built-in" in caplog.text


class _Content:
    def __init__(self, text: str) -> None:
        self.decoded_content = text.encode()


class _ContentsRepo:
    def __init__(self, contents: object) -> None:
        self.contents = contents
        self.paths: list[str] = []

    def get_contents(self, path: str) -> object:
        self.paths.append(path)
        return self.contents


class _ContentsClient:
    def __init__(self, contents: object) -> None:
        self.repo = _ContentsRepo(contents)
        self.names: list[str] = []

    def get_repo(self, full_name_or_id: str) -> _ContentsRepo:
        self.names.append(full_name_or_id)
        return self.repo


def test_fetch_config_reads_the_file_from_the_dispatch_repo():
    client = _ContentsClient(_Content("repos:\n" + _PYTORCH.format(mode="shadow")))

    config = repo_config.fetch_config(client)  # type: ignore[arg-type]

    assert config.served == (dataclasses.replace(BUILTIN_PYTORCH, mode="shadow"),)
    assert client.names == [DISPATCH_REPO]
    assert client.repo.paths == [REPOS_CONFIG_PATH]


def test_fetch_config_refuses_a_directory_and_an_unreadable_file():
    with pytest.raises(ConfigUnreadable, match="resolved to a directory"):
        repo_config.fetch_config(_ContentsClient([_Content("x")]))  # type: ignore[arg-type]
    with pytest.raises(ConfigUnreadable):
        repo_config.fetch_config(_ContentsClient(_Content("repos: 1\n")))  # type: ignore[arg-type]


def test_the_value_tuples_are_the_literals():
    assert repo_config.STATUS_COMMENTS == ("drci", "greenlight")
    assert repo_config.SAFETIES == ("pytorchbot", "gate")
    assert repo_config.ELIGIBILITIES == ("merge_rules", "write_permission")
    assert repo_config.MODES == ("shadow", "active", "off")
    assert repo_config.CHANGE_SOURCES == ("github", "clickhouse")


def test_is_primary_is_an_exact_match():
    assert repo_config.is_primary(TARGET_REPO)
    assert not repo_config.is_primary("PyTorch/PyTorch")


@pytest.mark.skipif(
    os.environ.get("GREENLIGHT_LIVE_CONFIG_CHECK") != "1",
    reason="live GitHub check; runs only with GREENLIGHT_LIVE_CONFIG_CHECK=1 (the greenlight-tests workflow)",
)
def test_every_real_entry_passes_the_live_checks():
    config = repo_config.load_local()
    entries = [*config.served, *(entry for entry, _ in config.safety_only)]
    problems: dict[str, str] = {}
    for entry in entries:
        data = json.loads(_live_get(f"/repos/{entry.repo}", "application/vnd.github+json"))
        problem = identity_problem(entry, RepoIdentity(data["full_name"], data["private"], data["default_branch"]))
        if problem is None and entry.eligibility == "merge_rules":
            problem = _merge_rules_problem(entry.repo)
        if problem is not None:
            problems[entry.repo] = problem

    assert entries
    assert problems == {}


def _live_get(path: str, accept: str) -> bytes:
    request = urllib.request.Request(f"https://api.github.com{path}", headers={"Accept": accept})
    if token := os.environ.get("GITHUB_TOKEN"):
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
        body: bytes = response.read()
    return body


def _merge_rules_problem(repo: str) -> str | None:
    """Why ``repo``'s ``MERGE_RULES_PATH`` cannot serve its ``merge_rules`` eligibility, or None."""
    try:
        raw = _live_get(f"/repos/{repo}/contents/{MERGE_RULES_PATH}", "application/vnd.github.raw+json")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return f"it has no {MERGE_RULES_PATH}"
        raise
    return _merge_rules_text_problem(raw, f"{repo}/{MERGE_RULES_PATH}")


def _merge_rules_text_problem(raw: bytes, source: str) -> str | None:
    """Why the merge_rules.yaml ``raw`` cannot serve eligibility: the scan's own rejection, or no approver."""
    try:
        entries = list(merge_authz.merge_rule_entries(raw, source))
    except ValueError as exc:
        return str(exc)
    if not any(approved_by for _rule, approved_by in entries):
        return f"{source} names no approved_by entry"
    return None


@pytest.mark.parametrize(
    ("text", "problem"),
    [
        ("- 1\n", "merge rule must be a mapping, got int"),
        ("[]\n", "names no approved_by entry"),
        ("- approved_by: alice\n", "approved_by must be a list, got str"),
        ("- name: CI\n  approved_by: []\n", "names no approved_by entry"),
        ("- name: CI\n  approved_by: [alice]\n", None),
    ],
)
def test_the_live_merge_rules_check_rejects_what_the_scan_rejects(text: str, problem: str | None) -> None:
    found = _merge_rules_text_problem(text.encode(), "pytorch/vision/.github/merge_rules.yaml")

    if problem is None:
        assert found is None
        assert merge_authz.resolve_merge_rules(_MergeRulesClient(text), "pytorch/vision").authorized == {"alice"}
    else:
        assert found is not None
        assert found.startswith("pytorch/vision/.github/merge_rules.yaml")
        assert problem in found
        with pytest.raises(ValueError, match=r"pytorch/vision/\.github/merge_rules\.yaml"):
            merge_authz.resolve_merge_rules(_MergeRulesClient(text), "pytorch/vision")


class _MergeRulesClient:
    """A client whose every repo holds the merge_rules.yaml ``text`` and which has no org."""

    def __init__(self, text: str) -> None:
        self.decoded_content = text.encode()

    def get_repo(self, _name: str) -> _MergeRulesClient:
        return self

    def get_contents(self, _path: str) -> _MergeRulesClient:
        return self

    def get_organization(self, login: str) -> NoReturn:
        raise AssertionError(f"no org is read: {login}")


def test_the_live_check_is_documented_in_the_workflow():
    from pathlib import Path

    workflow = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "greenlight-tests.yml"
    text = textwrap.dedent(workflow.read_text())
    assert 'GREENLIGHT_LIVE_CONFIG_CHECK: "1"' in text
    assert "GITHUB_TOKEN: ${{ github.token }}" in text
