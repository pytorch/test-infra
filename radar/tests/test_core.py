import logging

import pytest

from radar import core


def test_perform_iteration_returns_none(make_config):
    core.perform_iteration(make_config())


def test_run_once_returns_none(make_config):
    core.run_once(make_config())


def test_run_once_calls_perform_iteration(make_config, monkeypatch):
    calls = []
    monkeypatch.setattr(core, "perform_iteration", lambda cfg: calls.append(cfg))
    cfg = make_config()
    core.run_once(cfg)
    assert calls == [cfg]


def test_run_once_propagates_exception(make_config, monkeypatch):
    def boom(cfg):
        raise ValueError("boom")

    monkeypatch.setattr(core, "perform_iteration", boom)
    with pytest.raises(ValueError):
        core.run_once(make_config())


def test_perform_iteration_emits_a_log_record(make_config, caplog):
    with caplog.at_level(logging.DEBUG, logger="radar"):
        core.perform_iteration(make_config())
    assert len(caplog.records) >= 1
