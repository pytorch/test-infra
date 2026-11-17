from __future__ import annotations

import functools
import http.server
import json
import logging
import threading
from typing import TYPE_CHECKING, Any

import github
import pytest
from github import GithubException
from requests.exceptions import RetryError
from urllib3.exceptions import MaxRetryError, ProtocolError
from urllib3.util.retry import Retry

from greenlight import github_client, quota
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator, Sequence

_REPO = "pytorch/vision"


def _meter(phase: quota.Phase = "B", stop: Callable[[], str | None] | None = None) -> quota.RequestMeter:
    meter = quota.TickMeter().meter(_REPO)
    meter.phase = phase
    meter.stop = stop
    return meter


def test_the_tick_makes_one_meter_per_repo_in_the_order_it_made_them():
    tick = quota.TickMeter()

    vision = tick.meter(_REPO)
    pytorch = tick.meter("pytorch/pytorch")

    assert tick.meter(_REPO) is vision
    assert tick.meters == (vision, pytorch)
    assert vision.latch is pytorch.latch is tick.latch


def test_a_meter_counts_per_phase_and_adds_each_request_to_the_tick_total():
    tick = quota.TickMeter()
    vision, pytorch = tick.meter(_REPO), tick.meter("pytorch/pytorch")

    vision.count()
    vision.phase = "B"
    vision.count()
    vision.count()
    pytorch.count()

    assert (vision.requests("A"), vision.requests("B")) == (1, 2)
    assert (pytorch.requests("A"), pytorch.requests("B")) == (1, 0)
    assert tick.total == 4


def test_concurrent_counts_are_all_kept():
    tick = quota.TickMeter()
    meter = tick.meter(_REPO)

    def count_many() -> None:
        for _ in range(1000):
            meter.count()

    workers = [threading.Thread(target=count_many) for _ in range(8)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()

    assert meter.requests("A") == tick.total == 8000


def test_the_token_counts_each_request_and_authorizes_it():
    meter = _meter()
    headers: dict[str, str] = {}

    meter.auth("tok").authentication(headers)

    assert headers == {"Authorization": "token tok"}
    assert meter.requests("B") == 1


def test_the_token_refuses_every_request_once_the_latch_is_set_before_counting_it():
    meter = _meter(stop=lambda: "past its deadline")
    meter.latch.set()

    with pytest.raises(quota.RateLimitStop, match=r"^pytorch/vision: a rate limit stopped this tick's GitHub work$"):
        meter.auth("tok").authentication({})

    assert meter.requests("B") == 0
    assert meter.stopped == quota.RATE_LIMIT


def test_the_token_refuses_a_request_once_the_stop_gives_a_reason_before_counting_it():
    reasons = iter([None, "its request budget of 1 is spent"])
    meter = _meter(stop=lambda: next(reasons))
    token = meter.auth("tok")

    token.authentication({})
    with pytest.raises(quota.RepoBudgetExceeded, match=r"^pytorch/vision: its request budget of 1 is spent$"):
        token.authentication({})

    assert meter.requests("B") == 1
    assert meter.stopped == "its request budget of 1 is spent"
    assert not meter.latch.is_set()


def test_both_stops_are_iteration_timeouts_so_every_per_pr_handler_re_raises_them():
    assert issubclass(quota.RepoBudgetExceeded, IterationTimeout)
    assert issubclass(quota.RateLimitStop, IterationTimeout)


def test_a_metered_retry_copies_every_parameter_of_its_base():
    base = Retry(
        total=4,
        connect=3,
        read=2,
        redirect=1,
        status=5,
        other=6,
        allowed_methods=frozenset({"GET"}),
        status_forcelist=frozenset({502}),
        backoff_factor=0.3,
        backoff_max=7.0,
        raise_on_redirect=False,
        raise_on_status=False,
        respect_retry_after_header=False,
        remove_headers_on_redirect=frozenset({"X-Secret"}),
        backoff_jitter=0.1,
        retry_after_max=9,
    )
    meter = _meter()

    retry = meter.retry(base)

    assert set(quota._RETRY_PARAMETERS) >= {"total", "status_forcelist", "respect_retry_after_header", "history"}
    assert {name: getattr(retry, name) for name in quota._RETRY_PARAMETERS} == {
        name: getattr(base, name) for name in quota._RETRY_PARAMETERS
    }
    assert retry.meter is meter


def test_the_retry_urllib3_builds_next_keeps_the_meter_and_counts_the_attempt():
    meter = _meter()

    retried = meter.retry(Retry(total=2)).increment("GET", "/x", error=ProtocolError("reset"))

    assert isinstance(retried, quota.MeteredRetry)
    assert retried.meter is meter
    assert retried.total == 1
    assert meter.requests("B") == 1


def test_a_stop_ends_retrying_a_connection_error_without_counting():
    meter = _meter(stop=lambda: "past its deadline")

    with pytest.raises(MaxRetryError) as excinfo:
        meter.retry(Retry(total=2)).increment("GET", "/x", error=ProtocolError("reset"))

    assert str(excinfo.value.reason) == "greenlight stopped retrying: past its deadline"
    assert meter.requests("B") == 0
    assert meter.stopped == "past its deadline"


def test_a_set_latch_ends_retrying_without_counting():
    meter = _meter()
    meter.latch.set()

    with pytest.raises(MaxRetryError) as excinfo:
        meter.retry(Retry(total=2)).increment("GET", "/x", error=ProtocolError("reset"))

    assert str(excinfo.value.reason) == "greenlight stopped retrying: rate limit"
    assert meter.requests("B") == 0


class _Server:
    """A local GitHub stand-in answering each request with the next scripted status and headers, then 200."""

    def __init__(self, script: Sequence[tuple[int, dict[str, str]]]) -> None:
        self.script = list(script)
        self.hits = 0
        server = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                server.hits += 1
                status, headers = server.script.pop(0) if server.script else (200, {})
                body = json.dumps({"full_name": _REPO}).encode()
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args: object) -> None:
                return None

        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"


@pytest.fixture
def github_at(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[Sequence[tuple[int, dict[str, str]]]], _Server]]:
    """Point every client ``github_client`` builds at a local server, keeping PyGithub, requests and urllib3 real."""
    servers: list[_Server] = []
    real_github = github.Github
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setenv("no_proxy", "127.0.0.1")

    def start(script: Sequence[tuple[int, dict[str, str]]]) -> _Server:
        server = _Server(script)
        threading.Thread(target=server.httpd.serve_forever, daemon=True).start()
        servers.append(server)
        monkeypatch.setattr("github.Github", functools.partial(real_github, base_url=server.url))
        return server

    yield start
    for server in servers:
        server.httpd.shutdown()
        server.httpd.server_close()


@pytest.fixture
def retry_sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Every sleep urllib3 asks a ``Retry`` for, recorded instead of slept."""
    sleeps: list[float] = []

    def record(self: Retry, response: object = None) -> None:
        sleeps.append(self.get_backoff_time())

    monkeypatch.setattr(Retry, "sleep", record)
    return sleeps


def _get(client: github.Github) -> Any:
    return client.requester.requestJsonAndCheck("GET", f"/repos/{_REPO}")[1]


def _fast_client(meter: quota.RequestMeter) -> github.Github:
    return github_client.build_client("tok", seconds_between_requests=0, meter=meter)


def test_server_errors_retried_to_a_success_count_every_attempt(github_at, retry_sleeps):
    server = github_at([(500, {}), (500, {})])
    meter = _meter()

    assert _get(_fast_client(meter))["full_name"] == _REPO

    assert server.hits == 3
    assert meter.requests("B") == meter._tick.total == 3
    assert len(retry_sleeps) == 2


def test_exhausted_retries_count_only_the_attempts_made(github_at, retry_sleeps):
    server = github_at([(500, {}), (500, {}), (500, {})])
    meter = _meter()

    with pytest.raises(RetryError):
        _get(_fast_client(meter))

    assert server.hits == meter.requests("B") == 3


def test_a_429_on_the_patient_client_latches_at_once_and_the_next_request_is_refused(github_at, retry_sleeps, caplog):
    server = github_at([(429, {"Retry-After": "30"})])
    meter = _meter()
    client = github_client.build_authz_client("tok", meter=meter)

    with caplog.at_level(logging.WARNING, logger="greenlight"), pytest.raises(RetryError) as excinfo:
        _get(client)

    assert github_client.is_rate_limit_error(excinfo.value)
    assert server.hits == 1
    assert retry_sleeps == []
    assert meter.latch.is_set()
    assert meter.stopped == quota.RATE_LIMIT
    assert "pytorch/vision: GitHub answered 429, a rate limit" in caplog.text
    with pytest.raises(quota.RateLimitStop) as refused:
        _get(client)
    assert type(refused.value) is quota.RateLimitStop
    assert server.hits == 1


def test_the_fail_fast_client_hands_a_429_back_unretried_for_the_callers_rate_limit_check(github_at, retry_sleeps):
    server = github_at([(429, {})])
    meter = _meter()

    with pytest.raises(GithubException) as excinfo:
        _get(_fast_client(meter))

    assert github_client.is_rate_limit_error(excinfo.value)
    assert server.hits == meter.requests("B") == 1
    assert retry_sleeps == []
    assert not meter.latch.is_set()


def test_a_stop_that_trips_during_a_retry_ends_it_and_the_next_request_raises_the_stop(github_at, retry_sleeps):
    server = github_at([(500, {}), (500, {})])
    meter = _meter(stop=lambda: "past its deadline" if server.hits else None)
    client = _fast_client(meter)

    with pytest.raises(RetryError) as excinfo:
        _get(client)

    assert not github_client.is_rate_limit_error(excinfo.value)
    assert server.hits == meter.requests("B") == 1
    assert retry_sleeps == []
    with pytest.raises(quota.RepoBudgetExceeded) as refused:
        _get(client)
    assert type(refused.value) is quota.RepoBudgetExceeded
    assert str(refused.value) == "pytorch/vision: past its deadline"
    assert server.hits == 1


def test_a_phase_b_request_budget_refuses_the_request_past_it(github_at):
    server = github_at([])
    meter = _meter()
    gauge = quota.QuotaGauge(meter._tick, lambda: (5000, 5000))
    meter.stop = quota.phase_b_stop(meter, gauge=gauge, floor=0, deadline=None, request_budget=2)
    client = _fast_client(meter)

    _get(client)
    _get(client)
    with pytest.raises(quota.RepoBudgetExceeded, match="its request budget of 2 is spent"):
        _get(client)

    assert server.hits == 2


def test_the_gauge_knows_nothing_before_its_first_good_read(caplog):
    def broken() -> tuple[int, int]:
        raise GithubException(500, {"message": "Server Error"})

    gauge = quota.QuotaGauge(quota.TickMeter(), broken)

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        gauge.refresh()

    assert gauge.remaining() is None
    assert gauge.limit is None
    [record] = caplog.records
    assert record.exc_info is not None


def test_the_gauge_subtracts_what_the_tick_counted_since_its_last_read():
    tick = quota.TickMeter()
    meter = tick.meter(_REPO)
    meter.count()
    readings = iter([(4000, 5000), (3000, 5000)])
    gauge = quota.QuotaGauge(tick, lambda: next(readings))

    gauge.refresh()
    for _ in range(3):
        meter.count()
    assert (gauge.remaining(), gauge.limit) == (3997, 5000)

    gauge.refresh()
    tick.meter("pytorch/pytorch").count()
    assert gauge.remaining() == 2999


def test_a_failed_read_keeps_the_last_reading(caplog):
    tick = quota.TickMeter()
    calls = iter([(4000, 5000)])

    def read() -> tuple[int, int]:
        try:
            return next(calls)
        except StopIteration:
            raise ConnectionError("down") from None

    gauge = quota.QuotaGauge(tick, read)
    gauge.refresh()
    tick.add_request()

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        gauge.refresh()

    assert (gauge.remaining(), gauge.limit) == (3999, 5000)
    assert "keeping the last reading" in caplog.text


def test_an_iteration_timeout_during_a_read_propagates():
    def read() -> tuple[int, int]:
        raise quota.RateLimitStop("stopped")

    with pytest.raises(quota.RateLimitStop):
        quota.QuotaGauge(quota.TickMeter(), read).refresh()


def _stop(
    *,
    remaining: int | None = 5000,
    floor: int = 3000,
    deadline: float | None = 100.0,
    request_budget: int | None = 400,
    now: float = 50.0,
    phase_b: int = 0,
    phase_a: int = 0,
) -> str | None:
    tick = quota.TickMeter()
    meter = tick.meter(_REPO)
    for _ in range(phase_a):
        meter.count()
    gauge = quota.QuotaGauge(tick, lambda: (remaining or 0, 5000))
    if remaining is not None:
        gauge.refresh()
    meter.phase = "B"
    for _ in range(phase_b):
        meter.count()
    stop = quota.phase_b_stop(
        meter, gauge=gauge, floor=floor, deadline=deadline, request_budget=request_budget, monotonic=lambda: now
    )
    return stop()


def test_phase_b_goes_on_inside_its_deadline_budget_and_floor():
    assert _stop() is None
    assert _stop(deadline=None, request_budget=None) is None


@pytest.mark.parametrize(
    ("now", "expected"), [(99.9, None), (100.0, "past its deadline"), (150.0, "past its deadline")]
)
def test_phase_b_stops_at_its_deadline(now, expected):
    assert _stop(now=now) == expected


def test_phase_b_stops_once_its_own_phase_b_requests_spend_the_budget():
    assert _stop(request_budget=3, phase_b=2) is None
    assert _stop(request_budget=3, phase_b=3) == "its request budget of 3 is spent"
    assert _stop(request_budget=3, phase_a=10, phase_b=0, remaining=None) is None


def test_phase_b_stops_below_the_floor_and_never_on_an_unknown_estimate():
    assert _stop(remaining=3000, floor=3000) is None
    assert (
        _stop(remaining=3001, floor=3000, phase_b=2)
        == "the installation has 2999 requests left, below the floor of 3000"
    )
    assert _stop(remaining=None, floor=10**9) is None


def test_phase_b_names_the_deadline_first_when_every_stop_applies():
    assert _stop(now=200.0, request_budget=1, phase_b=1, remaining=10) == "past its deadline"
