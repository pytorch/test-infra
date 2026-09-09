import dataclasses

import pytest

from greenlight.config import _MAX_REVIEW_WINDOW_HOURS, _MAX_SECONDS, Config

NUMERIC_VARS = [
    ("PYTORCH_GREENLIGHT_INTERVAL_SECONDS", "interval_seconds"),
    ("PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS", "max_runtime_seconds"),
    ("PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS", "backoff_base_seconds"),
    ("PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS", "backoff_max_seconds"),
    ("PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS", "merge_rules_ttl_seconds"),
    ("PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS", "review_window_hours"),
    ("PYTORCH_GREENLIGHT_DRCI_POKE_DELAY_SECONDS", "drci_poke_delay_seconds"),
    ("PYTORCH_GREENLIGHT_SHADOW_ROLLOUT", "shadow_rollout"),
]

POSITIVE_VARS = [
    ("PYTORCH_GREENLIGHT_INTERVAL_SECONDS", "interval_seconds"),
    ("PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS", "backoff_base_seconds"),
    ("PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS", "backoff_max_seconds"),
    ("PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS", "merge_rules_ttl_seconds"),
    ("PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS", "review_window_hours"),
]

BLANK_VALUES = ["", "   ", "\t", "\n"]

SHADOW_ROLLOUT_VAR = "PYTORCH_GREENLIGHT_SHADOW_ROLLOUT"


def test_defaults_when_env_empty():
    cfg = Config.from_env({})
    assert cfg.interval_seconds == 60.0
    assert cfg.log_level == "INFO"
    assert cfg.lock_path is None
    assert cfg.max_runtime_seconds == 600.0
    assert cfg.backoff_base_seconds == 1.0
    assert cfg.backoff_max_seconds == 60.0
    assert cfg.merge_rules_ttl_seconds == 600.0
    assert cfg.review_window_hours == 24.0
    assert cfg.drci_poke_delay_seconds == 10.0
    assert cfg.shadow_rollout == 1.0
    assert cfg.github_token is None
    assert cfg.drci_token is None
    assert cfg.drci_internal_token is None
    assert cfg == Config()


def test_direct_construction_defaults():
    cfg = Config()
    assert cfg.interval_seconds == 60.0
    assert cfg.log_level == "INFO"
    assert cfg.lock_path is None
    assert cfg.max_runtime_seconds == 600.0
    assert cfg.backoff_base_seconds == 1.0
    assert cfg.backoff_max_seconds == 60.0
    assert cfg.merge_rules_ttl_seconds == 600.0
    assert cfg.review_window_hours == 24.0
    assert cfg.drci_poke_delay_seconds == 10.0
    assert cfg.shadow_rollout == 1.0
    assert cfg.github_token is None
    assert cfg.drci_token is None
    assert cfg.drci_internal_token is None


def test_from_env_parses_all_vars():
    env = {
        "PYTORCH_GREENLIGHT_INTERVAL_SECONDS": "30.5",
        "PYTORCH_GREENLIGHT_LOG_LEVEL": "debug",
        "PYTORCH_GREENLIGHT_LOCK_PATH": "/var/run/greenlight.lock",
        "PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS": "120",
        "PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS": "2",
        "PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS": "45",
        "PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS": "900",
        "PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS": "48",
        "PYTORCH_GREENLIGHT_DRCI_POKE_DELAY_SECONDS": "3",
        SHADOW_ROLLOUT_VAR: "0.25",
        "PYTORCH_GREENLIGHT_GITHUB_TOKEN": "ghp_abc123",
        "PYTORCH_GREENLIGHT_DRCI_TOKEN": "drci-key",
        "PYTORCH_GREENLIGHT_DRCI_INTERNAL_TOKEN": "hud-key",
    }
    cfg = Config.from_env(env)
    assert cfg.interval_seconds == 30.5
    assert cfg.log_level == "DEBUG"
    assert cfg.lock_path == "/var/run/greenlight.lock"
    assert cfg.max_runtime_seconds == 120.0
    assert cfg.backoff_base_seconds == 2.0
    assert cfg.backoff_max_seconds == 45.0
    assert cfg.merge_rules_ttl_seconds == 900.0
    assert cfg.review_window_hours == 48.0
    assert cfg.drci_poke_delay_seconds == 3.0
    assert cfg.shadow_rollout == 0.25
    assert cfg.github_token == "ghp_abc123"
    assert cfg.drci_token == "drci-key"
    assert cfg.drci_internal_token == "hud-key"


@pytest.mark.parametrize("blank", BLANK_VALUES)
def test_blank_lock_path_becomes_none(blank):
    cfg = Config.from_env({"PYTORCH_GREENLIGHT_LOCK_PATH": blank})
    assert cfg.lock_path is None


@pytest.mark.parametrize("blank", BLANK_VALUES)
def test_blank_github_token_becomes_none(blank):
    cfg = Config.from_env({"PYTORCH_GREENLIGHT_GITHUB_TOKEN": blank})
    assert cfg.github_token is None


@pytest.mark.parametrize("var", ["PYTORCH_GREENLIGHT_DRCI_TOKEN", "PYTORCH_GREENLIGHT_DRCI_INTERNAL_TOKEN"])
@pytest.mark.parametrize("blank", BLANK_VALUES)
def test_blank_drci_tokens_become_none(var, blank):
    cfg = Config.from_env({var: blank})
    assert cfg.drci_token is None
    assert cfg.drci_internal_token is None


@pytest.mark.parametrize("blank", BLANK_VALUES)
def test_blank_log_level_uses_default(blank):
    cfg = Config.from_env({"PYTORCH_GREENLIGHT_LOG_LEVEL": blank})
    assert cfg.log_level == "INFO"


def test_lock_path_with_surrounding_spaces_preserved_unstripped():
    cfg = Config.from_env({"PYTORCH_GREENLIGHT_LOCK_PATH": "  /run/greenlight.lock  "})
    assert cfg.lock_path == "  /run/greenlight.lock  "


def test_github_token_with_surrounding_spaces_preserved_unstripped():
    cfg = Config.from_env({"PYTORCH_GREENLIGHT_GITHUB_TOKEN": "  tok  "})
    assert cfg.github_token == "  tok  "


def test_github_token_excluded_from_repr():
    cfg = Config(github_token="secret-xyz")
    assert "secret-xyz" not in repr(cfg)


def test_drci_tokens_excluded_from_repr():
    # review.py logs the whole Config with %r, so every credential field must stay out of repr.
    cfg = Config(drci_token="drci-secret", drci_internal_token="hud-secret")
    rendered = repr(cfg)
    assert "drci-secret" not in rendered
    assert "hud-secret" not in rendered


def test_lock_path_preserved():
    cfg = Config.from_env({"PYTORCH_GREENLIGHT_LOCK_PATH": "/run/greenlight.lock"})
    assert cfg.lock_path == "/run/greenlight.lock"


def test_log_level_uppercased():
    cfg = Config.from_env({"PYTORCH_GREENLIGHT_LOG_LEVEL": "warning"})
    assert cfg.log_level == "WARNING"


@pytest.mark.parametrize("raw", ["debug", "DEBUG", " debug ", "\tdebug\n"])
def test_env_log_level_stripped_and_uppercased(raw):
    cfg = Config.from_env({"PYTORCH_GREENLIGHT_LOG_LEVEL": raw})
    assert cfg.log_level == "DEBUG"


@pytest.mark.parametrize(("var", "field"), NUMERIC_VARS)
def test_invalid_float_raises_naming_var(var, field):
    with pytest.raises(ValueError) as excinfo:
        Config.from_env({var: "not-a-number"})
    # Contract: the parse error names the offending variable.
    assert var in str(excinfo.value)


@pytest.mark.parametrize(("var", "field"), NUMERIC_VARS)
def test_negative_value_raises(var, field):
    with pytest.raises(ValueError):
        Config.from_env({var: "-1"})


def test_zero_accepted_for_max_runtime():
    cfg = Config.from_env({"PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS": "0"})
    assert cfg.max_runtime_seconds == 0.0


def test_zero_accepted_for_drci_poke_delay():
    # 0 is a meaningful setting: poke immediately, no ingestion wait.
    cfg = Config.from_env({"PYTORCH_GREENLIGHT_DRCI_POKE_DELAY_SECONDS": "0"})
    assert cfg.drci_poke_delay_seconds == 0.0


@pytest.mark.parametrize(("var", "field"), POSITIVE_VARS)
def test_zero_rejected_for_positive_fields(var, field):
    with pytest.raises(ValueError) as excinfo:
        Config.from_env({var: "0"})
    # Contract: the bounds error names the offending field.
    assert field in str(excinfo.value)


@pytest.mark.parametrize(("var", "field"), NUMERIC_VARS)
def test_value_above_max_raises_naming_field(var, field):
    with pytest.raises(ValueError) as excinfo:
        Config.from_env({var: str(_MAX_SECONDS + 1.0)})
    assert field in str(excinfo.value)


def test_max_seconds_boundary_is_accepted():
    assert Config(interval_seconds=_MAX_SECONDS).interval_seconds == _MAX_SECONDS
    assert Config(max_runtime_seconds=_MAX_SECONDS).max_runtime_seconds == _MAX_SECONDS


def test_review_window_hours_has_its_own_cap_distinct_from_seconds():
    # The window is bounded in hours by its own cap, not the setitimer-driven _MAX_SECONDS.
    assert Config(review_window_hours=_MAX_REVIEW_WINDOW_HOURS).review_window_hours == _MAX_REVIEW_WINDOW_HOURS
    with pytest.raises(ValueError, match="review_window_hours"):
        Config(review_window_hours=_MAX_REVIEW_WINDOW_HOURS + 1.0)


@pytest.mark.parametrize(("var", "field"), NUMERIC_VARS)
@pytest.mark.parametrize("value", ["nan", "inf", "-inf"])
def test_non_finite_per_field_raises_naming_field(var, field, value):
    with pytest.raises(ValueError) as excinfo:
        Config.from_env({var: value})
    assert field in str(excinfo.value)


@pytest.mark.parametrize(("var", "field"), NUMERIC_VARS)
@pytest.mark.parametrize("blank", BLANK_VALUES)
def test_blank_numeric_env_uses_default(var, field, blank):
    cfg = Config.from_env({var: blank})
    assert getattr(cfg, field) == getattr(Config(), field)


def test_finite_value_still_parses():
    cfg = Config.from_env({"PYTORCH_GREENLIGHT_INTERVAL_SECONDS": "12.5"})
    assert cfg.interval_seconds == 12.5


def test_shadow_rollout_unset_defaults_to_the_whole_cohort():
    # Unset is the shipped behaviour: every listed PR is evaluated, and shrinking the experiment
    # is opt-in. This is also what makes the dial a drop-in for the on/off switch it replaced.
    assert Config.from_env({}).shadow_rollout == 1.0


@pytest.mark.parametrize("raw", ["0", "0.0", "0.00"])
def test_shadow_rollout_zero_is_accepted(raw):
    # 0.0 is a meaningful setting, not a fat finger: it is the holdout-everyone end of the dial.
    assert Config.from_env({SHADOW_ROLLOUT_VAR: raw}).shadow_rollout == 0.0


@pytest.mark.parametrize(("raw", "expected"), [("0.5", 0.5), ("0.05", 0.05), ("1", 1.0), (" 0.5 ", 0.5)])
def test_shadow_rollout_fractions_parse(raw, expected):
    assert Config.from_env({SHADOW_ROLLOUT_VAR: raw}).shadow_rollout == expected


@pytest.mark.parametrize("raw", ["1.5", "2", "100", "-0.1", "inf", "-inf", "nan", "abc", "50%"])
def test_shadow_rollout_out_of_unit_interval_raises_naming_field(raw):
    # A dial is naturally typed as a percentage or left at some leftover value; every reading
    # outside 0..1 must fail the tick rather than round itself into a rollout nobody chose. inf is
    # the one that matters most: unguarded it compares greater than any dial and fails open.
    with pytest.raises(ValueError) as excinfo:
        Config.from_env({SHADOW_ROLLOUT_VAR: raw})
    message = str(excinfo.value)
    assert "shadow_rollout" in message or SHADOW_ROLLOUT_VAR in message


def test_shadow_rollout_upper_bound_is_one_not_the_seconds_cap():
    assert Config(shadow_rollout=1.0).shadow_rollout == 1.0
    with pytest.raises(ValueError, match="shadow_rollout"):
        Config(shadow_rollout=1.0000001)


def test_from_env_no_arg_reads_os_environ(monkeypatch):
    monkeypatch.setenv("PYTORCH_GREENLIGHT_INTERVAL_SECONDS", "17")
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
