import sys
from contextlib import contextmanager
from unittest.mock import Mock

from radar import cli
from radar.config import Config
from radar.guards import SingleInstanceError


@contextmanager
def _noop_lock(path):
    yield


def test_build_parser_parses_all_flags():
    parser = cli.build_parser()
    args = parser.parse_args(["--loop", "--interval", "5.5", "--log-level", "DEBUG", "--lock-path", "/run/radar.lock"])
    assert args.loop is True
    assert args.interval == 5.5
    assert args.log_level == "DEBUG"
    assert args.lock_path == "/run/radar.lock"


def test_build_parser_defaults_are_unset():
    parser = cli.build_parser()
    args = parser.parse_args([])
    assert args.loop is False
    assert args.interval is None
    assert args.log_level is None
    assert args.lock_path is None


def test_main_loop_calls_run_forever(monkeypatch):
    captured: dict[str, Config] = {}
    monkeypatch.setattr(cli, "run_forever", lambda config: captured.update(config=config))
    log_mock = Mock()
    monkeypatch.setattr(cli, "configure_logging", log_mock)

    rc = cli.main(["--loop"])

    assert rc == cli.EXIT_OK
    assert isinstance(captured["config"], Config)
    log_mock.assert_called_once()


def test_main_oneshot_success(monkeypatch):
    run_once_mock = Mock()
    monkeypatch.setattr(cli, "run_once", run_once_mock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main([])

    assert rc == cli.EXIT_OK
    run_once_mock.assert_called_once()
    assert isinstance(run_once_mock.call_args.args[0], Config)


def test_main_oneshot_failure_returns_exit_failure(monkeypatch):
    monkeypatch.setattr(cli, "run_once", Mock(side_effect=ValueError("boom")))
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main([])

    assert rc == cli.EXIT_FAILURE


def test_main_already_running_returns_exit_already_running(monkeypatch):
    @contextmanager
    def raising_lock(path):
        raise SingleInstanceError("another instance holds the lock")
        yield  # pragma: no cover - never reached

    monkeypatch.setattr(cli, "single_instance_lock", raising_lock)
    run_once_mock = Mock()
    monkeypatch.setattr(cli, "run_once", run_once_mock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main([])

    assert rc == cli.EXIT_ALREADY_RUNNING
    run_once_mock.assert_not_called()


def test_main_loop_already_running_returns_exit_already_running(monkeypatch):
    @contextmanager
    def raising_lock(path):
        raise SingleInstanceError("another instance holds the lock")
        yield  # pragma: no cover - never reached

    monkeypatch.setattr(cli, "single_instance_lock", raising_lock)
    run_forever_mock = Mock()
    monkeypatch.setattr(cli, "run_forever", run_forever_mock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["--loop"])

    assert rc == cli.EXIT_ALREADY_RUNNING
    run_forever_mock.assert_not_called()


def test_cli_args_override_env(monkeypatch):
    monkeypatch.setenv("RADAR_INTERVAL_SECONDS", "30")
    monkeypatch.setenv("RADAR_LOG_LEVEL", "warning")
    monkeypatch.setenv("RADAR_LOCK_PATH", "/env/lock")
    monkeypatch.setenv("RADAR_MAX_RUNTIME_SECONDS", "7")

    captured: dict[str, Config] = {}
    monkeypatch.setattr(cli, "run_forever", lambda config: captured.update(config=config))
    monkeypatch.setattr(cli, "single_instance_lock", _noop_lock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["--loop", "--interval", "5", "--lock-path", "/cli/lock"])

    assert rc == cli.EXIT_OK
    cfg = captured["config"]
    assert cfg.interval_seconds == 5.0
    assert cfg.lock_path == "/cli/lock"
    assert cfg.log_level == "WARNING"
    assert cfg.max_runtime_seconds == 7.0


def test_cli_log_level_override(monkeypatch):
    captured: dict[str, Config] = {}
    monkeypatch.setattr(cli, "run_forever", lambda config: captured.update(config=config))
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["--loop", "--log-level", "debug"])

    assert rc == cli.EXIT_OK
    assert captured["config"].log_level == "DEBUG"


def test_main_argv_none_uses_sys_argv(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["radar"])
    run_once_mock = Mock()
    monkeypatch.setattr(cli, "run_once", run_once_mock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main()

    assert rc == cli.EXIT_OK
    run_once_mock.assert_called_once()


def test_exit_code_constants():
    assert cli.EXIT_OK == 0
    assert cli.EXIT_FAILURE == 1
    assert cli.EXIT_ALREADY_RUNNING == 3


def test_module_entry_point_wires_to_cli_main():
    import radar.__main__ as entry

    assert entry.main is cli.main
