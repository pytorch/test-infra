import logging

from radar import plan


def test_run_returns_none(make_config):
    plan.run(make_config())


def test_run_emits_a_log_record(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="radar"):
        plan.run(make_config())
    assert len(caplog.records) >= 1
