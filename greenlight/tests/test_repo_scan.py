from __future__ import annotations

import dataclasses
import logging
from datetime import datetime
from typing import Any, NoReturn
from unittest.mock import Mock

import pytest
from github import RateLimitExceededException

from greenlight import drain, github_client, merge_authz, repo_scan, writers
from greenlight.constants import TARGET_REPO
from greenlight.guards import IterationTimeout
from greenlight.repo_config import BUILTIN_CONFIG, BUILTIN_PYTORCH, RepoConfig, RepoEntry
from greenlight.repo_scan import RepoIdentity
from greenlight.scan_memory import ScanMemory
from greenlight.snapshot_cache import SnapshotCache

_VISION = RepoEntry("pytorch/vision", "greenlight", "gate", "merge_rules", "shadow")
_SNAPSHOT = merge_authz.MergeRulesSnapshot(authorized=frozenset({"alice"}), rules=())
_TOKEN = "t"


def _identity(repo: str, *, private: bool = False, branch: str = "main") -> RepoIdentity:
    return RepoIdentity(repo, private, branch)


class _Client:
    def __init__(self) -> None:
        self.closed = 0

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


def test_the_write_permission_resolver_reads_the_entrys_own_writers(monkeypatch):
    calls: list[str] = []

    def resolve(_client, repo):
        calls.append(repo)
        return _SNAPSHOT

    monkeypatch.setattr(writers, "resolve_writers", resolve)
    monkeypatch.setattr(merge_authz, "resolve_merge_rules", _unexpected_merge_rules_read)

    resolver = repo_scan.eligibility_resolver(dataclasses.replace(_VISION, eligibility="write_permission"))

    assert resolver(object()) is _SNAPSHOT  # type: ignore[arg-type]
    assert calls == ["pytorch/vision"]
    assert resolver.__name__ == "writers of pytorch/vision"


def _unexpected_merge_rules_read(_client: object, repo: str) -> NoReturn:
    raise AssertionError(f"a write_permission entry read the merge rules of {repo}")


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
    assert (first._ttl_seconds, first._max_stale_seconds, first._stale_on_broken) == (600.0, 1800.0, False)


def _config_cache(fetch: Any) -> SnapshotCache[Any, RepoConfig]:
    return SnapshotCache(fetch, ttl_seconds=0, max_stale_seconds=None, stale_on_broken=True)


def _config(
    *served: RepoEntry,
    safety_only: tuple[tuple[RepoEntry, str], ...] = (),
    refused: tuple[tuple[str, str], ...] = (),
) -> RepoConfig:
    return RepoConfig(served=served, safety_only=safety_only, refused=refused)


class _Scan:
    def __init__(self, config_fetch: Any, *, identity: RepoIdentity | None = None, failed: tuple[int, ...] = ()):
        self.config_cache = _config_cache(config_fetch)
        self.caches: repo_scan.EligibilityCaches = {}
        self.memories: dict[str, ScanMemory] = {}
        self.review = Mock()
        self.drain = Mock(return_value=drain.DrainReport(1, 0, 0, False, "x", failed))
        self.identity = identity
        self.clients: list[_Client] = []

    def _build(self, _token: str, **_kwargs: object) -> Any:
        client = _Client()
        self.clients.append(client)
        return client

    def run(self, make_config: Any, repo: str, *, pr: int | None = None, token: str | None = _TOKEN) -> None:
        repo_scan.scan_repo(
            make_config(github_token=token),
            repo=repo,
            config_cache=self.config_cache,
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
    scan = _Scan(lambda _client: _config(BUILTIN_PYTORCH, _VISION))
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


def test_a_write_permission_repo_reviews_with_its_writers_through_its_own_cache(make_config, monkeypatch):
    writer_entry = dataclasses.replace(_VISION, eligibility="write_permission")
    scan = _Scan(lambda _client: _config(BUILTIN_PYTORCH, writer_entry))

    scan.run(make_config, "pytorch/vision")

    monkeypatch.setattr(github_client, "build_client", lambda _token: _Client())
    monkeypatch.setattr(writers, "resolve_writers", lambda _client, _repo: _SNAPSHOT)
    monkeypatch.setattr(merge_authz, "resolve_merge_rules", _unexpected_merge_rules_read)
    assert scan.review.call_args.kwargs["entry"] == writer_entry
    assert scan.review.call_args.kwargs["resolve_merge_rules"]() is _SNAPSHOT
    assert set(scan.caches) == {("pytorch/vision", "write_permission")}


def test_a_pr_recheck_gets_no_memory(make_config):
    scan = _Scan(lambda _client: _config(BUILTIN_PYTORCH))

    scan.run(make_config, TARGET_REPO, pr=5)

    assert scan.review.call_args.kwargs["memory"] is None
    assert scan.review.call_args.kwargs["pr"] == 5
    assert scan.memories == {}


def test_a_safety_only_repo_runs_only_its_safety_work_then_fails(make_config):
    scan = _Scan(lambda _client: _config(safety_only=((BUILTIN_PYTORCH, "its entry is missing"),)))

    with pytest.raises(RuntimeError, match=r"pytorch/pytorch: safety-only: its entry is missing"):
        scan.run(make_config, TARGET_REPO)

    assert scan.review.call_args.kwargs["optional"] is False
    assert scan.review.call_args.kwargs["entry"] == BUILTIN_PYTORCH


def test_a_refused_repo_gets_no_work_and_fails_with_its_reason(make_config):
    scan = _Scan(lambda _client: _config(BUILTIN_PYTORCH, refused=(("pytorch/vision", "mode is missing"),)))

    with pytest.raises(RuntimeError, match="pytorch/vision: refused: mode is missing"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()


def test_an_absent_repo_gets_no_work_and_fails(make_config):
    scan = _Scan(lambda _client: _config(BUILTIN_PYTORCH))

    with pytest.raises(RuntimeError, match="pytorch/vision: it has no entry in the repos config"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()


def test_a_repo_failing_a_live_check_gets_no_work_and_fails(make_config):
    scan = _Scan(lambda _client: _config(BUILTIN_PYTORCH, _VISION), identity=_identity("pytorch/vision", private=True))

    with pytest.raises(RuntimeError, match="refused for this scan: it is private"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()
    assert all(client.closed == 1 for client in scan.clients)


def test_an_off_repo_drains_with_its_memory_instead_of_reviewing(make_config):
    off = dataclasses.replace(_VISION, mode="off")
    scan = _Scan(lambda _client: _config(BUILTIN_PYTORCH, off))

    scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()
    kwargs = scan.drain.call_args.kwargs
    assert kwargs["repo"] == "pytorch/vision"
    assert kwargs["memory"] is scan.memories["pytorch/vision"]
    assert kwargs["bot_login"] == "bot[bot]"


def test_a_drain_that_failed_on_a_pr_fails_the_scan(make_config):
    off = dataclasses.replace(_VISION, mode="off")
    scan = _Scan(lambda _client: _config(BUILTIN_PYTORCH, off), failed=(4,))

    with pytest.raises(RuntimeError, match=r"the drain failed on 1 PR\(s\): \[4\]"):
        scan.run(make_config, "pytorch/vision")


def test_a_recheck_of_an_off_repo_does_nothing(make_config, caplog):
    off = dataclasses.replace(_VISION, mode="off")
    scan = _Scan(lambda _client: _config(BUILTIN_PYTORCH, off))

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        scan.run(make_config, "pytorch/vision", pr=3)

    scan.review.assert_not_called()
    scan.drain.assert_not_called()
    assert "pytorch/vision is off: --pr reviews nothing" in caplog.text


def test_a_cold_config_failure_serves_the_builtin_entry_and_fails_after_the_safety_work(make_config):
    def broken(_client):
        raise ValueError("broken yaml")

    scan = _Scan(broken)

    with pytest.raises(RuntimeError, match="repos config unreadable, serving only the built-in entry: broken yaml"):
        scan.run(make_config, TARGET_REPO)

    assert scan.review.call_args.kwargs["entry"] == BUILTIN_CONFIG.served[0]
    assert scan.review.call_args.kwargs["optional"] is True


def test_a_stale_config_is_served_and_reported(make_config):
    results: list[object] = [_config(BUILTIN_PYTORCH), ValueError("broken on main")]

    def fetch(_client):
        result = results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    scan = _Scan(fetch)
    scan.run(make_config, TARGET_REPO)

    with pytest.raises(RuntimeError, match="serving the last good snapshot: broken on main"):
        scan.run(make_config, TARGET_REPO)
    assert scan.review.call_count == 2


def test_a_config_carrying_a_file_error_is_reported(make_config):
    scan = _Scan(lambda _client: dataclasses.replace(BUILTIN_CONFIG, error="gone"))

    with pytest.raises(RuntimeError, match="repos config unreadable: gone"):
        scan.run(make_config, TARGET_REPO)


@pytest.mark.parametrize("error", [RateLimitExceededException(403), IterationTimeout("late")])
def test_a_rate_limit_or_timeout_reading_the_config_stops_the_scan(make_config, error):
    def fetch(_client):
        raise error

    scan = _Scan(fetch)

    with pytest.raises(type(error)):
        scan.run(make_config, TARGET_REPO)
    scan.review.assert_not_called()


def test_a_scan_needs_a_token(make_config):
    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        _Scan(lambda _client: BUILTIN_CONFIG).run(make_config, TARGET_REPO, token=None)
