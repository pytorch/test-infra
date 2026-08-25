from __future__ import annotations

import logging
from typing import NoReturn
from urllib.parse import parse_qs, urlparse

import pytest

from greenlight import drci_poke
from greenlight.constants import DRCI_ENDPOINT


class _Recorder:
    def __init__(self) -> None:
        self.events: list[str] = []


class _FakeSleep:
    def __init__(self, rec: _Recorder) -> None:
        self._rec = rec
        self.slept: list[float] = []

    def __call__(self, seconds: float) -> None:
        self._rec.events.append(f"sleep:{seconds}")
        self.slept.append(seconds)


class _FakePost:
    def __init__(self, rec: _Recorder, status: int = 200) -> None:
        self._rec = rec
        self._status = status
        self.calls: list[tuple[str, bytes, dict[str, str]]] = []

    def __call__(self, url: str, body: bytes, headers: dict[str, str]) -> int:
        self._rec.events.append("post")
        self.calls.append((url, body, headers))
        return self._status


def _boom_sleep(seconds: float) -> NoReturn:
    raise AssertionError("sleep should not be called")


def _boom_post(url: str, body: bytes, headers: dict[str, str]) -> NoReturn:
    raise AssertionError("post should not be called")


def _query(url: str) -> dict[str, list[str]]:
    return parse_qs(urlparse(url).query)


def _form(body: bytes) -> dict[str, list[str]]:
    return parse_qs(body.decode("utf-8"))


@pytest.fixture
def poke_config(make_config):
    def _make(**overrides):
        base = {"drci_token": "drci-key", "drci_poke_delay_seconds": 0.0}
        return make_config(**{**base, **overrides})

    return _make


def test_poke_sends_pr_number_as_query_parameter(poke_config):
    rec = _Recorder()
    post = _FakePost(rec)

    drci_poke.poke("pytorch/pytorch", 1234, poke_config(), sleep=_FakeSleep(rec), post=post)

    url, _, _ = post.calls[0]
    # prNumber in the body instead would make the endpoint sweep the whole repo (~900s).
    assert url.startswith(f"{DRCI_ENDPOINT}?")
    assert _query(url) == {"prNumber": ["1234"]}


def test_poke_sends_bare_repo_name_and_org_in_form_body(poke_config):
    rec = _Recorder()
    post = _FakePost(rec)

    drci_poke.poke("meta-pytorch/torchcodec", 7, poke_config(), sleep=_FakeSleep(rec), post=post)

    _, body, headers = post.calls[0]
    assert _form(body) == {"repo": ["torchcodec"], "org": ["meta-pytorch"]}
    assert b"owner" not in body
    assert headers["Content-Type"] == "application/x-www-form-urlencoded"
    # The body must never carry the prNumber; it belongs in the query string.
    assert "prNumber" not in _form(body)


def test_poke_sends_raw_authorization_without_bearer_prefix(poke_config):
    rec = _Recorder()
    post = _FakePost(rec)

    drci_poke.poke("pytorch/pytorch", 1, poke_config(drci_token="drci-key"), sleep=_FakeSleep(rec), post=post)

    _, _, headers = post.calls[0]
    assert headers["Authorization"] == "drci-key"
    assert not headers["Authorization"].startswith("Bearer")


def test_poke_adds_internal_bot_header_when_configured(poke_config):
    rec = _Recorder()
    post = _FakePost(rec)

    drci_poke.poke("pytorch/pytorch", 1, poke_config(drci_internal_token="hud-key"), sleep=_FakeSleep(rec), post=post)

    _, _, headers = post.calls[0]
    assert headers["x-hud-internal-bot"] == "hud-key"


def test_poke_omits_internal_bot_header_when_unset(poke_config):
    rec = _Recorder()
    post = _FakePost(rec)

    drci_poke.poke("pytorch/pytorch", 1, poke_config(drci_internal_token=None), sleep=_FakeSleep(rec), post=post)

    _, _, headers = post.calls[0]
    assert "x-hud-internal-bot" not in headers


def test_poke_sleeps_the_configured_delay_before_posting(poke_config):
    rec = _Recorder()
    sleep = _FakeSleep(rec)
    post = _FakePost(rec)

    drci_poke.poke("pytorch/pytorch", 1, poke_config(drci_poke_delay_seconds=12.5), sleep=sleep, post=post)

    # The wait exists to let the just-uploaded state row reach ClickHouse, so it must precede the POST.
    assert rec.events == ["sleep:12.5", "post"]
    assert sleep.slept == [12.5]


def test_poke_with_zero_delay_posts_without_sleeping(poke_config):
    rec = _Recorder()
    post = _FakePost(rec)

    drci_poke.poke("pytorch/pytorch", 1, poke_config(drci_poke_delay_seconds=0.0), sleep=_boom_sleep, post=post)

    assert rec.events == ["post"]


def test_poke_without_token_skips_the_request(poke_config, caplog):
    with caplog.at_level(logging.WARNING, logger="greenlight"):
        drci_poke.poke("pytorch/pytorch", 1, poke_config(drci_token=None), sleep=_boom_sleep, post=_boom_post)

    assert any("no Dr. CI token configured" in record.getMessage() for record in caplog.records)


@pytest.mark.parametrize("repo", ["pytorch", "", "/pytorch", "pytorch/"])
def test_poke_rejects_malformed_repo_without_requesting(repo, poke_config, caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        drci_poke.poke(repo, 1, poke_config(), sleep=_boom_sleep, post=_boom_post)

    assert any("is not in owner/name form" in record.getMessage() for record in caplog.records)


@pytest.mark.parametrize("status", [200, 201, 204, 299])
def test_poke_logs_success_for_2xx(status, poke_config, caplog):
    rec = _Recorder()

    with caplog.at_level(logging.INFO, logger="greenlight"):
        drci_poke.poke("pytorch/pytorch", 5, poke_config(), sleep=_FakeSleep(rec), post=_FakePost(rec, status))

    assert any(f"poked Dr. CI for pytorch/pytorch#5 (HTTP {status})" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("status", [300, 400, 403, 500, 502])
def test_poke_swallows_non_2xx_and_logs_the_code(status, poke_config, caplog):
    rec = _Recorder()

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        drci_poke.poke("pytorch/pytorch", 5, poke_config(), sleep=_FakeSleep(rec), post=_FakePost(rec, status))

    # An auth failure answers 500, so a non-2xx cannot be classified -- but it must never raise.
    assert any(f"returned HTTP {status}" in record.getMessage() for record in caplog.records)


def test_poke_swallows_transport_error(poke_config, caplog):
    def exploding_post(url: str, body: bytes, headers: dict[str, str]) -> NoReturn:
        raise OSError("connection reset")

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        drci_poke.poke("pytorch/pytorch", 9, poke_config(), sleep=_boom_sleep, post=exploding_post)

    assert any("Dr. CI poke for pytorch/pytorch#9 failed" in record.getMessage() for record in caplog.records)
    assert any(record.exc_info is not None for record in caplog.records)


def test_poke_swallows_sleep_failure_without_posting(poke_config, caplog):
    rec = _Recorder()
    post = _FakePost(rec)

    def exploding_sleep(seconds: float) -> NoReturn:
        raise RuntimeError("interrupted")

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        drci_poke.poke("pytorch/pytorch", 9, poke_config(drci_poke_delay_seconds=1.0), sleep=exploding_sleep, post=post)

    assert post.calls == []
    assert any("Dr. CI poke for pytorch/pytorch#9 failed" in record.getMessage() for record in caplog.records)


class _FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status


class _FakePoolManager:
    """Structural stand-in for urllib3.PoolManager recording how it was built and called."""

    def __init__(self, *, timeout: object, retries: object) -> None:
        self.timeout = timeout
        self.retries = retries
        self.requests: list[tuple[str, str, bytes, dict[str, str]]] = []
        self.cleared = 0

    def __enter__(self) -> _FakePoolManager:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.cleared += 1

    def request(self, method: str, url: str, *, body: bytes, headers: dict[str, str]) -> _FakeResponse:
        self.requests.append((method, url, body, headers))
        return _FakeResponse(207)


@pytest.fixture
def fake_pool_managers(monkeypatch):
    import urllib3

    built: list[_FakePoolManager] = []

    def factory(**kwargs: object) -> _FakePoolManager:
        manager = _FakePoolManager(**kwargs)
        built.append(manager)
        return manager

    monkeypatch.setattr(urllib3, "PoolManager", factory)
    return built


def test_default_post_issues_a_bounded_untried_post(fake_pool_managers):
    import urllib3

    status = drci_poke._default_post("https://hud.example/api?prNumber=3", b"repo=pytorch&org=pytorch", {"A": "b"})

    assert status == 207
    manager = fake_pool_managers[0]
    assert manager.requests == [("POST", "https://hud.example/api?prNumber=3", b"repo=pytorch&org=pytorch", {"A": "b"})]
    # An unbounded or retrying request could outlast the calling job; both must stay pinned.
    assert manager.retries is False
    assert isinstance(manager.timeout, urllib3.Timeout)
    assert manager.timeout.connect_timeout == drci_poke._CONNECT_TIMEOUT_SECONDS
    assert manager.timeout.read_timeout == drci_poke._READ_TIMEOUT_SECONDS
    assert manager.cleared == 1


def test_default_post_timeouts_stay_well_under_a_ci_job_budget():
    # The poke runs inside a 15-minute job; the whole request must cost a small slice of it.
    assert drci_poke._CONNECT_TIMEOUT_SECONDS + drci_poke._READ_TIMEOUT_SECONDS < 60.0


def test_poke_default_seams_are_real_sleep_and_post():
    import inspect
    import time

    defaults = inspect.signature(drci_poke.poke).parameters
    assert defaults["sleep"].default is time.sleep
    assert defaults["post"].default is drci_poke._default_post
