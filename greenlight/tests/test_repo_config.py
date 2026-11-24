from __future__ import annotations

import base64
import dataclasses
import http.server
import json
import logging
import threading
import time
from typing import TYPE_CHECKING, NoReturn

import pytest
from github import GithubException, RateLimitExceededException, UnknownObjectException

from greenlight import github_client, repo_config
from greenlight.constants import CONFIG_MAX_BYTES, REPO_CONFIG_PATH, TARGET_REPO
from greenlight.guards import IterationTimeout
from greenlight.repo_config import BUILTIN_PYTORCH, RepoEntry, Settings

# Bound at collection, before conftest swaps the module attribute for a fake.
from greenlight.repo_config import fetch_settings as _real_fetch_settings

if TYPE_CHECKING:
    from pathlib import Path

_VISION = "pytorch/vision"
_PYTORCH_FILE = "status_comment: drci\nsafety: pytorchbot\neligibility: merge_rules\nmode: {mode}\n"


def _file(**fields: str) -> str:
    values = {"status_comment": "greenlight", "safety": "gate", "eligibility": "merge_rules", "mode": "shadow"}
    values.update(fields)
    return "".join(f"{key}: {value}\n" for key, value in values.items() if value != "<absent>")


def test_a_valid_file_serves_its_repo():
    settings = repo_config.parse_settings(_VISION, _file())

    assert settings == Settings(
        _VISION, "valid", RepoEntry(_VISION, "greenlight", "gate", "merge_rules", "shadow"), served=True
    )


@pytest.mark.parametrize("minimum_role", ["write", "maintain"])
def test_a_write_permission_file_with_a_minimum_role_serves_its_repo_at_that_role(minimum_role):
    settings = repo_config.parse_settings(_VISION, _file(eligibility="write_permission", minimum_role=minimum_role))

    entry = RepoEntry(_VISION, "greenlight", "gate", "write_permission", "shadow", minimum_role)
    assert settings == Settings(_VISION, "valid", entry, served=True)


def test_the_minimum_role_defaults_to_write():
    settings = repo_config.parse_settings(_VISION, _file(eligibility="write_permission"))

    assert settings.entry is not None
    assert settings.entry.minimum_role == "write"
    assert BUILTIN_PYTORCH.minimum_role == "write"


def test_bare_off_is_the_mode_off_not_a_boolean():
    settings = repo_config.parse_settings(_VISION, _file(mode="off"))

    assert settings.entry is not None
    assert settings.entry.mode == "off"


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        pytest.param("mode: [", "not valid YAML", id="bad-yaml"),
        pytest.param(b"\xff\xfe\x00", "not valid YAML", id="not-text"),
        pytest.param("- a\n", "top level must be a mapping, got list", id="top-level-list"),
        pytest.param("", "top level must be a mapping, got NoneType", id="empty"),
        pytest.param("[" * 4000 + "]" * 4000, "RecursionError", id="nested-brackets"),
        pytest.param("#" * (CONFIG_MAX_BYTES + 1), f"over the {CONFIG_MAX_BYTES}-byte limit", id="too-big"),
        pytest.param(_file(mode="<absent>"), "mode is missing", id="missing-field"),
        pytest.param(_file(safety="none"), "safety 'none' is not one of", id="bad-value"),
        pytest.param(_file(safety="pytorchbot"), "safety: pytorchbot is only for", id="pytorchbot"),
        pytest.param(_file(status_comment="drci"), "status_comment: drci is only for", id="drci"),
        pytest.param(_file(mode="active"), "safety: gate cannot be active", id="active-gate"),
        pytest.param(_file(mode="active", extra="1"), "safety: gate cannot be active", id="unknown-key-no-rescue"),
        pytest.param(
            _file(minimum_role="maintain"),
            "minimum_role is only for eligibility: write_permission",
            id="maintain-with-merge-rules",
        ),
        pytest.param(
            _file(minimum_role="write"),
            "minimum_role is only for eligibility: write_permission",
            id="write-with-merge-rules",
        ),
        pytest.param(
            _file(eligibility="write_permission", minimum_role="admin"),
            "minimum_role 'admin' is not one of ['write', 'maintain']",
            id="bad-minimum-role",
        ),
        pytest.param(
            _file(eligibility="write_permission", minimum_role="5"),
            "minimum_role must be a string, got int",
            id="minimum-role-not-a-string",
        ),
    ],
)
def test_an_invalid_file_refuses_a_non_primary_repo(text, reason, caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        settings = repo_config.parse_settings(_VISION, text)

    assert settings.kind == "invalid"
    assert settings.entry is None
    assert settings.served is False
    assert settings.problem is not None
    assert settings.problem.startswith("invalid config, refused: ")
    assert reason in settings.problem
    assert settings.problem in caplog.text


def test_a_parse_exception_is_logged_with_its_traceback(caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        repo_config.parse_settings(_VISION, "[" * 4000 + "]" * 4000)

    assert any(record.exc_info is not None for record in caplog.records)


def test_the_size_cap_counts_encoded_bytes_and_allows_exactly_the_limit():
    padding = CONFIG_MAX_BYTES - len(_file().encode())

    assert repo_config.parse_settings(_VISION, _file() + "#" * padding).served is True
    assert repo_config.parse_settings(_VISION, _file() + "#" * (padding - 1) + "é").kind == "invalid"


def test_a_non_primary_file_with_an_unknown_key_is_safety_only(caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        settings = repo_config.parse_settings(_VISION, _file(gate_workflow="x", repo="pytorch/vision"))

    assert settings.kind == "valid"
    assert settings.entry == RepoEntry(_VISION, "greenlight", "gate", "merge_rules", "shadow")
    assert settings.served is False
    assert settings.problem == "safety-only: unknown key(s) ['gate_workflow', 'repo']"
    assert settings.problem in caplog.text


def test_the_primarys_mode_comes_from_the_file_and_its_other_fields_are_pinned(caplog):
    text = _file(status_comment="greenlight", eligibility="write_permission", extra="1")
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        settings = repo_config.parse_settings(TARGET_REPO, text)

    assert settings == Settings(TARGET_REPO, "valid", dataclasses.replace(BUILTIN_PYTORCH, mode="shadow"), served=True)
    assert "status_comment 'greenlight' ignored; it is pinned to 'drci'" in caplog.text
    assert "safety 'gate' ignored" in caplog.text
    assert "eligibility 'write_permission' ignored" in caplog.text
    assert "unknown key(s) ['extra'] ignored" in caplog.text


@pytest.mark.parametrize("minimum_role", ["maintain", "admin"])
def test_the_primary_ignores_a_minimum_role(caplog, minimum_role):
    text = _PYTORCH_FILE.format(mode="active") + f"minimum_role: {minimum_role}\n"
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        settings = repo_config.parse_settings(TARGET_REPO, text)

    assert settings == Settings(TARGET_REPO, "valid", BUILTIN_PYTORCH, served=True)
    assert f"minimum_role {minimum_role!r} ignored; it is pinned to 'write'" in caplog.text
    assert "unknown key" not in caplog.text


def test_the_primary_stays_served_with_only_mode_set(caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        settings = repo_config.parse_settings(TARGET_REPO, "mode: off\n")

    assert settings == Settings(TARGET_REPO, "valid", dataclasses.replace(BUILTIN_PYTORCH, mode="off"), served=True)
    assert "status_comment is missing; it is pinned to 'drci'" in caplog.text


def test_the_primarys_builtin_file_logs_nothing(caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        settings = repo_config.parse_settings(TARGET_REPO, _PYTORCH_FILE.format(mode="active"))

    assert settings == Settings(TARGET_REPO, "valid", BUILTIN_PYTORCH, served=True)
    assert caplog.text == ""


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        pytest.param("mode: [", "not valid YAML", id="bad-yaml"),
        pytest.param("- a\n", "top level must be a mapping", id="not-a-mapping"),
        pytest.param("#" * (CONFIG_MAX_BYTES + 1), "byte limit", id="too-big"),
        pytest.param(_PYTORCH_FILE.format(mode="paused"), "mode 'paused' is not one of", id="bad-mode"),
        pytest.param("safety: pytorchbot\n", "mode is missing", id="no-mode"),
    ],
)
def test_an_invalid_primary_file_is_safety_only_under_the_builtin(text, reason):
    settings = repo_config.parse_settings(TARGET_REPO, text)

    assert settings.kind == "invalid"
    assert settings.entry == BUILTIN_PYTORCH
    assert settings.served is False
    assert settings.problem is not None
    assert settings.problem.startswith("invalid config, safety-only under the built-in entry: ")
    assert reason in settings.problem


def _content(text: str, size: int | None = None) -> dict[str, object]:
    """The contents API's answer for a file holding ``text`` (``size`` as the API reports it)."""
    data = text.encode()
    return {"type": "file", "size": len(data) if size is None else size, "content": base64.b64encode(data).decode()}


class _Requester:
    def __init__(self, contents: object) -> None:
        self.contents = contents
        self.calls: list[tuple[str, str]] = []

    def requestJsonAndCheck(self, verb: str, url: str) -> tuple[dict[str, str], object]:
        self.calls.append((verb, url))
        if isinstance(self.contents, BaseException):
            raise self.contents
        return {}, self.contents


class _ContentsClient:
    def __init__(self, contents: object) -> None:
        self.requester = _Requester(contents)
        self.closed = 0

    def close(self) -> None:
        self.closed += 1


def _read(repo: str, contents: object) -> Settings:
    return repo_config.read_settings(_ContentsClient(contents), repo)  # type: ignore[arg-type]


def test_read_settings_reads_the_repos_own_file_from_its_default_branch():
    client = _ContentsClient(_content(_file()))

    settings = repo_config.read_settings(client, _VISION)  # type: ignore[arg-type]

    assert settings.served is True
    assert client.requester.calls == [("GET", f"/repos/{_VISION}/contents/{REPO_CONFIG_PATH}")]


def test_an_absent_file_serves_the_primary_builtin_and_leaves_other_repos_unconfigured():
    missing = UnknownObjectException(404)

    assert _read(TARGET_REPO, missing) == Settings(TARGET_REPO, "absent", BUILTIN_PYTORCH, served=True)
    assert _read(_VISION, missing) == Settings(_VISION, "absent", None, served=False)


@pytest.mark.parametrize(
    ("contents", "reason"),
    [
        pytest.param([_content("x")], "it is a directory, not a file", id="directory"),
        pytest.param(_content(_file(), size=CONFIG_MAX_BYTES + 1), "byte limit", id="api-size-over-cap"),
        pytest.param(_content("#" * (CONFIG_MAX_BYTES + 1), size=0), "byte limit", id="decoded-over-cap"),
        pytest.param({"type": "file", "size": 2, "content": "//79"}, "not UTF-8 text", id="not-utf8"),
        pytest.param({"type": "symlink", "size": 2}, "it is a symlink, not a file", id="symlink"),
    ],
)
def test_a_directory_or_an_oversized_file_is_invalid(contents, reason):
    vision = _read(_VISION, contents)
    primary = _read(TARGET_REPO, contents)

    assert (vision.kind, vision.entry) == ("invalid", None)
    assert (primary.kind, primary.entry, primary.served) == ("invalid", BUILTIN_PYTORCH, False)
    assert vision.problem is not None
    assert reason in vision.problem


@pytest.mark.parametrize(
    "error",
    [GithubException(502), GithubException(403, {"message": "forbidden"}), ConnectionError("reset")],
    ids=["5xx", "403", "network"],
)
def test_a_cold_unreadable_file_serves_the_primary_builtin_and_gives_other_repos_no_work(error, caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        primary = _read(TARGET_REPO, error)
        vision = _read(_VISION, error)

    assert (primary.kind, primary.entry, primary.served) == ("unreadable", BUILTIN_PYTORCH, True)
    assert (vision.kind, vision.entry, vision.served) == ("unreadable", None, False)
    assert primary.problem is not None
    assert primary.problem.startswith("config unreadable, serving the built-in entry: ")
    assert vision.problem is not None
    assert vision.problem.startswith("config unreadable, no work: ")
    assert any(record.exc_info is not None for record in caplog.records)


@pytest.mark.parametrize("contents", [{"type": "file"}, "not a mapping"], ids=["no-size", "not-a-mapping"])
def test_an_answer_that_is_no_contents_response_is_unreadable(contents):
    settings = _read(_VISION, contents)

    assert (settings.kind, settings.entry) == ("unreadable", None)
    assert settings.problem is not None
    assert "unexpected shape" in settings.problem


@pytest.mark.parametrize(
    "error",
    [RateLimitExceededException(403), GithubException(429), IterationTimeout("late")],
    ids=["rate-limit-403", "rate-limit-429", "timeout"],
)
def test_a_rate_limit_or_timeout_is_re_raised(error):
    with pytest.raises(type(error)):
        _read(TARGET_REPO, error)


def _refuse(_token: str) -> NoReturn:
    raise AssertionError("the fail-fast client was built")


def test_fetch_settings_builds_and_closes_its_own_patient_client(monkeypatch):
    client = _ContentsClient(_content(_file()))
    tokens: list[str] = []

    def build(token: str) -> _ContentsClient:
        tokens.append(token)
        return client

    monkeypatch.setattr(github_client, "build_authz_client", build)
    monkeypatch.setattr(github_client, "build_client", _refuse)

    assert _real_fetch_settings("tok", _VISION).served is True
    assert tokens == ["tok"]
    assert client.closed == 1


def _answer(monkeypatch: pytest.MonkeyPatch, outcome: Settings | BaseException) -> list[tuple[str, str]]:
    calls: list[tuple[str, str]] = []

    def fetch(token: str, repo: str) -> Settings:
        calls.append((token, repo))
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(repo_config, "fetch_settings", fetch)
    return calls


_VISION_ENTRY = RepoEntry(_VISION, "greenlight", "gate", "merge_rules", "shadow")


@pytest.mark.parametrize(
    ("settings", "expected"),
    [
        pytest.param(Settings(TARGET_REPO, "absent", BUILTIN_PYTORCH, True), (BUILTIN_PYTORCH, True), id="absent"),
        pytest.param(
            Settings(TARGET_REPO, "invalid", BUILTIN_PYTORCH, False, "x"), (BUILTIN_PYTORCH, False), id="invalid"
        ),
        pytest.param(Settings(_VISION, "valid", _VISION_ENTRY, False, "x"), (_VISION_ENTRY, False), id="safety-only"),
    ],
)
def test_record_entry_returns_a_usable_entry(monkeypatch, settings, expected):
    calls = _answer(monkeypatch, settings)

    assert repo_config.record_entry("tok", settings.repo) == expected
    assert calls == [("tok", settings.repo)]


@pytest.mark.parametrize(
    ("settings", "why"),
    [
        pytest.param(Settings(_VISION, "absent", None, False), f"no {REPO_CONFIG_PATH}", id="absent"),
        pytest.param(Settings(_VISION, "invalid", None, False, "refused: bad"), "refused: bad", id="invalid"),
        pytest.param(
            Settings(TARGET_REPO, "unreadable", BUILTIN_PYTORCH, False, "unreadable: 502"),
            "unreadable: 502",
            id="unreadable-primary",
        ),
    ],
)
def test_record_entry_raises_with_no_usable_entry(monkeypatch, settings, why):
    _answer(monkeypatch, settings)

    with pytest.raises(ValueError, match="has no valid GreenLight settings") as excinfo:
        repo_config.record_entry("tok", settings.repo)
    assert why in str(excinfo.value)


def test_marker_entry_uses_what_the_file_says(monkeypatch):
    _answer(monkeypatch, Settings(_VISION, "valid", _VISION_ENTRY, True))

    assert repo_config.marker_entry("tok", _VISION) == (_VISION_ENTRY, True)


@pytest.mark.parametrize(
    "outcome",
    [
        pytest.param(RateLimitExceededException(403), id="rate-limit"),
        pytest.param(Settings(_VISION, "unreadable", None, False, "x"), id="unreadable"),
        pytest.param(Settings(_VISION, "absent", None, False), id="absent"),
        pytest.param(Settings(_VISION, "invalid", None, False, "x"), id="invalid"),
    ],
)
def test_marker_entry_never_fails_and_falls_back_to_shadow_off_the_primary(monkeypatch, outcome, caplog):
    _answer(monkeypatch, outcome)

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        entry, served = repo_config.marker_entry("tok", _VISION)

    assert (entry.repo, entry.mode, served) == (_VISION, "shadow", False)


@pytest.mark.parametrize("token", [None, ""])
def test_marker_entry_with_no_token_falls_back_without_a_read(monkeypatch, token, caplog):
    calls = _answer(monkeypatch, Settings(_VISION, "valid", _VISION_ENTRY, True))

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        assert repo_config.marker_entry(token, TARGET_REPO) == (BUILTIN_PYTORCH, True)
        assert repo_config.marker_entry(token, _VISION)[1] is False

    assert calls == []
    assert "falling back" in caplog.text


@pytest.mark.parametrize(
    "outcome",
    [
        pytest.param(GithubException(403, {"message": "forbidden"}), id="read-raises"),
        pytest.param(Settings(TARGET_REPO, "unreadable", BUILTIN_PYTORCH, False, "x"), id="unreadable"),
    ],
)
def test_marker_entry_on_a_failed_primary_read_serves_the_builtin(monkeypatch, outcome):
    _answer(monkeypatch, outcome)

    assert repo_config.marker_entry("tok", TARGET_REPO) == (BUILTIN_PYTORCH, True)


def test_marker_entry_on_an_invalid_primary_file_is_safety_only(monkeypatch):
    _answer(monkeypatch, Settings(TARGET_REPO, "invalid", BUILTIN_PYTORCH, False, "x"))

    assert repo_config.marker_entry("tok", TARGET_REPO) == (BUILTIN_PYTORCH, False)


def test_check_file_is_clean_for_a_valid_file(tmp_path: Path) -> None:
    path = tmp_path / "config.yml"
    path.write_text(_file())

    assert repo_config.check_file(path, _VISION) == []


def test_check_file_lists_every_problem_and_the_unknown_keys(tmp_path: Path) -> None:
    path = tmp_path / "config.yml"
    path.write_text(_file(safety="none", mode="<absent>", extra="1"))

    assert repo_config.check_file(path, _VISION) == [
        "safety 'none' is not one of ['pytorchbot', 'gate']",
        "mode is missing",
        "unknown key(s) ['extra']",
    ]


def test_check_file_lists_the_cross_field_problems(tmp_path: Path) -> None:
    path = tmp_path / "config.yml"
    path.write_text(_file(status_comment="drci", safety="pytorchbot"))

    problems = repo_config.check_file(path, _VISION)

    assert len(problems) == 2
    assert problems[0].startswith("safety: pytorchbot is only for")
    assert problems[1].startswith("status_comment: drci is only for")


def test_check_file_reports_a_minimum_role_off_write_permission_or_out_of_its_values(tmp_path: Path) -> None:
    path = tmp_path / "config.yml"
    path.write_text(_file(minimum_role="maintain"))
    assert repo_config.check_file(path, _VISION) == ["minimum_role is only for eligibility: write_permission"]
    path.write_text(_file(eligibility="write_permission", minimum_role="triage"))
    assert repo_config.check_file(path, _VISION) == ["minimum_role 'triage' is not one of ['write', 'maintain']"]
    path.write_text(_file(eligibility="write_permission", minimum_role="maintain"))
    assert repo_config.check_file(path, _VISION) == []


def test_check_file_reports_what_the_primary_ignores(tmp_path: Path) -> None:
    path = tmp_path / "config.yml"
    path.write_text("status_comment: greenlight\nmode: active\nextra: 1\n")

    assert repo_config.check_file(path, TARGET_REPO) == [
        "status_comment 'greenlight' ignored; it is pinned to 'drci'",
        "safety is missing; it is pinned to 'pytorchbot'",
        "eligibility is missing; it is pinned to 'merge_rules'",
        "unknown key(s) ['extra'] ignored",
    ]
    path.write_text(_PYTORCH_FILE.format(mode="active"))
    assert repo_config.check_file(path, TARGET_REPO) == []
    path.write_text(_PYTORCH_FILE.format(mode="active") + "minimum_role: maintain\n")
    assert repo_config.check_file(path, TARGET_REPO) == ["minimum_role 'maintain' ignored; it is pinned to 'write'"]
    path.write_text(_PYTORCH_FILE.format(mode="paused"))
    assert repo_config.check_file(path, TARGET_REPO) == ["mode 'paused' is not one of ['shadow', 'active', 'off']"]


def test_check_file_reports_an_unreadable_or_unparsable_file(tmp_path: Path) -> None:
    missing = repo_config.check_file(tmp_path / "missing.yml", _VISION)
    directory = repo_config.check_file(tmp_path, _VISION)
    (tmp_path / "bad.yml").write_text("- a\n")

    assert len(missing) == 1
    assert missing[0].startswith("cannot read")
    assert len(directory) == 1
    assert directory[0].startswith("cannot read")
    assert repo_config.check_file(tmp_path / "bad.yml", _VISION) == ["the top level must be a mapping, got list"]


_ALIAS_BOMB = (
    "".join(
        f"{name}: &{name} [{', '.join([f'*{prev}' if prev else '"x"'] * 9)}]\n"
        for prev, name in zip(["", "a", "b", "c", "d", "e"], ["a", "b", "c", "d", "e", "f"], strict=True)
    )
    + "mode: *f\n"
)


@pytest.mark.parametrize("repo", [TARGET_REPO, _VISION])
def test_an_alias_bomb_is_invalid_at_once_with_a_short_problem(repo: str, tmp_path: Path) -> None:
    path = tmp_path / "config.yml"
    path.write_text(_ALIAS_BOMB)

    started = time.monotonic()
    settings = repo_config.parse_settings(repo, _ALIAS_BOMB)
    problems = repo_config.check_file(path, repo)

    assert time.monotonic() - started < 1
    assert len(_ALIAS_BOMB) < 400
    assert settings.kind == "invalid"
    assert settings.problem is not None
    assert settings.problem.endswith(": anchors and aliases are not allowed")
    assert problems == ["anchors and aliases are not allowed"]


@pytest.mark.parametrize(
    "text",
    [
        pytest.param("!!merge <<: {mode: off, mode: active}\n", id="merge-tag"),
        pytest.param("%TAG !y! tag:yaml.org,2002:\n---\n!y!merge <<: {mode: active}\nmode: off\n", id="tag-handle"),
        pytest.param("!<tag:yaml.org,2002:merge> <<: {mode: active}\nmode: off\n", id="verbatim"),
        pytest.param("mode: !!str off\n", id="str-tag"),
        pytest.param("!!map {mode: off}\n", id="mapping-tag"),
        pytest.param("mode: ! off\n", id="non-specific"),
    ],
)
@pytest.mark.parametrize("repo", [TARGET_REPO, _VISION])
def test_any_explicit_tag_is_refused(repo: str, text: str, tmp_path: Path) -> None:
    path = tmp_path / "config.yml"
    path.write_text(text)

    settings = repo_config.parse_settings(repo, text)
    [problem] = repo_config.check_file(path, repo)

    assert settings.kind == "invalid"
    assert problem.startswith("explicit YAML tags are not allowed (found '")
    assert settings.problem is not None
    assert settings.problem.endswith(problem)
    assert len(problem) < 120


@pytest.mark.parametrize("text", ["base: &x shadow\nmode: shadow\n", "mode: *x\n"], ids=["anchor", "alias"])
def test_any_anchor_or_alias_is_refused(text):
    settings = repo_config.parse_settings(_VISION, text)

    assert settings.problem == "invalid config, refused: anchors and aliases are not allowed"


@pytest.mark.parametrize("repo", [TARGET_REPO, _VISION])
def test_a_duplicate_key_is_invalid(repo: str, tmp_path: Path) -> None:
    text = _file(mode="off") + "'mode': active\n"
    path = tmp_path / "config.yml"
    path.write_text(text)

    settings = repo_config.parse_settings(repo, text)

    assert settings.kind == "invalid"
    assert settings.problem is not None
    assert settings.problem.endswith(": duplicate key 'mode'")
    assert repo_config.check_file(path, repo) == ["duplicate key 'mode'"]


def test_a_merge_key_is_a_plain_unknown_key_and_merges_nothing():
    settings = repo_config.parse_settings(_VISION, "<<: {mode: active}\n" + _file())

    assert settings.entry == RepoEntry(_VISION, "greenlight", "gate", "merge_rules", "shadow")
    assert settings.problem == "safety-only: unknown key(s) ['<<']"


def test_raw_values_and_keys_are_shown_bounded(tmp_path: Path) -> None:
    long = "x" * 3000
    text = f"status_comment: {long}\nsafety: [1, 2]\neligibility: {{a: 1}}\nmode: 5\n{long[:900]}: 1\n"
    path = tmp_path / "config.yml"
    path.write_text(text)

    vision = repo_config.check_file(path, _VISION)
    primary = repo_config.check_file(path, TARGET_REPO)

    assert vision[1:] == [
        "safety must be a string, got list",
        "eligibility must be a string, got dict",
        "mode must be a string, got int",
        f"unknown key(s) ['{'x' * 57}...']",
    ]
    assert vision[0].startswith("status_comment 'xxx")
    assert "..." in vision[0]
    assert all(len(problem) < 200 for problem in vision + primary)
    assert "safety a list ignored; it is pinned to 'pytorchbot'" in primary
    assert "mode must be a string, got int" in primary


def test_the_value_tuples_are_the_literals():
    assert repo_config.STATUS_COMMENTS == ("drci", "greenlight")
    assert repo_config.SAFETIES == ("pytorchbot", "gate")
    assert repo_config.ELIGIBILITIES == ("merge_rules", "write_permission")
    assert repo_config.MODES == ("shadow", "active", "off")
    assert repo_config.MINIMUM_ROLES == ("write", "maintain")


def test_is_primary_is_an_exact_match():
    assert repo_config.is_primary(TARGET_REPO)
    assert not repo_config.is_primary("PyTorch/PyTorch")


class _RateLimitedThenMissing(http.server.BaseHTTPRequestHandler):
    """``GET /repos/{repo}`` answers the repo; its contents answer a 429 once, then a 404."""

    paths: list[str]

    def do_GET(self) -> None:
        self.paths.append(self.path)
        host = f"http://{self.headers['Host']}"
        if self.path == f"/repos/{TARGET_REPO}":
            body: dict[str, object] = {"full_name": TARGET_REPO, "url": f"{host}/repos/{TARGET_REPO}"}
            self._reply(200, body)
        elif sum(path.endswith(REPO_CONFIG_PATH) for path in self.paths) == 1:
            self._reply(429, {"message": "secondary rate limit"}, {"Retry-After": "0"})
        else:
            self._reply(404, {"message": "Not Found"})

    def _reply(self, status: int, body: dict[str, object], headers: dict[str, str] | None = None) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None: ...


def test_record_entry_rides_out_a_429_on_the_patient_client(monkeypatch):
    import github

    paths: list[str] = []
    handler = type("Handler", (_RateLimitedThenMissing,), {"paths": paths})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    real_github = github.Github
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    monkeypatch.setattr("github.Github", lambda **kwargs: real_github(base_url=base_url, **kwargs))
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setattr(repo_config, "fetch_settings", _real_fetch_settings)
    try:
        assert repo_config.record_entry("tok", TARGET_REPO) == (BUILTIN_PYTORCH, True)
    finally:
        server.shutdown()
        server.server_close()

    assert [path for path in paths if path.endswith(REPO_CONFIG_PATH)] == [
        f"/repos/{TARGET_REPO}/contents/{REPO_CONFIG_PATH}"
    ] * 2
