from __future__ import annotations

import dataclasses
import logging
from datetime import datetime
from typing import Any
from unittest.mock import Mock

import pytest
from github import GithubException, RateLimitExceededException, UnknownObjectException

from greenlight import drain, github_client, merge_authz, repo_scan
from greenlight.constants import REPO_CONFIG_PATH, TARGET_REPO
from greenlight.guards import IterationTimeout
from greenlight.repo_config import BUILTIN_PYTORCH, RepoEntry
from greenlight.repo_scan import RepoIdentity
from greenlight.scan_memory import ScanMemory

_VISION = RepoEntry("pytorch/vision", "greenlight", "gate", "merge_rules", "shadow")
_SNAPSHOT = merge_authz.MergeRulesSnapshot(authorized=frozenset({"alice"}), rules=())
_TOKEN = "t"


def _identity(repo: str, *, private: bool = False, branch: str = "main") -> RepoIdentity:
    return RepoIdentity(repo, private, branch)


class _Content:
    def __init__(self, text: str) -> None:
        self.decoded_content = text.encode()
        self.size = len(self.decoded_content)


class _ContentsRepo:
    def __init__(self, contents: object) -> None:
        self.contents = contents
        self.paths: list[str] = []

    def get_contents(self, path: str) -> object:
        self.paths.append(path)
        if isinstance(self.contents, BaseException):
            raise self.contents
        return self.contents


class _Client:
    def __init__(self, contents: object = None) -> None:
        self.closed = 0
        self.repo = _ContentsRepo(contents)
        self.names: list[str] = []

    def get_repo(self, full_name_or_id: str) -> _ContentsRepo:
        self.names.append(full_name_or_id)
        return self.repo

    def close(self) -> None:
        self.closed += 1


class _Requester:
    def __init__(self, data: dict[str, object]) -> None:
        self.data = data
        self.calls: list[tuple[str, str]] = []

    def requestJsonAndCheck(self, verb: str, url: str) -> tuple[dict[str, str], dict[str, object]]:
        self.calls.append((verb, url))
        return {}, self.data


class _RequesterClient:
    def __init__(self, data: dict[str, object]) -> None:
        self.requester = _Requester(data)


def test_fetch_identity_reads_what_github_reports():
    client = _RequesterClient({"full_name": "pytorch/Vision", "private": False, "default_branch": "main"})

    identity = repo_scan.fetch_identity(client, "pytorch/vision")  # type: ignore[arg-type]

    assert identity == RepoIdentity("pytorch/Vision", False, "main")
    assert client.requester.calls == [("GET", "/repos/pytorch/vision")]


def test_fetch_identity_refuses_an_unexpected_shape():
    with pytest.raises(ValueError, match="unexpected shape"):
        repo_scan.fetch_identity(_RequesterClient({"full_name": "x"}), "pytorch/x")  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("identity", "problem"),
    [
        pytest.param(_identity("pytorch/vision"), None, id="passes"),
        pytest.param(_identity("pytorch/Vision"), "GitHub names it 'pytorch/Vision'", id="case"),
        pytest.param(_identity("pytorch/vision", private=True), "it is private", id="private"),
        pytest.param(_identity("pytorch/vision", branch="master"), "its default branch is 'master'", id="branch"),
    ],
)
def test_identity_problem(identity, problem):
    found = repo_scan.identity_problem(_VISION, identity)

    if problem is None:
        assert found is None
    else:
        assert found is not None
        assert problem in found


def test_the_merge_rules_resolver_reads_the_entrys_own_repo(monkeypatch):
    calls: list[str] = []

    def resolve(_client, repo):
        calls.append(repo)
        return _SNAPSHOT

    monkeypatch.setattr(merge_authz, "resolve_merge_rules", resolve)

    assert repo_scan.eligibility_resolver(_VISION)(object()) is _SNAPSHOT  # type: ignore[arg-type]
    assert calls == ["pytorch/vision"]


def test_write_permission_eligibility_is_not_supported_by_this_release():
    resolve = repo_scan.eligibility_resolver(dataclasses.replace(_VISION, eligibility="write_permission"))

    with pytest.raises(ValueError, match="write_permission eligibility is not supported by this release"):
        resolve(object())  # type: ignore[arg-type]


def test_the_primary_reads_its_eligibility_patiently_and_others_fail_fast(monkeypatch):
    built: list[tuple[str, str]] = []
    monkeypatch.setattr(github_client, "build_authz_client", lambda token: built.append(("patient", token)))
    monkeypatch.setattr(github_client, "build_client", lambda token: built.append(("fast", token)))

    repo_scan.eligibility_client(BUILTIN_PYTORCH, "t1")()
    repo_scan.eligibility_client(_VISION, "t2")()

    assert built == [("patient", "t1"), ("fast", "t2")]


def test_eligibility_caches_are_made_once_per_repo_and_eligibility_with_their_policy():
    caches: repo_scan.EligibilityCaches = {}

    first = repo_scan.eligibility_cache(caches, _VISION, 600.0)
    again = repo_scan.eligibility_cache(caches, _VISION, 5.0)
    other = repo_scan.eligibility_cache(caches, dataclasses.replace(_VISION, eligibility="write_permission"), 600.0)

    assert first is again
    assert other is not first
    assert set(caches) == {("pytorch/vision", "merge_rules"), ("pytorch/vision", "write_permission")}
    assert (first._ttl_seconds, first._max_stale_seconds) == (600.0, 1800.0)


def _file(**fields: str) -> _Content:
    values = {"status_comment": "greenlight", "safety": "gate", "eligibility": "merge_rules", "mode": "shadow"}
    values.update(fields)
    return _Content("".join(f"{key}: {value}\n" for key, value in values.items()))


_MISSING = UnknownObjectException(404)


class _Scan:
    def __init__(self, contents: object, *, identity: RepoIdentity | None = None, failed: tuple[int, ...] = ()):
        self.contents = contents
        self.caches: repo_scan.EligibilityCaches = {}
        self.memories: dict[str, ScanMemory] = {}
        self.review = Mock()
        self.drain = Mock(return_value=drain.DrainReport(1, 0, 0, False, "x", failed))
        self.identity = identity
        self.clients: list[_Client] = []
        self.tokens: list[str] = []

    def _build(self, token: str, **_kwargs: object) -> Any:
        client = _Client(self.contents)
        self.clients.append(client)
        self.tokens.append(token)
        return client

    def run(self, make_config: Any, repo: str, *, pr: int | None = None, token: str | None = _TOKEN) -> None:
        repo_scan.scan_repo(
            make_config(github_token=token),
            repo=repo,
            eligibility_caches=self.caches,
            memories=None if pr is not None else self.memories,
            pr=pr,
            bot_login="bot[bot]",
            build_github=self._build,
            get_identity=lambda _client, name: self.identity or _identity(name),
            run_review=self.review,
            run_drain=self.drain,
            ref="main",
        )


def test_a_served_repo_runs_the_whole_review_with_its_entry_memory_and_eligibility_cache(make_config, monkeypatch):
    scan = _Scan(_file())
    memory = scan.memories["pytorch/vision"] = ScanMemory()
    memory.off_since(datetime(2026, 1, 1))

    scan.run(make_config, "pytorch/vision")

    kwargs = scan.review.call_args.kwargs
    assert kwargs["entry"] == _VISION
    assert kwargs["optional"] is True
    assert kwargs["memory"] is memory
    assert kwargs["pr"] is None
    assert kwargs["bot_login"] == "bot[bot]"
    assert kwargs["ref"] == "main"
    assert memory.off_since(datetime(2026, 2, 2)) == datetime(2026, 2, 2)
    monkeypatch.setattr(github_client, "build_client", lambda _token: _Client())
    monkeypatch.setattr(merge_authz, "resolve_merge_rules", lambda _client, _repo: _SNAPSHOT)
    assert kwargs["resolve_merge_rules"]() is _SNAPSHOT
    cache = scan.caches[("pytorch/vision", "merge_rules")]
    assert cache._ttl_seconds == make_config().merge_rules_ttl_seconds
    assert all(client.closed == 1 for client in scan.clients)
    scan.drain.assert_not_called()


def test_the_config_is_read_fresh_every_scan_from_the_scanned_repo_with_the_scan_token(make_config):
    scan = _Scan(_file())

    scan.run(make_config, "pytorch/vision")
    scan.contents = _file(mode="off")
    scan.run(make_config, "pytorch/vision")

    assert scan.review.call_count == 1
    assert scan.drain.call_count == 1
    assert scan.tokens[:1] == [_TOKEN]
    reads = [client for client in scan.clients if client.repo.paths]
    assert [client.names[0] for client in reads] == ["pytorch/vision", "pytorch/vision"]
    assert all(client.repo.paths == [REPO_CONFIG_PATH] for client in reads)


def test_a_pr_recheck_gets_no_memory(make_config):
    scan = _Scan(_MISSING)

    scan.run(make_config, TARGET_REPO, pr=5)

    assert scan.review.call_args.kwargs["memory"] is None
    assert scan.review.call_args.kwargs["pr"] == 5
    assert scan.memories == {}


def test_the_primary_with_no_file_is_served_under_the_builtin_with_no_problem(make_config):
    scan = _Scan(_MISSING)

    scan.run(make_config, TARGET_REPO)

    assert scan.review.call_args.kwargs["entry"] == BUILTIN_PYTORCH
    assert scan.review.call_args.kwargs["optional"] is True


def test_an_invalid_primary_file_runs_only_its_safety_work_then_fails(make_config):
    scan = _Scan(_Content("mode: paused\n"))

    with pytest.raises(RuntimeError, match=r"pytorch/pytorch: invalid config, safety-only under the built-in entry"):
        scan.run(make_config, TARGET_REPO)

    assert scan.review.call_args.kwargs["optional"] is False
    assert scan.review.call_args.kwargs["entry"] == BUILTIN_PYTORCH


def test_a_file_with_an_unknown_key_runs_only_the_safety_work_then_fails(make_config):
    scan = _Scan(_file(extra="1"))

    with pytest.raises(RuntimeError, match=r"pytorch/vision: safety-only: unknown key\(s\) \['extra'\]"):
        scan.run(make_config, "pytorch/vision")

    assert scan.review.call_args.kwargs["optional"] is False
    assert scan.review.call_args.kwargs["entry"] == _VISION


def test_a_refused_repo_gets_no_work_and_fails_with_its_reason(make_config):
    scan = _Scan(_file(mode="<bad>"))

    with pytest.raises(RuntimeError, match="pytorch/vision: invalid config, refused: mode '<bad>' is not one of"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()
    assert all(client.closed == 1 for client in scan.clients)


def test_a_repo_with_no_file_gets_no_work_and_fails(make_config):
    scan = _Scan(_MISSING)

    with pytest.raises(RuntimeError, match=f"pytorch/vision has no GreenLight config at {REPO_CONFIG_PATH}"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()


def test_a_repo_failing_a_live_check_gets_no_work_and_fails(make_config):
    scan = _Scan(_file(), identity=_identity("pytorch/vision", private=True))

    with pytest.raises(RuntimeError, match="refused for this scan: it is private"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()
    assert all(client.closed == 1 for client in scan.clients)


def test_a_live_check_failure_also_reports_the_settings_problem(make_config):
    scan = _Scan(_file(extra="1"), identity=_identity("pytorch/vision", private=True))

    with pytest.raises(RuntimeError, match=r"safety-only: unknown key.*; refused for this scan: it is private"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()


def test_an_off_repo_drains_with_its_memory_instead_of_reviewing(make_config):
    scan = _Scan(_file(mode="off"))

    scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()
    kwargs = scan.drain.call_args.kwargs
    assert kwargs["repo"] == "pytorch/vision"
    assert kwargs["memory"] is scan.memories["pytorch/vision"]
    assert kwargs["bot_login"] == "bot[bot]"


def test_a_drain_that_failed_on_a_pr_fails_the_scan(make_config):
    scan = _Scan(_file(mode="off"), failed=(4,))

    with pytest.raises(RuntimeError, match=r"the drain failed on 1 PR\(s\): \[4\]"):
        scan.run(make_config, "pytorch/vision")


def test_a_recheck_of_an_off_repo_does_nothing(make_config, caplog):
    scan = _Scan(_file(mode="off"))

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        scan.run(make_config, "pytorch/vision", pr=3)

    scan.review.assert_not_called()
    scan.drain.assert_not_called()
    assert "pytorch/vision is off: --pr reviews nothing" in caplog.text


@pytest.mark.parametrize("pr", [None, 5], ids=["cold", "recheck"])
def test_a_cold_unreadable_primary_file_serves_the_builtin_entry_and_fails_after_the_work(make_config, pr):
    scan = _Scan(GithubException(502))

    with pytest.raises(RuntimeError, match="config unreadable, serving the built-in entry: GithubException"):
        scan.run(make_config, TARGET_REPO, pr=pr)

    assert scan.review.call_args.kwargs["entry"] == BUILTIN_PYTORCH
    assert scan.review.call_args.kwargs["optional"] is True


@pytest.mark.parametrize("mode", ["off", "shadow"])
def test_a_warm_off_or_shadow_primary_stays_so_on_an_unreadable_read(make_config, mode):
    scan = _Scan(_Content(f"mode: {mode}\n"))
    scan.run(make_config, TARGET_REPO)
    scan.contents = GithubException(502)

    with pytest.raises(RuntimeError, match="config unreadable, serving the last settings read: GithubException"):
        scan.run(make_config, TARGET_REPO)

    if mode == "off":
        assert scan.drain.call_count == 2
        scan.review.assert_not_called()
    else:
        assert scan.review.call_count == 2
        assert scan.review.call_args.kwargs["entry"].mode == "shadow"
        assert scan.review.call_args.kwargs["optional"] is True


def test_a_warm_active_primary_keeps_its_optional_work_on_an_unreadable_read(make_config):
    scan = _Scan(_MISSING)
    scan.run(make_config, TARGET_REPO)
    scan.contents = GithubException(502)

    with pytest.raises(RuntimeError, match="serving the last settings read"):
        scan.run(make_config, TARGET_REPO)

    assert scan.review.call_args.kwargs["entry"] == BUILTIN_PYTORCH
    assert scan.review.call_args.kwargs["optional"] is True


def test_a_warm_invalid_primary_stays_safety_only_on_an_unreadable_read(make_config):
    scan = _Scan(_Content("mode: paused\n"))
    with pytest.raises(RuntimeError, match="invalid config"):
        scan.run(make_config, TARGET_REPO)
    scan.contents = GithubException(502)

    with pytest.raises(RuntimeError, match="serving the last settings read"):
        scan.run(make_config, TARGET_REPO)

    assert scan.review.call_args.kwargs["optional"] is False


def test_a_warm_other_repo_keeps_its_settings_on_an_unreadable_read(make_config):
    scan = _Scan(_file())
    scan.run(make_config, "pytorch/vision")
    scan.contents = GithubException(502)

    with pytest.raises(RuntimeError, match="pytorch/vision: config unreadable, serving the last settings read"):
        scan.run(make_config, "pytorch/vision")

    assert scan.review.call_count == 2
    assert scan.review.call_args.kwargs["entry"] == _VISION
    assert scan.memories["pytorch/vision"].last_settings is not None
    assert scan.memories["pytorch/vision"].last_settings.kind == "valid"


def test_an_unreadable_file_elsewhere_gives_no_work(make_config):
    scan = _Scan(GithubException(403, {"message": "forbidden"}))

    with pytest.raises(RuntimeError, match="pytorch/vision: config unreadable, no work"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()


@pytest.mark.parametrize("error", [RateLimitExceededException(403), IterationTimeout("late")])
def test_a_rate_limit_or_timeout_reading_the_config_stops_the_scan(make_config, error):
    scan = _Scan(error)

    with pytest.raises(type(error)):
        scan.run(make_config, TARGET_REPO)
    scan.review.assert_not_called()
    assert all(client.closed == 1 for client in scan.clients)


def test_a_scan_needs_a_token(make_config):
    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        _Scan(_MISSING).run(make_config, TARGET_REPO, token=None)
