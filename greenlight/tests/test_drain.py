from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import pytest
from github import RateLimitExceededException

from greenlight import drain
from greenlight.constants import DISPATCH_REPO, FINGERPRINT_QUIET, WORKFLOW_FILE
from greenlight.guards import IterationTimeout
from greenlight.scan_memory import ScanMemory
from greenlight.state import PRState

_REPO = "pytorch/vision"
_BOT = "greenlight-app[bot]"
_TOKEN = "t"
_NOW = datetime(2026, 11, 16, 12, 0, 0)
_OLD = _NOW - timedelta(hours=1)


@dataclass
class _Pull:
    number: int
    updated_at: datetime | None = _OLD


class _Client:
    def __init__(self, token: str = _TOKEN) -> None:
        self.token = token
        self.closed = 0

    def close(self) -> None:
        self.closed += 1


def _state(number: int) -> PRState:
    return PRState(pr_number=number, status="LAND", eval_hash="a" * 64, head_sha="h", version=_NOW, run_id=1)


class _Drain:
    def __init__(
        self,
        pulls: list[_Pull],
        *,
        recorded: frozenset[int] = frozenset(),
        approvals: dict[int, int] | None = None,
        errors: dict[int, BaseException] | None = None,
        unfinished: int = 0,
        memory: ScanMemory | None = None,
    ) -> None:
        self.pulls = pulls
        self.recorded = recorded
        self.approvals = approvals or {}
        self.errors = errors or {}
        self.unfinished = unfinished
        self.memory = memory or ScanMemory()
        self.read: list[int] = []
        self.runs_before: list[datetime] = []
        self.runs_clients: list[_Client] = []
        self.clients: list[_Client] = []
        self.clock = _NOW

    def _build(self, token: str) -> Any:
        client = _Client(token)
        self.clients.append(client)
        return client

    def _dismiss(self, pr: _Pull, *, bot_login: str, message: str) -> list[int]:
        assert bot_login == _BOT
        assert "off" in message
        self.read.append(pr.number)
        error = self.errors.get(pr.number)
        if error is not None:
            raise error
        return list(range(self.approvals.get(pr.number, 0)))

    def _runs(self, client: Any, before: datetime) -> int:
        self.runs_before.append(before)
        self.runs_clients.append(client)
        return self.unfinished

    def tick(
        self,
        make_config: Any,
        *,
        bot_login: str = _BOT,
        token: str | None = _TOKEN,
        cancel_event: threading.Event | None = None,
        dispatch_token: str | None = None,
    ) -> drain.DrainReport:
        return drain.drain(
            make_config(github_token=token),
            repo=_REPO,
            memory=self.memory,
            bot_login=bot_login,
            build_github=self._build,
            list_prs=lambda _client, repo: list(self.pulls) if repo == _REPO else [],  # type: ignore[arg-type]
            read_states=lambda repo, numbers: {n: _state(n) for n in numbers if n in self.recorded and repo == _REPO},
            unfinished_runs=self._runs,
            dismiss=self._dismiss,
            now=lambda: self.clock,
            cancel_event=cancel_event,
            dispatch_token=dispatch_token,
        )


def test_a_clean_whole_pass_with_no_older_runs_completes_the_drain(make_config, caplog):
    run = _Drain([_Pull(3), _Pull(1), _Pull(2)], recorded=frozenset({3}))

    with caplog.at_level(logging.INFO, logger="greenlight"):
        report = run.tick(make_config)

    assert run.read == [3, 1, 2]
    assert report == drain.DrainReport(1, 3, 0, True, "", ())
    assert f"{_REPO}: drain complete (pass 1, checked 3)" in caplog.text
    assert run.memory.drain_pass() is None
    assert run.runs_before == [_NOW]
    assert [client.closed for client in run.clients] == [1]


def test_the_slice_is_bounded_and_the_next_tick_resumes_at_the_cursor(make_config, monkeypatch, caplog):
    monkeypatch.setattr(drain, "DRAIN_PRS_PER_TICK", 2)
    run = _Drain([_Pull(n) for n in (5, 4, 3, 2, 1)], recorded=frozenset({4, 2}))

    with caplog.at_level(logging.INFO, logger="greenlight"):
        first = run.tick(make_config)
    assert run.read == [2, 4]
    assert (first.complete, first.reason, first.checked) == (False, "the pass continues next tick", 2)
    assert "pass 1, checked 2, dismissed 0, not complete: the pass continues next tick" in caplog.text

    run.pulls.append(_Pull(6))
    second = run.tick(make_config)
    assert run.read == [2, 4, 1, 3]
    assert second.pass_number == 1

    third = run.tick(make_config)
    assert run.read == [2, 4, 1, 3, 5, 6]
    assert (third.complete, third.checked) == (True, 6)
    assert run.runs_before == [_NOW]


def test_once_complete_no_pass_starts_until_the_repo_leaves_off(make_config, caplog):
    run = _Drain([_Pull(1), _Pull(2)])
    run.tick(make_config)
    run.approvals = {2: 1}

    with caplog.at_level(logging.INFO, logger="greenlight"):
        again = run.tick(make_config)

    assert again == drain.DrainReport(1, 0, 0, True, "", ())
    assert f"{_REPO}: drain complete (pass 1); nothing to do while the repo stays off" in caplog.text
    assert run.read == [1, 2]
    assert len(run.clients) == 1
    assert run.memory.drain_completed_by() == 1

    run.memory.clear_drain()
    report = run.tick(make_config)
    assert (report.pass_number, report.dismissed, report.complete) == (2, 1, False)
    assert run.read == [1, 2, 1, 2]


def test_a_pass_that_dismissed_an_approval_does_not_complete_and_the_next_pass_starts_over(make_config):
    run = _Drain([_Pull(1), _Pull(2)], approvals={2: 1})

    first = run.tick(make_config)
    assert (first.complete, first.dismissed, first.reason) == (False, 1, "the pass dismissed 1 approval(s)")

    run.approvals = {}
    second = run.tick(make_config)
    assert (second.pass_number, second.complete) == (2, True)
    assert run.read == [1, 2, 1, 2]


def test_a_pass_that_started_while_older_runs_were_unfinished_cannot_complete(make_config):
    run = _Drain([_Pull(1)], unfinished=2)

    report = run.tick(make_config)

    assert not report.complete
    assert report.reason.startswith(f"2 {WORKFLOW_FILE} run(s) created before the repo went off")


def test_off_since_is_kept_across_ticks_and_bounds_the_run_check(make_config):
    run = _Drain([_Pull(1)], unfinished=1)
    run.tick(make_config)
    run.clock = _NOW + timedelta(minutes=10)
    run.unfinished = 0
    report = run.tick(make_config)

    assert run.runs_before == [_NOW, _NOW]
    assert report.complete


def test_a_failed_pr_is_reported_and_the_pass_cannot_complete(make_config, caplog):
    run = _Drain([_Pull(1), _Pull(2)], errors={1: RuntimeError("boom")})

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        report = run.tick(make_config)

    assert report.failed == (1,)
    assert (report.complete, report.reason) == (False, "the pass failed on 1 PR(s)")
    assert run.read == [1, 2]
    assert f"failed to revoke greenlight approval on PR #1, in {_REPO}, which is off" in caplog.text


def test_a_rate_limit_stops_the_slice(make_config):
    run = _Drain([_Pull(1), _Pull(2), _Pull(3)], errors={1: RateLimitExceededException(403)})

    report = run.tick(make_config)

    assert run.read == [1]
    assert report.failed == (1,)
    assert report.reason == "the pass continues next tick"


def test_a_rate_limit_sets_the_runs_cancel_event(make_config):
    cancel_event = threading.Event()
    run = _Drain([_Pull(1), _Pull(2)], errors={1: RateLimitExceededException(403)})

    run.tick(make_config, cancel_event=cancel_event)

    assert cancel_event.is_set()
    assert run.read == [1]


def test_a_cancel_event_already_set_reads_no_pr_and_the_pass_continues_next_tick(make_config):
    cancel_event = threading.Event()
    cancel_event.set()
    run = _Drain([_Pull(1), _Pull(2)])

    report = run.tick(make_config, cancel_event=cancel_event)

    assert run.read == []
    assert (report.complete, report.reason) == (False, "the pass continues next tick")
    assert run.memory.drain_pass() is not None


def test_an_iteration_timeout_propagates(make_config):
    run = _Drain([_Pull(1)], errors={1: IterationTimeout("late")})

    with pytest.raises(IterationTimeout):
        run.tick(make_config)
    assert [client.closed for client in run.clients] == [1]


def test_a_clean_pr_is_skipped_while_its_updated_at_is_unchanged(make_config):
    run = _Drain([_Pull(1), _Pull(2), _Pull(3)])
    current = run.memory.start_drain_pass(None)
    current.clean[2] = _OLD
    current.clean[3] = _OLD - timedelta(seconds=1)

    report = run.tick(make_config)

    assert run.read == [1, 3]
    assert report.complete


def test_only_a_quiet_clean_pr_is_remembered(make_config, monkeypatch):
    monkeypatch.setattr(drain, "DRAIN_PRS_PER_TICK", 2)
    young = _NOW - FINGERPRINT_QUIET + timedelta(seconds=1)
    run = _Drain([_Pull(1), _Pull(2, young), _Pull(3, None)])

    run.tick(make_config)

    current = run.memory.drain_pass()
    assert current is not None
    assert current.clean == {1: _OLD}


def test_an_empty_repo_completes_without_a_bot_login(make_config):
    assert _Drain([]).tick(make_config, bot_login="").complete


def test_a_drain_with_prs_needs_the_app_bot_login(make_config):
    with pytest.raises(ValueError, match="BOT_LOGIN must be the greenlight App login"):
        _Drain([_Pull(1)]).tick(make_config, bot_login="")


def test_a_drain_needs_a_token(make_config):
    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        _Drain([]).tick(make_config, token=None)


class _Runs:
    def __init__(self, count: int) -> None:
        self.totalCount = count


class _Workflow:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def get_runs(self, *, status: str, created: str) -> _Runs:
        self.calls.append((status, created))
        return _Runs(1 if status == "waiting" else 0)


class _Repo:
    def __init__(self) -> None:
        self.workflow = _Workflow()
        self.workflows: list[str] = []
        self.pulls_args: list[str] = []

    def get_workflow(self, name: str) -> _Workflow:
        self.workflows.append(name)
        return self.workflow

    def get_pulls(self, *, state: str) -> list[_Pull]:
        self.pulls_args.append(state)
        return [_Pull(1)]


class _RepoClient:
    def __init__(self) -> None:
        self.repo = _Repo()
        self.names: list[str] = []

    def get_repo(self, name: str) -> _Repo:
        self.names.append(name)
        return self.repo


def test_count_unfinished_review_runs_reads_every_unfinished_status_created_before_the_switch():
    client = _RepoClient()

    count = drain.count_unfinished_review_runs(client, _NOW)  # type: ignore[arg-type]

    assert count == 1
    assert client.names == [DISPATCH_REPO]
    assert client.repo.workflows == [WORKFLOW_FILE]
    created = "<2026-11-16T12:00:00+00:00"
    assert client.repo.workflow.calls == [
        (status, created) for status in ("queued", "in_progress", "waiting", "pending", "requested")
    ]


def test_list_open_pulls_lists_every_open_pr():
    client = _RepoClient()

    assert drain.list_open_pulls(client, _REPO) == [_Pull(1)]  # type: ignore[arg-type]
    assert client.names == [_REPO]
    assert client.repo.pulls_args == ["open"]


def test_a_pr_recorded_after_the_pass_started_is_still_reached(make_config, monkeypatch):
    monkeypatch.setattr(drain, "DRAIN_PRS_PER_TICK", 2)
    run = _Drain([_Pull(n) for n in (1, 2, 3)], recorded=frozenset({3}))

    run.tick(make_config)
    assert run.read == [3, 1]

    run.recorded = frozenset({2, 3})
    report = run.tick(make_config)

    assert run.read == [3, 1, 2]
    assert report.complete
    assert report.checked == 3


def test_the_ledger_is_read_once_per_pass(make_config, monkeypatch):
    monkeypatch.setattr(drain, "DRAIN_PRS_PER_TICK", 1)
    reads: list[list[int]] = []
    run = _Drain([_Pull(1), _Pull(2)], recorded=frozenset({2}))

    def read_states(_repo: str, numbers: Any) -> dict[int, PRState]:
        reads.append(list(numbers))
        return {2: _state(2)}

    def counting_tick(config_factory: Any) -> drain.DrainReport:
        return drain.drain(
            config_factory(github_token=_TOKEN),
            repo=_REPO,
            memory=run.memory,
            bot_login=_BOT,
            build_github=run._build,
            list_prs=lambda _client, _repo: list(run.pulls),  # type: ignore[arg-type]
            read_states=read_states,
            unfinished_runs=run._runs,
            dismiss=run._dismiss,
            now=lambda: run.clock,
        )

    counting_tick(make_config)
    counting_tick(make_config)

    assert reads == [[1, 2]]
    assert run.read == [2, 1]


def test_the_older_runs_are_read_through_a_client_on_the_dispatch_token(make_config):
    run = _Drain([_Pull(1)])

    run.tick(make_config, dispatch_token="dispatch")

    [runs_client] = run.runs_clients
    assert runs_client.token == "dispatch"
    assert runs_client.closed == 1
    assert [client.token for client in run.clients] == [_TOKEN, "dispatch"]
    assert all(client.closed == 1 for client in run.clients)


@pytest.mark.parametrize("dispatch_token", [None, _TOKEN])
def test_the_older_runs_reuse_the_scan_client_when_there_is_no_other_dispatch_token(make_config, dispatch_token):
    run = _Drain([_Pull(1)])

    run.tick(make_config, dispatch_token=dispatch_token)

    assert run.runs_clients == run.clients
    assert len(run.clients) == 1


def test_the_dispatch_client_is_closed_when_the_runs_read_fails(make_config):
    run = _Drain([_Pull(1)])

    def broken(_client: Any, _before: datetime) -> int:
        raise RuntimeError("runs down")

    run._runs = broken  # type: ignore[method-assign,assignment]

    with pytest.raises(RuntimeError, match="runs down"):
        run.tick(make_config, dispatch_token="dispatch")

    assert [client.closed for client in run.clients] == [1, 1]
