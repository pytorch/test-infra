import logging

from greenlight import act


def test_run_returns_none(make_config):
    act.run(make_config())


def test_run_emits_a_log_record(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        act.run(make_config())
    assert len(caplog.records) >= 1
