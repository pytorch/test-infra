from __future__ import annotations

import base64
import functools
import http.server
import json
import logging
import threading
from typing import TYPE_CHECKING, Any, ClassVar

import github
import pytest
from github import GithubException
from requests.exceptions import RetryError
from urllib3.exceptions import MaxRetryError, ProtocolError
from urllib3.util.retry import Retry

from greenlight import github_client, quota, repo_scan
from greenlight.constants import QUOTA_REFRESH_REQUESTS, TARGET_REPO
from greenlight.guards import IterationTimeout
from greenlight.repo_config import BUILTIN_PYTORCH
from greenlight.state_store import InProcessStore

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator, Sequence

_REPO = "pytorch/vision"


def _meter(phase: quota.Phase = "B", stop: Callable[[], str | None] | None = None) -> quota.RequestMeter:
    meter = quota.TickMeter().meter(_REPO)
    meter.phase = phase
    meter.stop = stop
    return meter


def test_the_tick_makes_one_meter_per_repo():
    tick = quota.TickMeter()

    vision = tick.meter(_REPO)
    pytorch = tick.meter("pytorch/pytorch")

    assert tick.meter(_REPO) is vision
    assert tick.meter("pytorch/pytorch") is pytorch
    assert (vision.repo, pytorch.repo) == (_REPO, "pytorch/pytorch")
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
    """A local GitHub stand-in answering each request with the next scripted status and headers, then 200 with
    ``answer``."""

    def __init__(self, script: Sequence[tuple[int, dict[str, str]]], answer: dict[str, Any] | None = None) -> None:
        self.script = list(script)
        self.hits = 0
        server = self
        answer = {"full_name": _REPO} if answer is None else answer

        class _Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                server.hits += 1
                status, headers = server.script.pop(0) if server.script else (200, {})
                body = json.dumps(answer).encode()
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
def github_at(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., _Server]]:
    """Point every client ``github_client`` builds at a local server, keeping PyGithub, requests and urllib3 real."""
    servers: list[_Server] = []
    real_github = github.Github
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setenv("no_proxy", "127.0.0.1")

    def start(script: Sequence[tuple[int, dict[str, str]]], answer: dict[str, Any] | None = None) -> _Server:
        server = _Server(script, answer)
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


def test_a_429_on_another_repos_patient_client_latches_at_once_and_the_next_request_is_refused(
    github_at, retry_sleeps, caplog
):
    server = github_at([(429, {"Retry-After": "30"})])
    tick = quota.TickMeter(clock=lambda: 1000.0)
    meter = tick.meter(_REPO)
    client = github_client.build_authz_client("tok", meter=meter)

    with caplog.at_level(logging.WARNING, logger="greenlight"), pytest.raises(RetryError) as excinfo:
        _get(client)

    assert github_client.is_rate_limit_error(excinfo.value)
    assert server.hits == 1
    assert retry_sleeps == []
    assert meter.latch.is_set()
    assert tick.latch.until == 1030.0
    assert meter.stopped == quota.RATE_LIMIT
    assert "pytorch/vision: GitHub answered 429, a rate limit" in caplog.text
    with pytest.raises(quota.RateLimitStop) as refused:
        _get(client)
    assert type(refused.value) is quota.RateLimitStop
    assert server.hits == 1


def _primary_meter(phase: quota.Phase = "A") -> quota.RequestMeter:
    meter = quota.TickMeter(clock=lambda: 1000.0).meter(TARGET_REPO)
    meter.phase = phase
    return meter


def test_the_primarys_patient_client_waits_out_a_short_429_in_its_phase_a_counting_the_retry(
    github_at, retry_sleeps, caplog
):
    server = github_at([(429, {"Retry-After": "1"})])
    meter = _primary_meter()

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        assert _get(github_client.build_authz_client("tok", meter=meter))["full_name"] == _REPO

    assert server.hits == meter.requests("A") == 2
    assert len(retry_sleeps) == 1
    assert not meter.latch.is_set()
    assert "pytorch/pytorch: GitHub answered 429 asking to wait 1 s; its patient client waits it out" in caplog.text


@pytest.mark.parametrize(
    ("phase", "headers"),
    [
        pytest.param("A", {"Retry-After": "200"}, id="longer-than-the-cap"),
        pytest.param("A", {}, id="no-retry-after"),
        pytest.param("B", {"Retry-After": "1"}, id="phase-b"),
    ],
)
def test_any_other_429_on_the_primarys_patient_client_latches_at_once(github_at, retry_sleeps, phase, headers):
    server = github_at([(429, headers)])
    meter = _primary_meter(phase)

    with pytest.raises(RetryError):
        _get(github_client.build_authz_client("tok", meter=meter))

    assert server.hits == 1
    assert retry_sleeps == []
    assert meter.latch.is_set()
    assert meter.latch.until == quota_until(headers)


def quota_until(headers: dict[str, str]) -> float:
    return 1000.0 + float(headers.get("Retry-After", "60"))


def test_short_429s_that_outlast_the_patient_retries_latch_with_their_wait(github_at, retry_sleeps):
    server = github_at([(429, {"Retry-After": "1"})] * 3)
    meter = _primary_meter()

    with pytest.raises(RetryError) as excinfo:
        _get(github_client.build_authz_client("tok", meter=meter))

    assert github_client.is_rate_limit_error(excinfo.value)
    assert server.hits == 3
    assert meter.requests("A") == 3
    assert meter.latch.until == 1001.0


def test_pytorchs_merge_rules_refresh_rides_out_a_short_429_and_phase_a_runs(github_at, retry_sleeps, make_config):
    rules = "- name: all\n  patterns: ['*']\n  approved_by: [alice]\n"
    content = {
        "type": "file",
        "encoding": "base64",
        "name": "merge_rules.yaml",
        "path": ".github/merge_rules.yaml",
        "size": len(rules),
        "content": base64.b64encode(rules.encode()).decode(),
    }
    server = github_at([(429, {"Retry-After": "1"})], content)
    meter = _primary_meter()

    snapshot = repo_scan.eligibility_thunk(make_config(), BUILTIN_PYTORCH, InProcessStore(), "tok", meter=meter)()

    assert snapshot.authorized == frozenset({"alice"})
    assert server.hits == meter.requests("A") == 2
    assert not meter.latch.is_set()


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


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(GithubException(429, {"message": "slow down"}), id="429"),
        pytest.param(github.RateLimitExceededException(403, {"message": "rate limit"}, {}), id="403"),
    ],
)
def test_a_rate_limited_read_sets_the_latch_and_keeps_the_last_reading(caplog, error):
    tick = quota.TickMeter()
    calls: list[int] = []

    def read() -> tuple[int, int]:
        calls.append(1)
        if len(calls) > 1:
            raise error
        return 4000, 5000

    gauge = quota.QuotaGauge(tick, read)
    gauge.refresh()

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        gauge.refresh()

    assert tick.latch.is_set()
    assert (gauge.remaining(), gauge.limit) == (4000, 5000)
    [record] = caplog.records
    assert "hit a rate limit" in record.getMessage()
    assert record.exc_info is not None


def test_the_gauge_reads_nothing_once_the_latch_is_set():
    tick = quota.TickMeter()
    readings = iter([(4000, 5000)])
    gauge = quota.QuotaGauge(tick, lambda: next(readings))
    gauge.refresh()
    tick.latch.set()

    gauge.refresh()

    assert gauge.remaining() == 4000


def test_a_gauge_with_nothing_to_read_stays_unknown():
    gauge = quota.QuotaGauge(quota.TickMeter(), None)

    gauge.refresh()

    assert (gauge.remaining(), gauge.limit) == (None, None)


def test_core_quota_reads_the_core_resource():
    class _Core:
        remaining, limit = 4321, 5000

    class _RateClient:
        def get_rate_limit(self) -> Any:
            return type("Overview", (), {"resources": type("Resources", (), {"core": _Core})})

    assert quota.core_quota(_RateClient()) == (4321, 5000)  # type: ignore[arg-type]


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


def test_a_metered_retry_records_the_wait_a_rate_limit_response_asks_for():
    tick = quota.TickMeter(clock=lambda: 1000.0)
    meter = tick.meter(_REPO)

    class _Response:
        status = 403
        headers: ClassVar[dict[str, str]] = {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1300"}

    with pytest.raises(MaxRetryError):
        meter.retry(Retry(total=2)).increment("GET", "/x", response=_Response())  # type: ignore[arg-type]

    assert tick.latch.until == 1300.0
    assert meter.stopped == quota.RATE_LIMIT


def test_the_gauge_reads_again_after_its_refresh_interval_of_requests():
    tick = quota.TickMeter()
    meter = tick.meter(_REPO)
    readings = iter([(4000, 5000), (2000, 5000)])
    gauge = quota.QuotaGauge(tick, lambda: next(readings), refresh_every=3)
    gauge.refresh()

    meter.count()
    meter.count()
    assert gauge.remaining() == 3998
    meter.count()
    assert gauge.remaining() == 2000
    assert quota.QuotaGauge(tick, None)._refresh_every == QUOTA_REFRESH_REQUESTS == 25


def test_a_failed_read_is_tried_again_only_after_another_interval():
    tick = quota.TickMeter()
    meter = tick.meter(_REPO)
    reads: list[int] = []

    def read() -> tuple[int, int]:
        reads.append(tick.total)
        if len(reads) > 1:
            raise ConnectionError("down")
        return 4000, 5000

    gauge = quota.QuotaGauge(tick, read, refresh_every=2)
    gauge.refresh()
    for _ in range(5):
        meter.count()
        gauge.remaining()

    assert reads == [0, 2, 4]
    assert gauge.remaining() == 3995


def test_a_gauge_reading_in_one_thread_is_not_read_again_by_another():
    tick = quota.TickMeter()
    reading = threading.Event()
    release = threading.Event()
    reads: list[int] = []

    def read() -> tuple[int, int]:
        reads.append(1)
        reading.set()
        release.wait(5)
        return 4000, 5000

    gauge = quota.QuotaGauge(tick, read)
    first = threading.Thread(target=gauge.refresh)
    first.start()
    reading.wait(5)
    gauge.refresh()
    release.set()
    first.join()

    assert reads == [1]
    assert gauge.remaining() == 4000


class _Pool:
    """One installation's quota, spent by every invocation's requests."""

    def __init__(self, remaining: int) -> None:
        self.remaining = remaining
        self.lock = threading.Lock()

    def spend(self, meter: quota.RequestMeter) -> None:
        meter.count()
        with self.lock:
            self.remaining -= 1

    def read(self) -> tuple[int, int]:
        with self.lock:
            return self.remaining, 5000


def test_concurrent_gauges_on_one_quota_pool_see_what_the_others_spent():
    pool = _Pool(4000)
    ticks = [quota.TickMeter() for _ in range(3)]
    gauges = [quota.QuotaGauge(tick, pool.read) for tick in ticks]
    for gauge in gauges:
        gauge.refresh()
    meters = [tick.meter(f"pytorch/repo{index}") for index, tick in enumerate(ticks)]
    stops = [
        quota.phase_b_stop(meter, gauge=gauge, floor=3000, deadline=None, request_budget=None)
        for meter, gauge in zip(meters, gauges, strict=True)
    ]

    for _ in range(950):
        pool.spend(meters[0])
        pool.spend(meters[1])
    assert stops[2]() is None
    assert gauges[2].remaining() == 4000

    stopped_at = None
    for spent in range(1, QUOTA_REFRESH_REQUESTS + 1):
        pool.spend(meters[2])
        if (reason := stops[2]()) is not None:
            stopped_at = spent
            break

    assert stopped_at == QUOTA_REFRESH_REQUESTS
    assert reason == "the installation has 2075 requests left, below the floor of 3000"
    assert gauges[0].remaining() == pool.remaining


def test_concurrent_gauges_in_threads_never_read_the_pool_below_what_it_holds():
    pool = _Pool(5000)
    ticks = [quota.TickMeter() for _ in range(4)]
    gauges = [quota.QuotaGauge(tick, pool.read) for tick in ticks]
    for gauge in gauges:
        gauge.refresh()
    estimates: list[list[int]] = [[] for _ in ticks]

    def spend(index: int) -> None:
        meter = ticks[index].meter(f"pytorch/repo{index}")
        for _ in range(200):
            pool.spend(meter)
            remaining = gauges[index].remaining()
            assert remaining is not None
            estimates[index].append(remaining)

    workers = [threading.Thread(target=spend, args=(index,)) for index in range(4)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()

    assert pool.remaining == 4200
    assert all(gauge.remaining() >= pool.remaining for gauge in gauges)  # type: ignore[operator]
    assert all(len(found) == 200 for found in estimates)
