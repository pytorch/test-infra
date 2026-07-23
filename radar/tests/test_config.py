import dataclasses

import pytest

from radar.config import Config

NUMERIC_VARS = [
    ("RADAR_INTERVAL_SECONDS", "interval_seconds"),
    ("RADAR_MAX_RUNTIME_SECONDS", "max_runtime_seconds"),
    ("RADAR_BACKOFF_BASE_SECONDS", "backoff_base_seconds"),
    ("RADAR_BACKOFF_MAX_SECONDS", "backoff_max_seconds"),
]


def test_defaults_when_env_empty():
    cfg = Config.from_env({})
    assert cfg.interval_seconds == 60.0
    assert cfg.log_level == "INFO"
    assert cfg.lock_path is None
    assert cfg.max_runtime_seconds == 0.0
    assert cfg.backoff_base_seconds == 1.0
    assert cfg.backoff_max_seconds == 60.0
    assert cfg == Config()


def test_direct_construction_defaults():
    cfg = Config()
    assert cfg.interval_seconds == 60.0
    assert cfg.log_level == "INFO"
    assert cfg.lock_path is None
    assert cfg.max_runtime_seconds == 0.0
    assert cfg.backoff_base_seconds == 1.0
    assert cfg.backoff_max_seconds == 60.0


def test_from_env_parses_all_vars():
    env = {
        "RADAR_INTERVAL_SECONDS": "30.5",
        "RADAR_LOG_LEVEL": "debug",
        "RADAR_LOCK_PATH": "/var/run/radar.lock",
        "RADAR_MAX_RUNTIME_SECONDS": "120",
        "RADAR_BACKOFF_BASE_SECONDS": "2",
        "RADAR_BACKOFF_MAX_SECONDS": "45",
    }
    cfg = Config.from_env(env)
    assert cfg.interval_seconds == 30.5
    assert cfg.log_level == "DEBUG"
    assert cfg.lock_path == "/var/run/radar.lock"
    assert cfg.max_runtime_seconds == 120.0
    assert cfg.backoff_base_seconds == 2.0
    assert cfg.backoff_max_seconds == 45.0


def test_empty_lock_path_becomes_none():
    cfg = Config.from_env({"RADAR_LOCK_PATH": ""})
    assert cfg.lock_path is None


def test_lock_path_preserved():
    cfg = Config.from_env({"RADAR_LOCK_PATH": "/run/radar.lock"})
    assert cfg.lock_path == "/run/radar.lock"


def test_log_level_uppercased():
    cfg = Config.from_env({"RADAR_LOG_LEVEL": "warning"})
    assert cfg.log_level == "WARNING"


@pytest.mark.parametrize(("var", "field"), NUMERIC_VARS)
def test_invalid_float_raises_naming_var(var, field):
    with pytest.raises(ValueError) as excinfo:
        Config.from_env({var: "not-a-number"})
    # Contract: the ValueError names the offending variable.
    assert var in str(excinfo.value)


@pytest.mark.parametrize(("var", "field"), NUMERIC_VARS)
def test_negative_value_raises(var, field):
    with pytest.raises(ValueError):
        Config.from_env({var: "-1"})


@pytest.mark.parametrize(("var", "field"), NUMERIC_VARS)
def test_zero_is_accepted(var, field):
    cfg = Config.from_env({var: "0"})
    assert getattr(cfg, field) == 0.0


@pytest.mark.parametrize("value", ["nan", "inf", "-inf"])
def test_non_finite_raises(value):
    with pytest.raises(ValueError) as excinfo:
        Config.from_env({"RADAR_INTERVAL_SECONDS": value})
    assert "RADAR_INTERVAL_SECONDS" in str(excinfo.value)


def test_finite_value_still_parses():
    cfg = Config.from_env({"RADAR_INTERVAL_SECONDS": "12.5"})
    assert cfg.interval_seconds == 12.5


def test_from_env_no_arg_reads_os_environ(monkeypatch):
    monkeypatch.setenv("RADAR_INTERVAL_SECONDS", "17")
    cfg = Config.from_env()
    assert cfg.interval_seconds == 17.0
    assert cfg.log_level == "INFO"
    assert cfg.lock_path is None


def test_frozen_instance():
    cfg = Config()
    with pytest.raises(dataclasses.FrozenInstanceError):
        cfg.interval_seconds = 5.0  # type: ignore[misc]


def test_slots_no_instance_dict():
    cfg = Config()
    assert not hasattr(cfg, "__dict__")
