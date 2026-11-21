"""``greenlight gate-check``: the merge gate's polling check (``gate_check``)."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, cast
from unittest.mock import Mock

import pytest
from github import GithubException

from greenlight import cli, gate_check
from greenlight.approvals import GREENLIGHT_LOGIN, ReviewReader
from greenlight.constants import (
    GATE_POLL_DELAYS,
    GATE_SUPERSEDED_AFTER,
    GATE_SUPERSEDED_RECHECK,
    GATE_TIMEOUT_MINUTES_DEFAULT,
)
from greenlight.exit_codes import EXIT_FAILURE, EXIT_OK

if TYPE_CHECKING:
    from github import Github

REPO = "pytorch/vision"
PR = 7
HEAD = "a" * 40
OLD = "b" * 40
NEW = "c" * 40
_PULL = f"/repos/{REPO}/pulls/{PR}"
_REVIEWS = f"{_PULL}/reviews"


def _pull(state: str = "open", head: str = HEAD) -> dict[str, Any]:
    return {"number": PR, "state": state, "head": {"sha": head}, "base": {"ref": "main", "repo": None}}


def _approval(commit: str, state: str = "APPROVED") -> dict[str, Any]:
    return {"id": 1, "user": {"login": GREENLIGHT_LOGIN, "type": "Bot"}, "state": state, "commit_id": commit}


class _ScriptedRequester:
    """Answers each URL from its own queue; the last answer repeats. An exception in a queue is raised."""

    def __init__(self, pulls: list[Any], reviews: list[Any]) -> None:
        self._queues = {_PULL: pulls, _REVIEWS: reviews}
        self.urls: list[str] = []

    def requestJsonAndCheck(
        self,
        verb: str,
        url: str,
        parameters: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        input: Any | None = None,
    ) -> tuple[dict[str, Any], Any]:
        self.urls.append(url)
        queue = self._queues[url]
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, Exception):
            raise answer
        return {}, answer


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds

    def monotonic(self) -> float:
        return self.now


def _target(timeout_minutes: int = GATE_TIMEOUT_MINUTES_DEFAULT) -> gate_check.GateTarget:
    return gate_check.GateTarget(repo=REPO, pr=PR, head_sha=HEAD, timeout_minutes=timeout_minutes)


def _wait(requester: _ScriptedRequester, clock: _Clock, timeout_minutes: int = GATE_TIMEOUT_MINUTES_DEFAULT) -> int:
    return gate_check.wait_for_gate(
        ReviewReader(requester), _target(timeout_minutes), sleep=clock.sleep, monotonic=clock.monotonic
    )


def test_passes_at_once_without_a_greenlight_approval(caplog):
    clock = _Clock()

    with caplog.at_level(logging.INFO, logger="greenlight"):
        assert _wait(_ScriptedRequester([_pull()], [[]]), clock) == EXIT_OK

    assert clock.sleeps == []
    assert "gate passes" in caplog.text


def test_passes_when_the_approval_is_on_the_head():
    clock = _Clock()

    assert _wait(_ScriptedRequester([_pull()], [[_approval(HEAD)]]), clock) == EXIT_OK
    assert clock.sleeps == []


def test_holds_then_passes_once_the_stale_approval_is_dismissed(caplog):
    clock = _Clock()
    requester = _ScriptedRequester([_pull()], [[_approval(OLD)], [_approval(OLD, "DISMISSED")]])

    with caplog.at_level(logging.INFO, logger="greenlight"):
        assert _wait(requester, clock) == EXIT_OK

    assert clock.sleeps == [GATE_POLL_DELAYS[0]]
    assert f"gate holds for {REPO}#{PR}" in caplog.text
    assert OLD in caplog.text


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(RuntimeError("connection reset"), id="read-failure"),
        pytest.param(GithubException(403, {"message": "x"}, {"x-ratelimit-remaining": "0"}), id="rate-limit"),
        pytest.param(None, id="bad-payload"),
    ],
)
def test_a_failed_check_is_a_hold(error: Exception | None, caplog: pytest.LogCaptureFixture) -> None:
    clock = _Clock()
    requester = _ScriptedRequester([error if error is not None else {"state": "open"}, _pull()], [[]])

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        assert _wait(requester, clock) == EXIT_OK

    assert clock.sleeps == [GATE_POLL_DELAYS[0]]
    assert any(r.exc_info for r in caplog.records if "holding" in r.getMessage())


def test_a_failed_review_read_is_a_hold():
    clock = _Clock()
    requester = _ScriptedRequester([_pull()], [RuntimeError("502"), [_approval(OLD)], []])

    assert _wait(requester, clock) == EXIT_OK
    assert clock.sleeps == list(GATE_POLL_DELAYS[:2])


def test_times_out_naming_the_standing_approval(caplog):
    clock = _Clock()
    requester = _ScriptedRequester([_pull()], [[_approval(OLD)]])

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        assert _wait(requester, clock, timeout_minutes=10) == EXIT_FAILURE

    assert clock.sleeps == [60, 120, 240, 180]
    assert clock.now == 1000.0 + 600
    assert requester.urls.count(_REVIEWS) == 5
    assert "after 10 minutes" in caplog.text
    assert OLD in caplog.text


def test_the_delays_repeat_the_last_one_until_the_deadline():
    clock = _Clock()

    assert _wait(_ScriptedRequester([_pull()], [[_approval(OLD)]]), clock, timeout_minutes=25) == EXIT_FAILURE

    assert clock.sleeps == [60, 120, 240, 300, 300, 300, 180]
    assert sum(clock.sleeps) == 25 * 60


def test_times_out_after_a_failed_last_check(caplog):
    clock = _Clock()

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        assert _wait(_ScriptedRequester([RuntimeError("down")], [[]]), clock, timeout_minutes=1) == EXIT_FAILURE

    assert clock.sleeps == [60]
    assert "the last check failed" in caplog.text


def test_a_closed_pr_is_superseded_once_its_recheck_still_reads_it_closed(caplog: pytest.LogCaptureFixture) -> None:
    clock = _Clock()
    requester = _ScriptedRequester([_pull(state="closed")], [[_approval(OLD)]])

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        assert _wait(requester, clock) == EXIT_FAILURE

    assert clock.sleeps == [GATE_SUPERSEDED_RECHECK]
    assert requester.urls == [_PULL, _PULL]
    assert f"superseded: {REPO}#{PR} is closed at head {HEAD}" in caplog.text


def test_a_closed_read_that_rechecks_open_on_the_head_goes_on_to_the_reviews():
    clock = _Clock()
    requester = _ScriptedRequester([_pull(state="closed"), _pull()], [[]])

    assert _wait(requester, clock) == EXIT_OK
    assert clock.sleeps == [GATE_SUPERSEDED_RECHECK]
    assert requester.urls == [_PULL, _PULL, _REVIEWS]


def test_the_closed_recheck_never_waits_past_the_deadline():
    clock = _Clock()
    requester = _ScriptedRequester([_pull(), _pull(state="closed")], [[_approval(OLD)]])

    assert _wait(requester, clock, timeout_minutes=1) == EXIT_FAILURE
    assert clock.sleeps == [60, 0]
    assert clock.now == 1000.0 + 60


def test_reads_that_lag_the_push_hold_until_the_head_appears(caplog: pytest.LogCaptureFixture) -> None:
    clock = _Clock()
    requester = _ScriptedRequester([_pull(head=OLD), _pull(head=OLD), _pull()], [[]])

    with caplog.at_level(logging.INFO, logger="greenlight"):
        assert _wait(requester, clock) == EXIT_OK

    assert clock.sleeps == list(GATE_POLL_DELAYS[:2])
    assert requester.urls == [_PULL, _PULL, _PULL, _REVIEWS]
    assert f"gate holds for {REPO}#{PR}: it reads at head {OLD}, not {HEAD}" in caplog.text
    assert "superseded" not in caplog.text


def test_a_pr_that_stays_on_another_head_is_superseded_once_every_read_found_it_there(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = _Clock()
    requester = _ScriptedRequester([_pull(head=NEW)], [[_approval(OLD)]])

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        assert _wait(requester, clock) == EXIT_FAILURE

    # Reads at 0, 60, 180 and 420 s: the last is the first at least GATE_SUPERSEDED_AFTER after the first.
    assert clock.sleeps == [60, 120, 240]
    assert sum(clock.sleeps[:-1]) < GATE_SUPERSEDED_AFTER <= sum(clock.sleeps)
    assert requester.urls == [_PULL] * 4
    assert f"superseded: {REPO}#{PR} is open at head {NEW}, not open at {HEAD}" in caplog.text


def test_a_read_on_the_head_starts_the_wait_for_a_moved_head_over():
    clock = _Clock()
    requester = _ScriptedRequester([_pull(head=NEW), _pull(head=NEW), _pull(), _pull(head=NEW)], [[_approval(OLD)]])

    assert _wait(requester, clock) == EXIT_FAILURE

    # Moved at 0 and 60 s, on the head at 180 s, then moved from 420 s: superseded at 720 s, not at 420 s.
    assert clock.sleeps == [60, 120, 240, 300]
    assert requester.urls.count(_REVIEWS) == 1


def test_a_failed_read_neither_ends_nor_restarts_the_wait_for_a_moved_head():
    clock = _Clock()
    requester = _ScriptedRequester([_pull(head=NEW), RuntimeError("502"), _pull(head=NEW)], [[]])

    assert _wait(requester, clock) == EXIT_FAILURE
    assert clock.sleeps == [60, 120, 240]


def test_a_read_on_the_head_starts_the_wait_over_even_when_its_reviews_cannot_be_read():
    clock = _Clock()
    requester = _ScriptedRequester(
        [_pull(head=NEW), _pull(), _pull(head=NEW), _pull(head=NEW), _pull()],
        [RuntimeError("502"), []],
    )

    assert _wait(requester, clock) == EXIT_OK

    # Moved at 0 s, on the head at 60 s with a failed reviews read, moved at 180 and 420 s (240 s after the
    # wait restarted), then on the head with no approval at 720 s: it passes instead of being superseded.
    assert clock.sleeps == [60, 120, 240, 300]


def test_a_moved_head_at_the_deadline_times_out_naming_it(caplog: pytest.LogCaptureFixture) -> None:
    clock = _Clock()

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        assert _wait(_ScriptedRequester([_pull(head=NEW)], [[]]), clock, timeout_minutes=2) == EXIT_FAILURE

    assert clock.sleeps == [60, 60]
    assert f"after 2 minutes: it reads at head {NEW}, not {HEAD}" in caplog.text


def test_head_comparison_ignores_case():
    clock = _Clock()

    assert _wait(_ScriptedRequester([_pull(head=HEAD.upper())], [[]]), clock) == EXIT_OK
    assert clock.sleeps == []


def _args(*argv: str) -> Any:
    return cli.build_parser().parse_args(["gate-check", *argv])


def _valid(*extra: str) -> list[str]:
    return ["--repo", REPO, "--pr", str(PR), "--head-sha", HEAD, *extra]


def test_parser_defaults_the_timeout():
    target = gate_check.parse_target(REPO, "7", HEAD, _args(*_valid()).timeout_minutes)

    assert target == _target()


def test_parser_accepts_the_maximum_timeout():
    assert gate_check.parse_target(REPO, "7", HEAD, "340").timeout_minutes == 340


@pytest.mark.parametrize(
    ("repo", "pr", "head", "timeout"),
    [
        pytest.param("pytorch", "7", HEAD, "300", id="repo-without-name"),
        pytest.param("octo/vision", "7", HEAD, "300", id="repo-outside-pytorch"),
        pytest.param("pytorch/..", "7", HEAD, "300", id="repo-dotdot"),
        pytest.param(REPO, "0", HEAD, "300", id="pr-zero"),
        pytest.param(REPO, "-1", HEAD, "300", id="pr-negative"),
        pytest.param(REPO, "7a", HEAD, "300", id="pr-not-a-number"),
        pytest.param(REPO, "7", "abc", "300", id="head-not-a-sha"),
        pytest.param(REPO, "7", HEAD + "0", "300", id="head-too-long"),
        pytest.param(REPO, "7", HEAD, "0", id="timeout-zero"),
        pytest.param(REPO, "7", HEAD, "341", id="timeout-over-max"),
        pytest.param(REPO, "7", HEAD, "1.5", id="timeout-not-an-integer"),
    ],
)
def test_invalid_inputs_fail_at_once(
    repo: str, pr: str, head: str, timeout: str, capsys: pytest.CaptureFixture[str]
) -> None:
    build = Mock()
    args = _args("--repo", repo, "--pr", pr, "--head-sha", head, "--timeout-minutes", timeout)

    assert gate_check.run(args, env={"PYTORCH_GREENLIGHT_GITHUB_TOKEN": "tok"}, build_github=build) == EXIT_FAILURE

    build.assert_not_called()
    assert capsys.readouterr().err.startswith("greenlight gate-check: ")


def test_run_fails_without_a_token(capsys):
    build = Mock()

    assert gate_check.run(_args(*_valid()), env={}, build_github=build) == EXIT_FAILURE

    build.assert_not_called()
    assert "PYTORCH_GREENLIGHT_GITHUB_TOKEN" in capsys.readouterr().err


def test_run_fails_on_a_bad_environment(capsys):
    env = {"PYTORCH_GREENLIGHT_GITHUB_TOKEN": "tok", "PYTORCH_GREENLIGHT_LOG_LEVEL": "loud"}

    assert gate_check.run(_args(*_valid()), env=env, build_github=Mock()) == EXIT_FAILURE
    assert capsys.readouterr().err.startswith("greenlight gate-check: ")


class _Client:
    def __init__(self, requester: _ScriptedRequester) -> None:
        self.requester = requester
        self.closed = False

    def close(self) -> None:
        self.closed = True


@pytest.mark.parametrize(("reviews", "code"), [([], EXIT_OK), ([_approval(OLD)], EXIT_FAILURE)])
def test_run_builds_a_client_on_the_token_and_closes_it(
    reviews: list[Any], code: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure = Mock()
    monkeypatch.setattr(gate_check, "configure_logging", configure)
    client = _Client(_ScriptedRequester([_pull()], [reviews]))
    tokens: list[str] = []

    def build(token: str) -> Github:
        tokens.append(token)
        return cast("Github", client)

    clock = _Clock()
    result = gate_check.run(
        _args(*_valid("--timeout-minutes", "1")),
        env={"PYTORCH_GREENLIGHT_GITHUB_TOKEN": "tok"},
        build_github=build,
        sleep=clock.sleep,
        monotonic=clock.monotonic,
    )

    assert result == code
    assert tokens == ["tok"]
    assert client.closed
    configure.assert_called_once_with("INFO")


def test_cli_dispatches_gate_check(monkeypatch):
    seen: list[Any] = []

    def fake_run(args: Any) -> int:
        seen.append(args)
        return 17

    monkeypatch.setattr(gate_check, "run", fake_run)

    assert cli.main(["gate-check", *_valid()]) == 17
    assert (seen[0].repo, seen[0].pr, seen[0].head_sha) == (REPO, str(PR), HEAD)
