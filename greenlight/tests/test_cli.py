import functools
import logging
import sys
from contextlib import contextmanager
from types import MethodType
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest

from greenlight import cli, merge_authz, review, verdict
from greenlight.config import Config
from greenlight.constants import DEFAULT_DISPATCH_REF, DEFAULT_TIMEOUT_MINUTES, TARGET_REPO
from greenlight.exit_codes import EXIT_ALREADY_RUNNING, EXIT_FAILURE, EXIT_OK
from greenlight.guards import SingleInstanceError

if TYPE_CHECKING:
    from collections.abc import Mapping


@contextmanager
def _noop_lock(path):
    yield


def _pop_resolve_authorized(kwargs: Mapping[str, object]) -> dict[str, object]:
    """Assert ``resolve_authorized`` is a shared cache's ``.get`` and return the remaining kwargs.

    Every review path must bind the process-wide ``AuthorizedLoginsCache.get`` as the resolver;
    stripping it here lets the caller compare the rest of the bound scan flags by value.
    """
    remaining = dict(kwargs)
    resolve = remaining.pop("resolve_authorized")
    assert isinstance(resolve, MethodType)
    assert isinstance(resolve.__self__, merge_authz.AuthorizedLoginsCache)
    assert resolve.__func__ is merge_authz.AuthorizedLoginsCache.get
    return remaining


def test_build_parser_parses_common_flags_per_subcommand():
    parser = cli.build_parser()
    args = parser.parse_args(
        ["review", "--loop", "--interval", "5.5", "--log-level", "DEBUG", "--lock-path", "/run/greenlight.lock"]
    )
    assert args.command == "review"
    assert args.loop is True
    assert args.interval == 5.5
    assert args.log_level == "DEBUG"
    assert args.lock_path == "/run/greenlight.lock"


def test_build_parser_defaults_per_subcommand():
    parser = cli.build_parser()
    args = parser.parse_args(["review"])
    assert args.command == "review"
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


def test_main_review_dispatches_to_review_phase(monkeypatch):
    review_mock = Mock()
    monkeypatch.setattr(review, "run", review_mock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review"])

    assert rc == EXIT_OK
    review_mock.assert_called_once()
    assert isinstance(review_mock.call_args.args[0], Config)


def test_main_loop_calls_run_forever_with_phase(monkeypatch):
    captured: dict[str, object] = {}

    def fake_run_forever(config, *, run):
        captured["config"] = config
        captured["run"] = run

    monkeypatch.setattr(cli, "run_forever", fake_run_forever)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review", "--loop"])

    assert rc == EXIT_OK
    assert isinstance(captured["config"], Config)
    bound = captured["run"]
    assert isinstance(bound, functools.partial)
    assert bound.func is review.run
    assert _pop_resolve_authorized(bound.keywords) == {
        "pr": None,
        "max_dispatches": None,
        "ref": "main",
        "timeout_minutes": 45,
        "force": False,
        "requester": None,
        "allow_untrusted_author": False,
    }


def test_main_oneshot_failure_returns_exit_failure(monkeypatch):
    monkeypatch.setattr(review, "run", Mock(side_effect=ValueError("boom")))
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review"])

    assert rc == EXIT_FAILURE


def test_main_already_running_returns_exit_already_running(monkeypatch):
    @contextmanager
    def raising_lock(path):
        raise SingleInstanceError("another instance holds the lock")
        yield  # pragma: no cover - never reached

    monkeypatch.setattr(cli, "single_instance_lock", raising_lock)
    review_mock = Mock()
    monkeypatch.setattr(review, "run", review_mock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review"])

    assert rc == EXIT_ALREADY_RUNNING
    review_mock.assert_not_called()


def test_main_loop_already_running_returns_exit_already_running(monkeypatch):
    @contextmanager
    def raising_lock(path):
        raise SingleInstanceError("another instance holds the lock")
        yield  # pragma: no cover - never reached

    monkeypatch.setattr(cli, "single_instance_lock", raising_lock)
    run_forever_mock = Mock()
    monkeypatch.setattr(cli, "run_forever", run_forever_mock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review", "--loop"])

    assert rc == EXIT_ALREADY_RUNNING
    run_forever_mock.assert_not_called()


def test_cli_args_override_env(monkeypatch):
    monkeypatch.setenv("PYTORCH_GREENLIGHT_INTERVAL_SECONDS", "30")
    monkeypatch.setenv("PYTORCH_GREENLIGHT_LOG_LEVEL", "warning")
    monkeypatch.setenv("PYTORCH_GREENLIGHT_LOCK_PATH", "/env/lock")
    monkeypatch.setenv("PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS", "7")

    captured: dict[str, object] = {}

    def fake_run_forever(config, *, run):
        captured["config"] = config

    monkeypatch.setattr(cli, "run_forever", fake_run_forever)
    monkeypatch.setattr(cli, "single_instance_lock", _noop_lock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review", "--loop", "--interval", "5", "--lock-path", "/cli/lock"])

    assert rc == EXIT_OK
    cfg = captured["config"]
    assert isinstance(cfg, Config)
    assert cfg.interval_seconds == 5.0
    assert cfg.lock_path == "/cli/lock"
    assert cfg.log_level == "WARNING"
    assert cfg.max_runtime_seconds == 7.0


def test_cli_log_level_override(monkeypatch):
    captured: dict[str, object] = {}

    def phase(config, **_kwargs):
        captured["config"] = config

    monkeypatch.setattr(review, "run", phase)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review", "--log-level", "debug"])

    assert rc == EXIT_OK
    cfg = captured["config"]
    assert isinstance(cfg, Config)
    assert cfg.log_level == "DEBUG"


def test_main_argv_none_uses_sys_argv(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["greenlight", "review"])
    review_mock = Mock()
    monkeypatch.setattr(review, "run", review_mock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main()

    assert rc == EXIT_OK
    review_mock.assert_called_once()


def test_exit_code_constants():
    assert EXIT_OK == 0
    assert EXIT_FAILURE == 1
    assert EXIT_ALREADY_RUNNING == 3


def test_module_entry_point_wires_to_cli_main():
    import greenlight.__main__ as entry

    assert entry.main is cli.main


@pytest.mark.parametrize("bad", ["0", "-1", "nan", "1e12"])
def test_main_bad_interval_is_usage_error(bad):
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["review", "--interval", bad])
    assert excinfo.value.code == 2


def test_main_bad_log_level_is_usage_error():
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["review", "--log-level", "bogus"])
    assert excinfo.value.code == 2


def test_main_bad_env_log_level_is_usage_error(monkeypatch):
    monkeypatch.setenv("PYTORCH_GREENLIGHT_LOG_LEVEL", "bogus")
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["review"])
    assert excinfo.value.code == 2


def test_main_bad_env_numeric_is_usage_error(monkeypatch):
    monkeypatch.setenv("PYTORCH_GREENLIGHT_INTERVAL_SECONDS", "not-a-number")
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["review"])
    assert excinfo.value.code == 2


def test_main_passes_configured_lock_path(monkeypatch):
    captured: dict[str, object] = {}

    @contextmanager
    def capturing_lock(path):
        captured["path"] = path
        yield

    monkeypatch.setattr(cli, "single_instance_lock", capturing_lock)
    monkeypatch.setattr(review, "run", Mock())
    monkeypatch.setattr(cli, "configure_logging", Mock())
    monkeypatch.setenv("PYTORCH_GREENLIGHT_LOCK_PATH", "/run/gl.lock")

    rc = cli.main(["review"])

    assert rc == EXIT_OK
    assert captured["path"] == "/run/gl.lock"


def test_main_logs_effective_lock_path(monkeypatch, caplog):
    monkeypatch.setattr(cli, "single_instance_lock", _noop_lock)
    monkeypatch.setattr(review, "run", Mock())
    monkeypatch.setattr(cli, "configure_logging", Mock())
    monkeypatch.setenv("PYTORCH_GREENLIGHT_LOCK_PATH", "/run/gl.lock")

    with caplog.at_level(logging.INFO, logger="greenlight"):
        cli.main(["review"])

    assert "/run/gl.lock" in caplog.text


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("debug", "DEBUG"), ("DEBUG", "DEBUG"), (" debug ", "DEBUG"), ("", "INFO"), ("   ", "INFO")],
)
def test_cli_log_level_normalized_and_accepted(raw, expected, monkeypatch):
    captured: dict[str, object] = {}

    def phase(config, **_kwargs):
        captured["config"] = config

    monkeypatch.setattr(review, "run", phase)
    monkeypatch.setattr(cli, "single_instance_lock", _noop_lock)

    rc = cli.main(["review", "--log-level", raw])

    assert rc == EXIT_OK
    cfg = captured["config"]
    assert isinstance(cfg, Config)
    assert cfg.log_level == expected


@pytest.mark.parametrize("blank", ["", "   "])
def test_cli_blank_lock_path_runs_without_lock(blank, monkeypatch, caplog):
    monkeypatch.setattr(review, "run", Mock())
    monkeypatch.setattr(cli, "configure_logging", Mock())

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        rc = cli.main(["review", "--lock-path", blank])

    assert rc == EXIT_OK
    # Falsy lock path -> no lock file is opened; the missing-lock warning is emitted instead.
    assert "PYTORCH_GREENLIGHT_LOCK_PATH" in caplog.text


def test_main_lock_open_failure_is_clear_not_phase_failure(tmp_path, monkeypatch, caplog):
    bad = str(tmp_path / "missing-dir" / "greenlight.lock")
    monkeypatch.setenv("PYTORCH_GREENLIGHT_LOCK_PATH", bad)
    monkeypatch.setattr(review, "run", Mock())
    monkeypatch.setattr(cli, "configure_logging", Mock())

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        rc = cli.main(["review"])

    assert rc == EXIT_FAILURE
    assert "greenlight phase failed" not in caplog.text
    assert bad in caplog.text


def test_verdict_parser_parses_all_args():
    parser = cli.build_parser()
    args = parser.parse_args(
        [
            "verdict",
            "--repo",
            "owner/name",
            "--pr",
            "5",
            "--head-sha",
            "abc123",
            "--eval-hash",
            "d" * 64,
            "--status",
            "LAND",
            "--verdict-file",
            "some/dir/v.json",
            "--agent-job-url",
            "https://agent",
            "--eval-job-url",
            "https://eval",
            "--bot-login",
            "greenlight-app[bot]",
            "--run-id",
            "123",
            "--log-level",
            "DEBUG",
            "--dry-run",
        ]
    )
    assert args.command == "verdict"
    assert args.repo == "owner/name"
    assert args.pr == 5
    assert args.head_sha == "abc123"
    assert args.eval_hash == "d" * 64
    assert args.status == "LAND"
    assert args.verdict_file == "some/dir/v.json"
    assert args.agent_job_url == "https://agent"
    assert args.eval_job_url == "https://eval"
    assert args.bot_login == "greenlight-app[bot]"
    assert args.run_id == 123
    assert args.log_level == "DEBUG"
    assert args.dry_run is True


def test_verdict_parser_defaults():
    parser = cli.build_parser()
    args = parser.parse_args(["verdict", "--pr", "5", "--head-sha", "abc123"])
    assert args.repo == TARGET_REPO
    assert args.eval_hash == ""
    assert args.status is None
    assert args.verdict_file is None
    assert args.agent_job_url == ""
    assert args.eval_job_url == ""
    assert args.bot_login == ""
    assert args.run_id is None
    assert args.log_level is None
    assert args.dry_run is False


def test_verdict_parser_requires_pr():
    parser = cli.build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["verdict", "--head-sha", "abc"])


def test_verdict_parser_requires_head_sha():
    parser = cli.build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["verdict", "--pr", "5"])


def test_verdict_parser_rejects_unknown_status():
    parser = cli.build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["verdict", "--pr", "5", "--head-sha", "abc", "--status", "MAYBE"])


def test_main_verdict_dispatches_and_builds_request(monkeypatch):
    captured: dict[str, object] = {}

    def fake_run(request, config):
        captured["request"] = request
        captured["config"] = config

    monkeypatch.setattr(verdict, "run", fake_run)
    monkeypatch.setattr(cli, "configure_logging", Mock())
    lock_mock = Mock()
    monkeypatch.setattr(cli, "single_instance_lock", lock_mock)

    rc = cli.main(
        [
            "verdict",
            "--pr",
            "7",
            "--head-sha",
            "abc123",
            "--status",
            "CANCELLED",
            "--agent-job-url",
            "https://agent",
            "--bot-login",
            "greenlight-app[bot]",
            "--run-id",
            "456",
        ]
    )

    assert rc == EXIT_OK
    request = captured["request"]
    assert isinstance(request, verdict.VerdictRequest)
    assert request.pr_number == 7
    assert request.head_sha == "abc123"
    assert request.status == "CANCELLED"
    assert request.repo == TARGET_REPO
    assert request.agent_job_url == "https://agent"
    assert request.bot_login == "greenlight-app[bot]"
    assert request.run_id == 456
    assert isinstance(captured["config"], Config)
    # verdict runs one-shot and must never touch the daemon single-instance lock.
    lock_mock.assert_not_called()


def test_main_verdict_failure_returns_exit_failure(monkeypatch):
    monkeypatch.setattr(verdict, "run", Mock(side_effect=RuntimeError("boom")))
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["verdict", "--pr", "7", "--head-sha", "abc", "--status", "FAILED"])

    assert rc == EXIT_FAILURE


def test_main_verdict_bad_env_is_usage_error(monkeypatch):
    monkeypatch.setenv("PYTORCH_GREENLIGHT_INTERVAL_SECONDS", "not-a-number")
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["verdict", "--pr", "7", "--head-sha", "abc", "--status", "FAILED"])
    assert excinfo.value.code == 2


def test_main_verdict_applies_log_level_override(monkeypatch):
    captured: dict[str, object] = {}

    def fake_run(request, config):
        captured["config"] = config

    monkeypatch.setattr(verdict, "run", fake_run)
    configure_mock = Mock()
    monkeypatch.setattr(cli, "configure_logging", configure_mock)

    rc = cli.main(["verdict", "--pr", "7", "--head-sha", "abc", "--status", "FAILED", "--log-level", "debug"])

    assert rc == EXIT_OK
    config = captured["config"]
    assert isinstance(config, Config)
    assert config.log_level == "DEBUG"
    configure_mock.assert_called_once_with("DEBUG")


def test_review_parser_parses_scan_flags():
    parser = cli.build_parser()
    args = parser.parse_args(
        ["review", "--pr", "5", "--max", "3", "--ref", "release/2.9", "--timeout-minutes", "60", "--force"]
    )
    assert args.pr == 5
    assert args.max == 3
    assert args.ref == "release/2.9"
    assert args.timeout_minutes == 60
    assert args.force is True


def test_review_parser_scan_flag_defaults():
    parser = cli.build_parser()
    args = parser.parse_args(["review"])
    assert args.pr is None
    assert args.max is None
    assert args.ref == DEFAULT_DISPATCH_REF
    assert args.timeout_minutes == DEFAULT_TIMEOUT_MINUTES
    assert args.force is False
    assert args.requester is None
    assert args.allow_untrusted_author is False


def test_review_parser_parses_requester_and_allow_untrusted_author():
    parser = cli.build_parser()
    args = parser.parse_args(["review", "--pr", "5", "--requester", "albanD", "--allow-untrusted-author"])
    assert args.requester == "albanD"
    assert args.allow_untrusted_author is True


def test_main_review_binds_scan_flags_into_run(monkeypatch):
    review_mock = Mock()
    monkeypatch.setattr(review, "run", review_mock)
    monkeypatch.setattr(cli, "single_instance_lock", _noop_lock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review", "--pr", "5", "--max", "2", "--ref", "release/2.9", "--timeout-minutes", "60"])

    assert rc == EXIT_OK
    review_mock.assert_called_once()
    assert isinstance(review_mock.call_args.args[0], Config)
    assert _pop_resolve_authorized(review_mock.call_args.kwargs) == {
        "pr": 5,
        "max_dispatches": 2,
        "ref": "release/2.9",
        "timeout_minutes": 60,
        "force": False,
        "requester": None,
        "allow_untrusted_author": False,
    }


def test_main_review_defaults_bind_into_run(monkeypatch):
    review_mock = Mock()
    monkeypatch.setattr(review, "run", review_mock)
    monkeypatch.setattr(cli, "single_instance_lock", _noop_lock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review"])

    assert rc == EXIT_OK
    assert _pop_resolve_authorized(review_mock.call_args.kwargs) == {
        "pr": None,
        "max_dispatches": None,
        "ref": DEFAULT_DISPATCH_REF,
        "timeout_minutes": DEFAULT_TIMEOUT_MINUTES,
        "force": False,
        "requester": None,
        "allow_untrusted_author": False,
    }


def test_main_force_without_pr_is_usage_error(monkeypatch):
    monkeypatch.setattr(cli, "configure_logging", Mock())
    run_mock = Mock()
    monkeypatch.setattr(review, "run", run_mock)
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["review", "--force"])
    assert excinfo.value.code == 2
    run_mock.assert_not_called()


def test_main_force_with_loop_is_usage_error(monkeypatch):
    monkeypatch.setattr(cli, "configure_logging", Mock())
    run_forever_mock = Mock()
    monkeypatch.setattr(cli, "run_forever", run_forever_mock)
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["review", "--pr", "5", "--force", "--loop"])
    assert excinfo.value.code == 2
    run_forever_mock.assert_not_called()


def test_main_review_force_binds_into_run(monkeypatch):
    review_mock = Mock()
    monkeypatch.setattr(review, "run", review_mock)
    monkeypatch.setattr(cli, "single_instance_lock", _noop_lock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review", "--pr", "5", "--force"])

    assert rc == EXIT_OK
    assert _pop_resolve_authorized(review_mock.call_args.kwargs) == {
        "pr": 5,
        "max_dispatches": None,
        "ref": DEFAULT_DISPATCH_REF,
        "timeout_minutes": DEFAULT_TIMEOUT_MINUTES,
        "force": True,
        "requester": None,
        "allow_untrusted_author": False,
    }


def test_main_review_binds_requester_and_override_into_run(monkeypatch):
    review_mock = Mock()
    monkeypatch.setattr(review, "run", review_mock)
    monkeypatch.setattr(cli, "single_instance_lock", _noop_lock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review", "--pr", "5", "--requester", "albanD", "--allow-untrusted-author"])

    assert rc == EXIT_OK
    assert _pop_resolve_authorized(review_mock.call_args.kwargs) == {
        "pr": 5,
        "max_dispatches": None,
        "ref": DEFAULT_DISPATCH_REF,
        "timeout_minutes": DEFAULT_TIMEOUT_MINUTES,
        "force": False,
        "requester": "albanD",
        "allow_untrusted_author": True,
    }


def test_build_authz_client_requires_token():
    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        cli._build_authz_client(Config(github_token=None))


def test_build_authz_client_builds_github_client():
    from github import Github

    client = cli._build_authz_client(Config(github_token="tok"))

    assert isinstance(client, Github)


def test_main_review_cache_uses_configured_ttl(monkeypatch):
    monkeypatch.setenv("PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS", "123")
    captured: dict[str, object] = {}

    def fake_run(config, **kwargs):
        captured["resolve"] = kwargs["resolve_authorized"]

    monkeypatch.setattr(review, "run", fake_run)
    monkeypatch.setattr(cli, "single_instance_lock", _noop_lock)
    monkeypatch.setattr(cli, "configure_logging", Mock())

    rc = cli.main(["review", "--pr", "5"])

    assert rc == EXIT_OK
    resolve = captured["resolve"]
    assert isinstance(resolve, MethodType)
    cache = resolve.__self__
    # One process-wide cache, built from config: the configured TTL flows into it.
    assert isinstance(cache, merge_authz.AuthorizedLoginsCache)
    assert cache._ttl_seconds == 123.0
