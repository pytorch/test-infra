from __future__ import annotations

import base64
import dataclasses
import json
import logging
from typing import Any

import pytest
from github import GithubException, RateLimitExceededException

from greenlight import config_cache
from greenlight.config_cache import PRIMARY_ABSENT, REMOVED, UNREACHABLE, decide, revalidate
from greenlight.constants import CONFIG_ABSENT_TTL, CONFIG_MAX_BYTES, REPO_CONFIG_PATH, TARGET_REPO
from greenlight.guards import IterationTimeout
from greenlight.repo_config import BUILTIN_PYTORCH, RepoEntry
from greenlight.state_store import ConfigRecord

_REPO = "pytorch/vision"
_URL = f"/repos/{_REPO}/contents/{REPO_CONFIG_PATH}"
_SHADOW = "status_comment: greenlight\nsafety: gate\neligibility: merge_rules\nmode: shadow\n"
_ENTRY = RepoEntry(_REPO, "greenlight", "gate", "merge_rules", "shadow")
_PLANNER_FIELDS: dict[str, Any] = {"valid_text": _SHADOW, "served": True, "work_since": 3.0, "reported": "p"}


def _file(text: str, *, size: int | None = None, kind: str = "file") -> str:
    content = base64.b64encode(text.encode()).decode()
    return json.dumps({"type": kind, "size": len(text) if size is None else size, "content": content})


class _Requester:
    def __init__(self, answer: Any) -> None:
        self.answer = answer
        self.calls: list[tuple[str, str, dict[str, str] | None]] = []

    def requestJson(
        self, verb: str, url: str, headers: dict[str, str] | None = None
    ) -> tuple[int, dict[str, Any], str]:
        self.calls.append((verb, url, headers))
        if isinstance(self.answer, BaseException):
            raise self.answer
        status, headers_found, body = self.answer
        return status, headers_found, body


class _Client:
    def __init__(self, answer: Any) -> None:
        self.requester = _Requester(answer)


def _read(record: ConfigRecord, answer: Any, *, now: float = 1000.0) -> tuple[ConfigRecord, str | None, _Client]:
    client = _Client(answer)
    updated, unreadable = revalidate(record, client, _REPO, now=now)  # type: ignore[arg-type]
    return updated, unreadable, client


def test_a_file_read_stores_its_text_etag_size_and_time_and_keeps_the_planners_fields():
    record = ConfigRecord(kind="absent", read_at=1.0, **_PLANNER_FIELDS)

    updated, unreadable, client = _read(record, (200, {"etag": 'W/"e1"'}, _file(_SHADOW)), now=1000.0)

    assert unreadable is None
    assert updated == ConfigRecord(
        kind="file", text=_SHADOW, etag='W/"e1"', size=len(_SHADOW), read_at=1000.0, **_PLANNER_FIELDS
    )
    assert client.requester.calls == [("GET", _URL, None)]


def test_a_stored_file_is_revalidated_with_its_etag_and_a_304_changes_nothing():
    record = ConfigRecord(kind="file", text=_SHADOW, etag='"e1"', size=9, read_at=5.0)

    updated, unreadable, client = _read(record, (304, {}, ""))

    assert (updated, unreadable) == (record, None)
    assert client.requester.calls == [("GET", _URL, {"If-None-Match": '"e1"'})]


def test_a_404_records_the_file_absent_and_forgets_the_file_read():
    record = ConfigRecord(kind="file", text=_SHADOW, etag='"e1"', size=9, read_at=5.0, **_PLANNER_FIELDS)

    updated, unreadable, _client = _read(record, (404, {}, '{"message": "Not Found"}'), now=50.0)

    assert unreadable is None
    assert updated == ConfigRecord(kind="absent", read_at=50.0, **_PLANNER_FIELDS)


def test_an_absent_file_is_asked_again_only_after_its_ttl():
    ttl = CONFIG_ABSENT_TTL.total_seconds()
    record = ConfigRecord(kind="absent", read_at=1000.0)

    held, _unreadable, client = _read(record, AssertionError("read"), now=1000.0 + ttl - 1)
    assert held is record
    assert client.requester.calls == []
    again, _unreadable, client = _read(record, (404, {}, ""), now=1000.0 + ttl)
    assert again.read_at == 1000.0 + ttl
    assert len(client.requester.calls) == 1
    _stepped_back, _unreadable, client = _read(record, (404, {}, ""), now=999.0)
    assert len(client.requester.calls) == 1


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        pytest.param(json.dumps([{"name": "a"}]), "it is a directory, not a file", id="directory"),
        pytest.param(_file("x", size=CONFIG_MAX_BYTES + 1), f"over the {CONFIG_MAX_BYTES}-byte limit", id="too-big"),
        pytest.param(_file("x", kind="symlink"), "it is a symlink, not a file", id="symlink"),
        pytest.param(json.dumps({"type": "file", "size": 2, "content": "//79"}), "not UTF-8 text", id="not-utf8"),
    ],
)
def test_a_file_that_cannot_be_a_config_is_recorded_invalid_with_its_reason(body, reason):
    updated, unreadable, _client = _read(ConfigRecord(), (200, {"etag": '"e"'}, body))

    assert unreadable is None
    assert updated.kind == "invalid"
    assert updated.text is None
    assert updated.reason is not None
    assert reason in updated.reason
    assert updated.etag == '"e"'


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        pytest.param((500, {}, "{}"), "HTTP 500", id="5xx"),
        pytest.param((403, {}, '{"message": "forbidden"}'), "HTTP 403", id="403"),
        pytest.param((200, {}, "not json"), "JSONDecodeError", id="not-json"),
        pytest.param((200, {}, '{"type": "file"}'), "unexpected shape", id="no-size"),
        pytest.param(ConnectionError("reset"), "ConnectionError: reset", id="connection"),
        pytest.param(GithubException(502, {"message": "bad gateway"}), "GithubException", id="exception"),
    ],
)
def test_any_other_failed_read_leaves_the_record_and_says_why(caplog, answer, reason):
    record = ConfigRecord(kind="file", text=_SHADOW, etag='"e1"')

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        updated, unreadable, _client = _read(record, answer)

    assert updated is record
    assert unreadable is not None
    assert reason in unreadable
    assert all(entry.exc_info for entry in caplog.records if "cannot read" in entry.getMessage())


@pytest.mark.parametrize(
    "answer",
    [
        pytest.param((429, {}, "{}"), id="429"),
        pytest.param((403, {"x-ratelimit-remaining": "0"}, "{}"), id="403-exhausted"),
        pytest.param(RateLimitExceededException(403, {"message": "rate limit"}, {}), id="raised"),
    ],
)
def test_a_rate_limit_is_raised(answer):
    with pytest.raises(GithubException) as excinfo:
        _read(ConfigRecord(), answer)
    assert excinfo.value.status in (403, 429)


def test_an_iteration_timeout_propagates():
    with pytest.raises(IterationTimeout):
        _read(ConfigRecord(), IterationTimeout("late"))


def _file_record(text: str, **fields: Any) -> ConfigRecord:
    return ConfigRecord(kind="file", text=text, etag='"e"', size=len(text), read_at=1.0, **fields)


def test_a_valid_file_is_served_and_becomes_the_last_valid_settings():
    decision = decide(_REPO, _file_record(_SHADOW), unreadable=None, reachable=True, drain_complete=False)

    assert decision.settings.entry == _ENTRY
    assert decision.settings.served
    assert decision.settings.problem is None
    assert decision.record.valid_text == _SHADOW
    assert decision.record.served
    assert not decision.persistent


def test_a_file_with_an_unknown_key_is_safety_only_and_still_the_last_valid_settings():
    text = _SHADOW + "extra: 1\n"

    decision = decide(_REPO, _file_record(text), unreadable=None, reachable=True, drain_complete=False)

    assert (decision.settings.entry, decision.settings.served) == (_ENTRY, False)
    assert decision.record.valid_text == text
    assert not decision.record.served


def test_an_invalid_file_is_safety_only_under_the_last_valid_settings():
    record = _file_record("mode: <bad>\n", valid_text=_SHADOW.replace("shadow", "off"), served=True)

    decision = decide(_REPO, record, unreadable=None, reachable=True, drain_complete=False)

    assert decision.settings.entry == dataclasses.replace(_ENTRY, mode="off")
    assert not decision.settings.served
    assert decision.settings.problem is not None
    assert decision.settings.problem.startswith("invalid config, refused:")
    assert decision.settings.problem.endswith("safety-only under its last valid settings instead")
    assert decision.record.valid_text == record.valid_text
    assert decision.record.served


def test_an_invalid_file_with_no_last_valid_settings_is_refused_elsewhere_and_built_in_safety_only_on_the_primary():
    other = decide(_REPO, _file_record("mode: <bad>\n"), unreadable=None, reachable=True, drain_complete=False)
    primary = decide(TARGET_REPO, _file_record("mode: <bad>\n"), unreadable=None, reachable=True, drain_complete=False)
    too_big = ConfigRecord(kind="invalid", reason="the file is 9000 bytes", read_at=1.0)
    directory = decide(_REPO, too_big, unreadable=None, reachable=True, drain_complete=False)

    assert other.settings.entry is None
    assert (primary.settings.entry, primary.settings.served) == (BUILTIN_PYTORCH, False)
    assert directory.settings.entry is None
    assert directory.settings.problem == "invalid config, refused: the file is 9000 bytes"


def test_an_invalid_primary_file_is_safety_only_under_its_last_valid_mode():
    record = _file_record("mode: <bad>\n", valid_text="mode: shadow\n")

    decision = decide(TARGET_REPO, record, unreadable=None, reachable=True, drain_complete=False)

    assert decision.settings.entry == dataclasses.replace(BUILTIN_PYTORCH, mode="shadow")
    assert not decision.settings.served


def test_an_unreadable_file_serves_the_last_file_read_with_the_failure_as_a_problem():
    decision = decide(_REPO, _file_record(_SHADOW), unreadable="HTTP 500", reachable=True, drain_complete=False)

    assert (decision.settings.entry, decision.settings.served) == (_ENTRY, True)
    assert decision.settings.problem == "config unreadable, serving the last file read: HTTP 500"


@pytest.mark.parametrize(("repo", "entry"), [(TARGET_REPO, BUILTIN_PYTORCH), (_REPO, None)])
def test_a_file_never_read_and_unreadable_follows_the_repo_config_rule(repo, entry):
    decision = decide(repo, ConfigRecord(), unreadable="HTTP 500", reachable=True, drain_complete=False)

    assert decision.settings.entry == entry
    assert decision.settings.problem is not None
    assert "config unreadable" in decision.settings.problem
    assert "HTTP 500" in decision.settings.problem


def test_a_file_never_read_and_not_unreadable_is_said_to_be_never_read():
    decision = decide(_REPO, ConfigRecord(), unreadable=None, reachable=True, drain_complete=False)

    assert decision.settings.problem is not None
    assert "it was never read" in decision.settings.problem


def test_an_absent_file_on_a_repo_never_served_gives_no_work_and_no_problem():
    decision = decide(
        _REPO, ConfigRecord(kind="absent", read_at=1.0), unreadable=None, reachable=True, drain_complete=False
    )

    assert (decision.settings.entry, decision.settings.problem) == (None, None)


def test_a_served_repos_removed_file_runs_it_off_until_its_drain_completes():
    record = ConfigRecord(kind="absent", read_at=1.0, valid_text=_SHADOW, served=True)

    draining = decide(_REPO, record, unreadable=None, reachable=True, drain_complete=False)
    drained = decide(_REPO, record, unreadable=None, reachable=True, drain_complete=True)

    assert draining.settings.entry == dataclasses.replace(_ENTRY, mode="off")
    assert draining.settings.problem == REMOVED
    assert draining.record.served
    assert (drained.settings.entry, drained.settings.problem) == (None, None)
    assert not drained.record.served


def test_the_primarys_absent_file_after_a_valid_one_is_safety_only_under_it_never_the_builtins_active():
    record = ConfigRecord(kind="absent", read_at=1.0, valid_text="mode: shadow\n", served=True)

    decision = decide(TARGET_REPO, record, unreadable=None, reachable=True, drain_complete=True)

    assert decision.settings.entry == dataclasses.replace(BUILTIN_PYTORCH, mode="shadow")
    assert not decision.settings.served
    assert decision.settings.problem == PRIMARY_ABSENT


def test_the_primarys_absent_file_with_no_valid_one_ever_is_served_under_the_builtin():
    decision = decide(
        TARGET_REPO, ConfigRecord(kind="absent", read_at=1.0), unreadable=None, reachable=True, drain_complete=False
    )

    assert (decision.settings.entry, decision.settings.served, decision.settings.problem) == (
        BUILTIN_PYTORCH,
        True,
        None,
    )
    assert decision.record.served


def test_a_served_repo_the_installation_no_longer_reaches_is_a_problem_on_every_tick():
    record = _file_record(_SHADOW, valid_text=_SHADOW, served=True)

    stuck = decide(_REPO, record, unreadable=None, reachable=False, drain_complete=False)
    drained = decide(_REPO, record, unreadable=None, reachable=False, drain_complete=True)
    never = decide(_REPO, _file_record(_SHADOW), unreadable=None, reachable=False, drain_complete=False)

    assert (stuck.settings.entry, stuck.settings.problem, stuck.persistent) == (None, UNREACHABLE, True)
    assert stuck.record == record
    assert (drained.settings.entry, drained.settings.problem, drained.persistent) == (None, None, False)
    assert not drained.record.served
    assert (never.settings.entry, never.settings.problem) == (None, None)


def test_a_worker_re_deriving_from_the_stored_record_reaches_the_planners_settings():
    cases = [
        _file_record(_SHADOW),
        _file_record("mode: <bad>\n", valid_text=_SHADOW, served=True),
        ConfigRecord(kind="absent", read_at=1.0, valid_text=_SHADOW, served=True),
    ]
    for record in cases:
        planner = decide(_REPO, record, unreadable=None, reachable=True, drain_complete=False)
        worker = decide(_REPO, planner.record, unreadable=None, reachable=True, drain_complete=False)
        assert (worker.settings.entry, worker.settings.served) == (planner.settings.entry, planner.settings.served)


def test_the_module_names_its_problems():
    assert "cannot be drained" in config_cache.UNREACHABLE


def test_an_absent_file_after_a_valid_one_on_a_repo_never_served_gives_no_work():
    record = ConfigRecord(kind="absent", read_at=1.0, valid_text=_SHADOW + "extra: 1\n", served=False)

    decision = decide(_REPO, record, unreadable=None, reachable=True, drain_complete=False)

    assert (decision.settings.entry, decision.settings.problem) == (None, None)
    assert not decision.record.served
