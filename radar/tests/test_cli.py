import sys
from contextlib import contextmanager
from unittest.mock import Mock

import pytest

from radar import cli, plan
from radar.config import Config
from radar.guards import SingleInstanceError


@contextmanager
def _noop_lock(path):
    yield


def test_build_parser_parses_common_flags_per_subcommand():
    parser = cli.build_parser()
    args = parser.parse_args(
        ["plan", "--loop", "--interval", "5.5", "--log-level", "DEBUG", "--lock-path", "/run/radar.lock"]
    )
    assert args.command == "plan"
    assert args.loop is True
    assert args.interval == 5.5
    assert args.log_level == "DEBUG"
    assert args.lock_path == "/run/radar.lock"


def test_build_parser_defaults_per_subcommand():
    parser = cli.build_parser()
    args = parser.parse_args(["act"])
    assert args.command == "act"
    assert args.loop is False
    assert args.interval is None
    assert args.log_level is None
    assert args.lock_path is None


def test_build_parser_requires_subcommand():
    parser = cli.build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args([])


def test_main_no_subcommand_is_usage_error(monkeypatch):
    monkeypatch.setattr(cli, "configure_logging", Mock())
    with pytest.raises(SystemExit) as excinfo:
        cli.main([])
    assert excinfo.value.code == 2


def test_main_plan_dispatches_to_plan_phase(monkeypatch):
    plan_mock = Mock()
    act_mock = Mock()
    monkeypatch.setattr(cli, "PHASES", {"plan": plan_mock, "act": act_mock})
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["plan"])

    assert rc == cli.EXIT_OK
    plan_mock.assert_called_once()
    act_mock.assert_not_called()
    assert isinstance(plan_mock.call_args.args[0], Config)


def test_main_act_dispatches_to_act_phase(monkeypatch):
    plan_mock = Mock()
    act_mock = Mock()
    monkeypatch.setattr(cli, "PHASES", {"plan": plan_mock, "act": act_mock})
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["act"])

    assert rc == cli.EXIT_OK
    act_mock.assert_called_once()
    plan_mock.assert_not_called()
    assert isinstance(act_mock.call_args.args[0], Config)


def test_main_loop_calls_run_forever_with_phase(monkeypatch):
    captured: dict[str, object] = {}

    def fake_run_forever(config, *, run):
        captured["config"] = config
        captured["run"] = run

    monkeypatch.setattr(cli, "run_forever", fake_run_forever)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["plan", "--loop"])

    assert rc == cli.EXIT_OK
    assert isinstance(captured["config"], Config)
    assert captured["run"] is plan.run


def test_main_oneshot_failure_returns_exit_failure(monkeypatch):
    monkeypatch.setattr(cli, "PHASES", {"plan": Mock(side_effect=ValueError("boom")), "act": Mock()})
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["plan"])

    assert rc == cli.EXIT_FAILURE


def test_main_already_running_returns_exit_already_running(monkeypatch):
    @contextmanager
    def raising_lock(path):
        raise SingleInstanceError("another instance holds the lock")
        yield  # pragma: no cover - never reached

    monkeypatch.setattr(cli, "single_instance_lock", raising_lock)
    plan_mock = Mock()
    monkeypatch.setattr(cli, "PHASES", {"plan": plan_mock, "act": Mock()})
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["plan"])

    assert rc == cli.EXIT_ALREADY_RUNNING
    plan_mock.assert_not_called()


def test_main_loop_already_running_returns_exit_already_running(monkeypatch):
    @contextmanager
    def raising_lock(path):
        raise SingleInstanceError("another instance holds the lock")
        yield  # pragma: no cover - never reached

    monkeypatch.setattr(cli, "single_instance_lock", raising_lock)
    run_forever_mock = Mock()
    monkeypatch.setattr(cli, "run_forever", run_forever_mock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["plan", "--loop"])

    assert rc == cli.EXIT_ALREADY_RUNNING
    run_forever_mock.assert_not_called()


def test_cli_args_override_env(monkeypatch):
    monkeypatch.setenv("RADAR_INTERVAL_SECONDS", "30")
    monkeypatch.setenv("RADAR_LOG_LEVEL", "warning")
    monkeypatch.setenv("RADAR_LOCK_PATH", "/env/lock")
    monkeypatch.setenv("RADAR_MAX_RUNTIME_SECONDS", "7")

    captured: dict[str, object] = {}

    def fake_run_forever(config, *, run):
        captured["config"] = config

    monkeypatch.setattr(cli, "run_forever", fake_run_forever)
    monkeypatch.setattr(cli, "single_instance_lock", _noop_lock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["plan", "--loop", "--interval", "5", "--lock-path", "/cli/lock"])

    assert rc == cli.EXIT_OK
    cfg = captured["config"]
    assert isinstance(cfg, Config)
    assert cfg.interval_seconds == 5.0
    assert cfg.lock_path == "/cli/lock"
    assert cfg.log_level == "WARNING"
    assert cfg.max_runtime_seconds == 7.0


def test_cli_log_level_override(monkeypatch):
    captured: dict[str, object] = {}

    def phase(config):
        captured["config"] = config

    monkeypatch.setattr(cli, "PHASES", {"plan": phase, "act": phase})
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["plan", "--log-level", "debug"])

    assert rc == cli.EXIT_OK
    cfg = captured["config"]
    assert isinstance(cfg, Config)
    assert cfg.log_level == "DEBUG"


def test_main_argv_none_uses_sys_argv(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["radar", "plan"])
    plan_mock = Mock()
    monkeypatch.setattr(cli, "PHASES", {"plan": plan_mock, "act": Mock()})
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main()

    assert rc == cli.EXIT_OK
    plan_mock.assert_called_once()


def test_exit_code_constants():
    assert cli.EXIT_OK == 0
    assert cli.EXIT_FAILURE == 1
    assert cli.EXIT_ALREADY_RUNNING == 3


def test_module_entry_point_wires_to_cli_main():
    import radar.__main__ as entry

    assert entry.main is cli.main
