from __future__ import annotations

import base64
import dataclasses
import json
import logging
from datetime import datetime
from typing import Any, NoReturn, cast
from unittest.mock import Mock

import pytest
from github import GithubException, RateLimitExceededException

from greenlight import approval_backing, drain, github_client, merge_authz, quota, repo_config, repo_scan, writers
from greenlight.constants import CONFIG_ABSENT_TTL, REPO_CONFIG_PATH, TARGET_REPO
from greenlight.gate_rules import GateRules
from greenlight.guards import IterationTimeout
from greenlight.repo_config import BUILTIN_PYTORCH, RepoEntry
from greenlight.repo_scan import RepoIdentity
from greenlight.scan_memory import ScanMemory, decode_memory, encode_memory
from greenlight.state_store import EligibilityKey, InProcessStore, StoreError

_VISION = RepoEntry("pytorch/vision", "greenlight", "gate", "merge_rules", "shadow")
_SNAPSHOT = merge_authz.MergeRulesSnapshot(authorized=frozenset({"alice"}), rules=())
_TOKEN = "t"
_ACTIVE = dataclasses.replace(_VISION, mode="active")
_ENFORCED = GateRules(enforced=True)
_NOT_ENFORCED = GateRules(enforced=False, problems=("a merge_queue rule applies", "no pull_request rule"))


def _backing_report(
    rules: GateRules | None = _ENFORCED, errors: tuple[str, ...] = ()
) -> approval_backing.BackingReport:
    return approval_backing.BackingReport(rules, 0, 0, 0, 0, 0, 1, 0, 0, (), errors)


def _identity(repo: str, *, private: bool = False, branch: str = "main", archived: bool = False) -> RepoIdentity:
    return RepoIdentity(repo, private, branch, archived)


def _content(text: str) -> tuple[int, dict[str, str], str]:
    """The contents API's answer for a config file holding ``text``, its etag naming the text."""
    body = {"type": "file", "size": len(text.encode()), "content": base64.b64encode(text.encode()).decode()}
    return 200, {"etag": f'"{hash(text)}"'}, json.dumps(body)


class _Client:
    """``GET /repos/{repo}`` answers ``identity``; the config read answers ``contents`` (an answer or a raise)."""

    def __init__(self, contents: object = None, identity: RepoIdentity | None = None) -> None:
        self.closed = 0
        self.contents = contents
        self.identity = identity
        self.requester = self
        self.urls: list[str] = []

    def requestJsonAndCheck(self, verb: str, url: str) -> tuple[dict[str, str], dict[str, object]]:
        assert (verb, url[: len("/repos/")]) == ("GET", "/repos/")
        self.urls.append(url)
        identity = self.identity or _identity(url[len("/repos/") :])
        return {}, identity._asdict()

    def requestJson(
        self, verb: str, url: str, headers: dict[str, str] | None = None
    ) -> tuple[int, dict[str, str], str]:
        assert verb == "GET"
        self.urls.append(url)
        if isinstance(self.contents, BaseException):
            raise self.contents
        status, found, body = cast("tuple[int, dict[str, str], str]", self.contents)
        if headers and headers.get("If-None-Match") == found.get("etag"):
            return 304, {}, ""
        return status, found, body

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

    assert identity == RepoIdentity("pytorch/Vision", False, "main", False)
    assert client.requester.calls == [("GET", "/repos/pytorch/vision")]


def test_fetch_identity_reads_the_archived_flag():
    data = {"full_name": "pytorch/vision", "private": False, "default_branch": "main", "archived": True}

    identity = repo_scan.fetch_identity(_RequesterClient(data), "pytorch/vision")  # type: ignore[arg-type]

    assert identity.archived is True


@pytest.mark.parametrize(
    "data",
    [
        {"full_name": "x"},
        {"full_name": "pytorch/x", "private": False, "default_branch": "main", "archived": "no"},
    ],
)
def test_fetch_identity_refuses_an_unexpected_shape(data):
    with pytest.raises(ValueError, match="unexpected shape"):
        repo_scan.fetch_identity(_RequesterClient(data), "pytorch/x")  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("identity", "problem"),
    [
        pytest.param(_identity("pytorch/vision"), None, id="passes"),
        pytest.param(_identity("pytorch/Vision"), "GitHub names it 'pytorch/Vision'", id="case"),
        pytest.param(_identity("pytorch/vision", private=True), "it is private", id="private"),
        pytest.param(_identity("pytorch/vision", archived=True), "it is archived", id="archived"),
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


def test_check_identity_passes_a_repo_passing_every_live_check_and_refuses_any_other():
    repo_scan.check_identity(_VISION, _identity("pytorch/vision"))

    with pytest.raises(repo_scan.RepoUnavailable, match="it is private"):
        repo_scan.check_identity(_VISION, _identity("pytorch/vision", private=True))


@pytest.mark.parametrize(
    ("identity", "problem"),
    [
        pytest.param(_identity("pytorch/Vision"), None, id="name-is-not-visibility"),
        pytest.param(_identity("pytorch/vision", private=True), "it is private", id="private"),
        pytest.param(_identity("pytorch/vision", archived=True), "it is archived", id="archived"),
    ],
)
def test_visibility_problem(identity, problem):
    assert repo_scan.visibility_problem(identity) == problem


@pytest.mark.parametrize(
    ("entry", "served", "work"),
    [
        pytest.param(dataclasses.replace(_VISION, mode="off"), True, ("drain", False), id="off"),
        pytest.param(dataclasses.replace(BUILTIN_PYTORCH, mode="off"), False, ("drain", False), id="off-safety-only"),
        pytest.param(BUILTIN_PYTORCH, True, ("review", True), id="pytorchbot"),
        pytest.param(BUILTIN_PYTORCH, False, ("review", False), id="pytorchbot-safety-only"),
        pytest.param(_VISION, True, ("review", True), id="gate-shadow"),
        pytest.param(dataclasses.replace(_VISION, mode="active"), True, ("review", True), id="gate-active"),
        pytest.param(_VISION, False, ("backing", False), id="gate-safety-only"),
    ],
)
def test_repo_work_routes_every_entry(entry, served, work):
    assert repo_scan.repo_work(entry, served=served) == work


@pytest.mark.parametrize(
    ("work", "drain_complete", "expected"),
    [
        pytest.param(repo_scan.RepoWork("backing", optional=False), True, True, id="backing"),
        pytest.param(repo_scan.RepoWork("review", optional=False), True, True, id="review"),
        pytest.param(repo_scan.RepoWork("drain", optional=False), False, True, id="draining"),
        pytest.param(repo_scan.RepoWork("drain", optional=False), True, False, id="drained"),
    ],
)
def test_every_work_but_a_complete_drain_is_work_for_the_scan_lambda(work, drain_complete, expected):
    assert repo_scan.has_work(work, drain_complete=drain_complete) is expected


@pytest.mark.parametrize(
    ("entry", "backs"),
    [
        pytest.param(_VISION, True, id="gate-shadow"),
        pytest.param(_ACTIVE, True, id="gate-active"),
        pytest.param(dataclasses.replace(_VISION, mode="off"), False, id="gate-off"),
        pytest.param(BUILTIN_PYTORCH, False, id="pytorchbot"),
    ],
)
def test_every_gate_entry_but_an_off_one_backs_approvals(entry, backs):
    assert repo_scan.backs_approvals(entry) is backs


@pytest.mark.parametrize(
    ("entry", "report", "refusal"),
    [
        pytest.param(_ACTIVE, _backing_report(), None, id="enforced"),
        pytest.param(_ACTIVE, _backing_report(None), "no dispatch this run: the rules could not be read", id="unknown"),
        pytest.param(_ACTIVE, None, "no dispatch this run: the rules could not be read", id="no-report"),
        pytest.param(
            _ACTIVE,
            _backing_report(_NOT_ENFORCED),
            "no dispatch this run: GreenLight's gate is not enforced on pytorch/vision: "
            "a merge_queue rule applies; no pull_request rule",
            id="not-enforced",
        ),
        pytest.param(_VISION, _backing_report(_NOT_ENFORCED), None, id="shadow"),
        pytest.param(_VISION, None, None, id="shadow-no-report"),
        pytest.param(BUILTIN_PYTORCH, None, None, id="pytorchbot"),
    ],
)
def test_only_an_active_gate_entry_without_enforced_rules_is_refused_a_dispatch(entry, report, refusal):
    assert repo_scan.dispatch_refusal(entry, report) == refusal


def test_the_merge_rules_resolver_reads_the_entrys_own_repo(monkeypatch):
    calls: list[str] = []

    def resolve(_client, repo):
        calls.append(repo)
        return _SNAPSHOT

    monkeypatch.setattr(merge_authz, "resolve_merge_rules", resolve)

    label, fetch = repo_scan.eligibility_resolver(_VISION)

    assert fetch(object()) is _SNAPSHOT  # type: ignore[arg-type]
    assert calls == ["pytorch/vision"]
    assert label == "merge rules of pytorch/vision"


@pytest.mark.parametrize("minimum_role", ["write", "maintain"])
def test_the_write_permission_resolver_reads_the_entrys_own_writers_at_its_minimum_role(monkeypatch, minimum_role):
    calls: list[tuple[str, str]] = []

    def resolve(_client, repo, *, minimum_role):
        calls.append((repo, minimum_role))
        return _SNAPSHOT

    monkeypatch.setattr(writers, "resolve_writers", resolve)
    monkeypatch.setattr(merge_authz, "resolve_merge_rules", _unexpected_merge_rules_read)

    entry = dataclasses.replace(_VISION, eligibility="write_permission", minimum_role=minimum_role)
    label, fetch = repo_scan.eligibility_resolver(entry)

    assert fetch(object()) is _SNAPSHOT  # type: ignore[arg-type]
    assert calls == [("pytorch/vision", minimum_role)]
    assert label == f"{minimum_role}-role writers of pytorch/vision"


def _unexpected_merge_rules_read(_client: object, repo: str) -> NoReturn:
    raise AssertionError(f"a write_permission entry read the merge rules of {repo}")


def test_the_primary_reads_its_eligibility_patiently_and_others_fail_fast(monkeypatch):
    built: list[tuple[str, str, object]] = []
    monkeypatch.setattr(
        github_client, "build_authz_client", lambda token, *, meter: built.append(("patient", token, meter))
    )
    monkeypatch.setattr(github_client, "build_client", lambda token, *, meter: built.append(("fast", token, meter)))

    repo_scan.eligibility_client(BUILTIN_PYTORCH, "t1")()
    repo_scan.eligibility_client(_VISION, "t2")()

    assert built == [("patient", "t1", None), ("fast", "t2", None)]


def test_the_eligibility_client_carries_the_repos_meter(monkeypatch):
    built: list[tuple[str, object]] = []
    monkeypatch.setattr(github_client, "build_authz_client", lambda _token, *, meter: built.append(("patient", meter)))
    monkeypatch.setattr(github_client, "build_client", lambda _token, *, meter: built.append(("fast", meter)))
    tick = quota.TickMeter()

    repo_scan.eligibility_client(BUILTIN_PYTORCH, "t1", meter=tick.meter(TARGET_REPO))()
    repo_scan.eligibility_client(_VISION, "t2", meter=tick.meter("pytorch/vision"))()

    assert built == [("patient", tick.meter(TARGET_REPO)), ("fast", tick.meter("pytorch/vision"))]


def test_an_eligibility_cache_has_its_policy_and_label_per_repo_eligibility_and_minimum_role():
    store = InProcessStore()
    writers_entry = dataclasses.replace(_VISION, eligibility="write_permission")

    first = repo_scan.eligibility_cache(store, _VISION, 600.0)
    other = repo_scan.eligibility_cache(store, writers_entry, 600.0)
    maintainers = repo_scan.eligibility_cache(store, dataclasses.replace(writers_entry, minimum_role="maintain"), 5.0)

    assert (first._ttl_seconds, first._max_stale_seconds) == (600.0, 1800.0)
    assert (maintainers._ttl_seconds, maintainers._max_stale_seconds) == (5.0, 15.0)
    assert (first._label, other._label, maintainers._label) == (
        "merge rules of pytorch/vision",
        "write-role writers of pytorch/vision",
        "maintain-role writers of pytorch/vision",
    )


def test_an_eligibility_snapshot_is_kept_in_the_store_and_served_from_it_inside_its_ttl(monkeypatch):
    store = InProcessStore()
    reads: list[str] = []

    def resolve(_client: object, repo: str) -> merge_authz.MergeRulesSnapshot:
        reads.append(repo)
        return _SNAPSHOT

    monkeypatch.setattr(merge_authz, "resolve_merge_rules", resolve)
    monkeypatch.setattr(github_client, "build_client", lambda _token, **_kwargs: _Client())

    assert repo_scan.eligibility_cache(store, _VISION, 600.0).snapshot(_Client) == _SNAPSHOT  # type: ignore[arg-type]
    assert repo_scan.eligibility_cache(store, _VISION, 600.0).snapshot(_Client) == _SNAPSHOT  # type: ignore[arg-type]

    assert reads == ["pytorch/vision"]
    stored = store.read_eligibility(EligibilityKey("pytorch/vision", "merge_rules", "write"))
    assert stored is not None
    assert merge_authz.decode_snapshot(stored[0]) == _SNAPSHOT
    assert store.read_eligibility(EligibilityKey("pytorch/vision", "write_permission", "write")) is None


class _BrokenEligibilityStore(InProcessStore):
    def __init__(self, *, blob: bytes | None = None) -> None:
        super().__init__()
        self.blob = blob

    def read_eligibility(self, key: EligibilityKey) -> tuple[bytes, float] | None:
        if self.blob is not None:
            return self.blob, 0.0
        raise StoreError("down")

    def write_eligibility(self, key: EligibilityKey, snapshot: bytes, fetched_at: float) -> None:
        raise StoreError("down")


@pytest.mark.parametrize(
    "store", [_BrokenEligibilityStore(), _BrokenEligibilityStore(blob=b"junk")], ids=["down", "bad"]
)
def test_a_store_that_cannot_keep_a_snapshot_only_costs_a_fetch_and_is_logged(monkeypatch, caplog, store):
    monkeypatch.setattr(merge_authz, "resolve_merge_rules", lambda _client, _repo: _SNAPSHOT)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        assert repo_scan.eligibility_cache(store, _VISION, 600.0).snapshot(_Client) == _SNAPSHOT  # type: ignore[arg-type]

    assert "cannot load the stored eligibility snapshot" in caplog.text
    assert all(record.exc_info for record in caplog.records if record.levelno >= logging.ERROR)
    if store.blob is None:
        assert "cannot store the eligibility snapshot" in caplog.text


def test_a_timeout_loading_a_stored_snapshot_propagates():
    class _Late(InProcessStore):
        def read_eligibility(self, key: EligibilityKey) -> tuple[bytes, float] | None:
            raise IterationTimeout("late")

    with pytest.raises(IterationTimeout):
        repo_scan.eligibility_cache(_Late(), _VISION, 600.0)


def _file(**fields: str) -> tuple[int, dict[str, str], str]:
    values = {"status_comment": "greenlight", "safety": "gate", "eligibility": "merge_rules", "mode": "shadow"}
    values.update(fields)
    return _content("".join(f"{key}: {value}\n" for key, value in values.items()))


_MISSING: tuple[int, dict[str, str], str] = (404, {}, '{"message": "Not Found"}')


class _Scan:
    def __init__(
        self,
        contents: object,
        *,
        identity: RepoIdentity | None = None,
        failed: tuple[int, ...] = (),
        backing: approval_backing.BackingReport | None = None,
    ):
        self.contents = contents
        self.clock = [1000.0]
        self.store = InProcessStore()
        self.review = Mock()
        self.drain = Mock(return_value=drain.DrainReport(1, 0, 0, False, "x", failed))
        self.backing = Mock(return_value=backing or _backing_report())
        self.identity = identity
        self.clients: list[_Client] = []
        self.tokens: list[str] = []

    def memory(self, repo: str) -> ScanMemory | None:
        """The memory the store keeps for ``repo``, None when none was saved."""
        blob = self.store.read_repo(repo).memory
        return None if blob is None else decode_memory(blob, repo)

    def seed(self, repo: str, memory: ScanMemory) -> None:
        self.store.save_memory(repo, encode_memory(memory, repo), owner=None, now=0.0, tick=None, drain_complete=False)

    def _build(self, token: str, **_kwargs: object) -> Any:
        client = _Client(self.contents, self.identity)
        self.clients.append(client)
        self.tokens.append(token)
        return client

    def run(
        self,
        make_config: Any,
        repo: str,
        *,
        pr: int | None = None,
        token: str | None = _TOKEN,
        dispatch_token: str | None = None,
    ) -> None:
        repo_scan.scan_repo(
            make_config(github_token=token, dispatch_token=dispatch_token),
            repo=repo,
            store=self.store,
            keep_memory=pr is None,
            pr=pr,
            bot_login="bot[bot]",
            build_github=self._build,
            run_review=self.review,
            run_drain=self.drain,
            run_backing=self.backing,
            clock=lambda: self.clock[0],
            ref="main",
        )


def test_a_served_repo_runs_the_whole_review_with_its_entry_memory_and_eligibility_cache(make_config, monkeypatch):
    scan = _Scan(_file())
    seeded = ScanMemory()
    seeded.mark_full_tick(datetime(2026, 1, 1))
    seeded.off_since(datetime(2026, 1, 1))
    scan.seed("pytorch/vision", seeded)

    scan.run(make_config, "pytorch/vision")

    kwargs = scan.review.call_args.kwargs
    assert kwargs["entry"] == _VISION
    assert kwargs["optional"] is True
    assert kwargs["memory"]._last_full_tick_started == datetime(2026, 1, 1)
    assert kwargs["pr"] is None
    assert kwargs["bot_login"] == "bot[bot]"
    assert kwargs["ref"] == "main"
    saved = scan.memory("pytorch/vision")
    assert saved is not None
    assert saved.off_since(datetime(2026, 2, 2)) == datetime(2026, 2, 2)
    assert saved._last_full_tick_started == datetime(2026, 1, 1)
    monkeypatch.setattr(github_client, "build_client", lambda _token, **_kwargs: _Client())
    monkeypatch.setattr(merge_authz, "resolve_merge_rules", lambda _client, _repo: _SNAPSHOT)
    assert kwargs["resolve_merge_rules"]() == _SNAPSHOT
    assert store_key_set(scan.store) == {"eligibility#pytorch/vision#merge_rules#write", "repo#pytorch/vision"}
    assert all(client.closed == 1 for client in scan.clients)
    scan.drain.assert_not_called()


def store_key_set(store: InProcessStore) -> set[str]:
    return set(store.items)


def test_a_listing_scan_saves_its_memory_even_when_it_fails(make_config):
    scan = _Scan(_file())
    scan.review.side_effect = RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        scan.run(make_config, "pytorch/vision")

    assert scan.memory("pytorch/vision") is not None
    assert scan.store.read_repo("pytorch/vision").last_tick is None


def test_the_config_is_revalidated_every_scan_through_the_config_cache_on_the_store(make_config):
    scan = _Scan(_file())

    scan.run(make_config, "pytorch/vision")
    scan.run(make_config, "pytorch/vision")
    scan.contents = _file(mode="off")
    scan.run(make_config, "pytorch/vision")

    assert scan.review.call_count == 2
    assert scan.drain.call_count == 1
    assert scan.tokens == [_TOKEN] * 3
    config_url = f"/repos/pytorch/vision/contents/{REPO_CONFIG_PATH}"
    assert [client.urls for client in scan.clients] == [["/repos/pytorch/vision", config_url]] * 3
    record = scan.store.read_repo("pytorch/vision").config
    assert (record.kind, record.etag, record.read_at) == ("file", _file(mode="off")[1]["etag"], 1000.0)
    assert record.served


@pytest.mark.parametrize(
    ("fields", "minimum_role"),
    [
        pytest.param({}, "write", id="default-role"),
        pytest.param({"minimum_role": "maintain"}, "maintain", id="maintain-role"),
    ],
)
def test_a_write_permission_repo_reviews_with_its_writers_through_its_own_cache(
    make_config, monkeypatch, fields, minimum_role
):
    writer_entry = dataclasses.replace(_VISION, eligibility="write_permission", minimum_role=minimum_role)
    scan = _Scan(_file(eligibility="write_permission", **fields))

    scan.run(make_config, "pytorch/vision")

    roles: list[str] = []

    def resolve(_client: object, _repo: str, *, minimum_role: str) -> merge_authz.MergeRulesSnapshot:
        roles.append(minimum_role)
        return _SNAPSHOT

    monkeypatch.setattr(github_client, "build_client", lambda _token, **_kwargs: _Client())
    monkeypatch.setattr(writers, "resolve_writers", resolve)
    monkeypatch.setattr(merge_authz, "resolve_merge_rules", _unexpected_merge_rules_read)
    assert scan.review.call_args.kwargs["entry"] == writer_entry
    assert scan.review.call_args.kwargs["resolve_merge_rules"]() == _SNAPSHOT
    assert roles == [minimum_role]
    assert f"eligibility#pytorch/vision#write_permission#{minimum_role}" in scan.store.items


def test_a_pr_recheck_gets_no_memory(make_config):
    scan = _Scan(_MISSING)

    scan.run(make_config, TARGET_REPO, pr=5)

    assert scan.review.call_args.kwargs["memory"] is None
    assert scan.review.call_args.kwargs["pr"] == 5
    assert scan.store.read_repo(TARGET_REPO).memory is None
    assert scan.store.read_repo(TARGET_REPO).config.kind == "absent"


def test_the_primary_with_no_file_is_served_under_the_builtin_with_no_problem(make_config):
    scan = _Scan(_MISSING)

    scan.run(make_config, TARGET_REPO)

    assert scan.review.call_args.kwargs["entry"] == BUILTIN_PYTORCH
    assert scan.review.call_args.kwargs["optional"] is True


def test_an_invalid_primary_file_runs_only_its_safety_work_then_fails(make_config):
    scan = _Scan(_content("mode: paused\n"))

    with pytest.raises(RuntimeError, match=r"pytorch/pytorch: invalid config, safety-only under the built-in entry"):
        scan.run(make_config, TARGET_REPO)

    assert scan.review.call_args.kwargs["optional"] is False
    assert scan.review.call_args.kwargs["entry"] == BUILTIN_PYTORCH


def test_a_safety_only_gate_repo_gets_its_backing_check_alone_forgets_its_drain_and_fails(make_config):
    scan = _Scan(_file(extra="1"))
    seeded = ScanMemory()
    seeded.off_since(datetime(2026, 1, 1))
    scan.seed("pytorch/vision", seeded)

    with pytest.raises(RuntimeError, match=r"^pytorch/vision: safety-only: unknown key\(s\) \['extra'\]$"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()
    scan.drain.assert_not_called()
    assert scan.backing.call_args.kwargs["entry"] == _VISION
    saved = scan.memory("pytorch/vision")
    assert saved is not None
    assert saved.off_since(datetime(2026, 2, 2)) == datetime(2026, 2, 2)


def test_a_recheck_of_a_safety_only_gate_repo_does_nothing(make_config, caplog):
    scan = _Scan(_file(extra="1"))

    with caplog.at_level(logging.WARNING, logger="greenlight"), pytest.raises(RuntimeError, match="safety-only"):
        scan.run(make_config, "pytorch/vision", pr=3)

    scan.review.assert_not_called()
    scan.backing.assert_not_called()
    assert "pytorch/vision: a safety-only gate entry is not reviewed: --pr does nothing" in caplog.text


def test_a_gate_repo_runs_its_backing_check_on_its_stored_memory_before_the_review_and_reports_its_errors(
    make_config,
):
    report = _backing_report(_NOT_ENFORCED, errors=("sweep 1 incomplete after 15 minutes: 2 PRs unread",))
    scan = _Scan(_file(), backing=report)
    seeded = ScanMemory()
    seeded.backing.waiting = frozenset({4})
    scan.seed("pytorch/vision", seeded)
    order: list[str] = []

    def backing(*_args: object, **kwargs: Any) -> approval_backing.BackingReport:
        order.append("backing")
        assert kwargs["memory"].backing.waiting == frozenset({4})
        kwargs["memory"].backing.waiting = frozenset({5})
        return report

    scan.backing.side_effect = backing
    scan.review.side_effect = lambda *_args, **_kwargs: order.append("review")

    with pytest.raises(RuntimeError, match=r"^pytorch/vision: sweep 1 incomplete after 15 minutes: 2 PRs unread$"):
        scan.run(make_config, "pytorch/vision")

    assert order == ["backing", "review"]
    args, kwargs = scan.backing.call_args
    assert args[0].github_token == _TOKEN
    assert kwargs["entry"] == _VISION
    assert kwargs["memory"] is scan.review.call_args.kwargs["memory"]
    assert kwargs["bot_login"] == "bot[bot]"
    assert kwargs["build_github"] == scan._build
    saved = scan.memory("pytorch/vision")
    assert saved is not None
    assert saved.backing.waiting == frozenset({5})


@pytest.fixture
def _vision_may_be_active(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(repo_config, "GATE_ACTIVE_REPOS", frozenset({"pytorch/vision"}))


@pytest.mark.usefixtures("_vision_may_be_active")
@pytest.mark.parametrize(
    ("report", "reason"),
    [
        pytest.param(_backing_report(None, errors=("rules: boom",)), "the rules could not be read", id="unknown"),
        pytest.param(_backing_report(_NOT_ENFORCED), "GreenLight's gate is not enforced on pytorch/vision", id="off"),
    ],
)
def test_an_active_gate_repo_without_enforced_rules_is_not_reviewed(make_config, report, reason):
    scan = _Scan(_file(mode="active"), backing=report)

    with pytest.raises(RuntimeError, match=f"no dispatch this run: {reason}"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()


@pytest.mark.usefixtures("_vision_may_be_active")
def test_an_active_gate_repo_with_enforced_rules_is_reviewed(make_config):
    scan = _Scan(_file(mode="active"))

    scan.run(make_config, "pytorch/vision")

    assert scan.backing.call_args.kwargs["entry"] == _ACTIVE
    assert scan.review.call_args.kwargs["entry"] == _ACTIVE


@pytest.mark.usefixtures("_vision_may_be_active")
def test_a_recheck_of_a_gate_repo_runs_no_backing_check(make_config):
    scan = _Scan(_file(mode="active"), backing=_backing_report(None))

    scan.run(make_config, "pytorch/vision", pr=4)

    scan.backing.assert_not_called()
    assert scan.review.call_args.kwargs["pr"] == 4


@pytest.mark.parametrize(
    ("repo", "contents"),
    [
        pytest.param(TARGET_REPO, _MISSING, id="pytorchbot"),
        pytest.param("pytorch/vision", _file(mode="off"), id="gate-off"),
    ],
)
def test_a_repo_that_does_not_back_approvals_forgets_the_backing_memory_and_runs_no_check(make_config, repo, contents):
    scan = _Scan(contents)
    seeded = ScanMemory()
    seeded.backing.waiting = frozenset({4})
    scan.seed(repo, seeded)

    scan.run(make_config, repo)

    scan.backing.assert_not_called()
    saved = scan.memory(repo)
    assert saved is not None
    assert saved.backing.waiting == frozenset()


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


@pytest.mark.parametrize(
    ("identity", "problem"),
    [
        pytest.param(_identity("pytorch/vision", private=True), "it is private", id="private"),
        pytest.param(_identity("pytorch/vision", archived=True), "it is archived", id="archived"),
    ],
)
def test_a_private_or_archived_repo_is_refused_before_its_config_is_read(make_config, identity, problem):
    scan = _Scan(AssertionError("the config was read"), identity=identity)

    with pytest.raises(RuntimeError, match=f"^pytorch/vision: refused for this scan: {problem}$"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()
    assert [client.urls for client in scan.clients] == [["/repos/pytorch/vision"]]
    assert scan.store.read_repo("pytorch/vision").config.kind is None
    assert all(client.closed == 1 for client in scan.clients)


@pytest.mark.parametrize(
    ("identity", "problem"),
    [
        pytest.param(_identity("pytorch/Vision"), "GitHub names it 'pytorch/Vision'", id="name"),
        pytest.param(_identity("pytorch/vision", branch="master"), "its default branch is 'master'", id="branch"),
    ],
)
def test_a_repo_failing_a_live_check_after_its_config_gets_no_work_and_fails(make_config, identity, problem):
    scan = _Scan(_file(), identity=identity)

    with pytest.raises(RuntimeError, match=f"refused for this scan: {problem}"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()
    assert all(client.closed == 1 for client in scan.clients)


def test_a_live_check_failure_also_reports_the_settings_problem(make_config):
    scan = _Scan(_file(extra="1"), identity=_identity("pytorch/vision", branch="master"))

    with pytest.raises(RuntimeError, match=r"safety-only: unknown key.*; refused for this scan: its default branch"):
        scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()


def test_an_off_repo_drains_with_its_memory_instead_of_reviewing(make_config):
    scan = _Scan(_file(mode="off"))

    scan.run(make_config, "pytorch/vision")

    scan.review.assert_not_called()
    kwargs = scan.drain.call_args.kwargs
    assert kwargs["repo"] == "pytorch/vision"
    assert isinstance(kwargs["memory"], ScanMemory)
    assert kwargs["bot_login"] == "bot[bot]"
    assert scan.memory("pytorch/vision") is not None


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
    scan = _Scan(_content(f"mode: {mode}\n"))
    scan.run(make_config, TARGET_REPO)
    scan.contents = GithubException(502)

    with pytest.raises(RuntimeError, match="config unreadable, serving the last file read: GithubException"):
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
    scan.clock[0] += CONFIG_ABSENT_TTL.total_seconds()

    with pytest.raises(RuntimeError, match="serving the last file read"):
        scan.run(make_config, TARGET_REPO)

    assert scan.review.call_args.kwargs["entry"] == BUILTIN_PYTORCH
    assert scan.review.call_args.kwargs["optional"] is True


def test_a_warm_invalid_primary_stays_safety_only_on_an_unreadable_read(make_config):
    scan = _Scan(_content("mode: paused\n"))
    with pytest.raises(RuntimeError, match="invalid config"):
        scan.run(make_config, TARGET_REPO)
    scan.contents = GithubException(502)

    with pytest.raises(RuntimeError, match="serving the last file read"):
        scan.run(make_config, TARGET_REPO)

    assert scan.review.call_args.kwargs["optional"] is False


def test_a_warm_other_repo_keeps_its_settings_on_an_unreadable_read(make_config):
    scan = _Scan(_file())
    scan.run(make_config, "pytorch/vision")
    scan.contents = GithubException(502)

    with pytest.raises(RuntimeError, match="pytorch/vision: config unreadable, serving the last file read"):
        scan.run(make_config, "pytorch/vision")

    assert scan.review.call_count == 2
    assert scan.review.call_args.kwargs["entry"] == _VISION
    assert scan.store.read_repo("pytorch/vision").config.text is not None


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


@pytest.mark.parametrize(("dispatch_token", "expected"), [(None, _TOKEN), ("dispatch", "dispatch")])
def test_the_config_is_read_with_the_scan_token_and_the_dispatch_uses_the_dispatch_token(
    make_config, dispatch_token, expected
):
    scan = _Scan(_MISSING)

    scan.run(make_config, TARGET_REPO, dispatch_token=dispatch_token)

    assert scan.tokens == [_TOKEN]
    assert scan.review.call_args.kwargs["dispatch_token"] == expected


def test_an_off_repos_drain_reads_the_review_runs_with_the_dispatch_token(make_config):
    scan = _Scan(_file(mode="off"))

    scan.run(make_config, "pytorch/vision", dispatch_token="dispatch")

    assert scan.drain.call_args.kwargs["dispatch_token"] == "dispatch"
    assert scan.drain.call_args.args[0].github_token == _TOKEN


def test_drain_error_names_the_failed_prs_only_when_there_are_some():
    assert repo_scan.drain_error(drain.DrainReport(1, 2, 0, False, "x", ())) is None
    assert repo_scan.drain_error(drain.DrainReport(1, 2, 0, False, "x", (3, 5))) == (
        "the drain failed on 2 PR(s): [3, 5]"
    )
