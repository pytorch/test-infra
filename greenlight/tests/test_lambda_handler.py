import base64
import importlib
import json
import os
import sys
from unittest.mock import MagicMock, Mock

import pytest

from greenlight import app_tokens, fanout, lambda_handler, state_dynamo, worker
from greenlight.worker import WorkerPayload

_PEM = "-----BEGIN RSA PRIVATE KEY-----\nline-one\nline-two\n-----END RSA PRIVATE KEY-----\n"
_PEM_B64 = base64.b64encode(_PEM.encode("utf-8")).decode("ascii")
_CH_PASSWORD = "clickhouse-secret-pw"
_SECRET_STORE = "greenlight/prod"
_APP_ID = "123456"
_INSTALLATION_ID = 42
_APP_SLUG = "pytorchgreenlight"
_TABLE = "greenlight-state"
_FUNCTION = "greenlight-scan"
_MAX_ENV = lambda_handler._MAX_DISPATCHES_ENV
_SCHEDULE = {"source": "aws.events", "detail-type": "Scheduled Event", "time": "2026-11-24T12:00:00Z"}
_WORKER = {"greenlight_worker": {"repo": "pytorch/vision", "tick": "2026-11-24T12:00:00Z", "dispatch_cap": 3}}


@pytest.fixture(autouse=True)
def _restore_environ():
    """Snapshot os.environ so the handler's direct writes never leak across tests."""
    saved = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(saved)


class _Recorder:
    """Stands in for ``Planner`` or ``Worker``: records how it was built and answers ``run``."""

    def __init__(self, result: object = None, error: BaseException | None = None) -> None:
        self.result = result
        self.error = error
        self.args: tuple[object, ...] = ()
        self.kwargs: dict[str, object] = {}

    def __call__(self, *args: object, **kwargs: object) -> "_Recorder":
        self.args, self.kwargs = args, kwargs
        return self

    def run(self) -> object:
        if self.error is not None:
            raise self.error
        return self.result


@pytest.fixture
def fakes(monkeypatch):
    monkeypatch.setenv("SECRET_STORE_NAME", _SECRET_STORE)
    monkeypatch.setenv("GITHUB_APP_ID", _APP_ID)
    monkeypatch.setenv("GITHUB_INSTALLATION_ID", str(_INSTALLATION_ID))
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "greenlight-ro")
    monkeypatch.setenv("CLICKHOUSE_HOST", "greenlight.clickhouse.cloud")
    monkeypatch.setenv("PYTORCH_GREENLIGHT_STATE_TABLE", _TABLE)
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", _FUNCTION)
    monkeypatch.delenv("CLICKHOUSE_ENDPOINT", raising=False)
    monkeypatch.delenv(_MAX_ENV, raising=False)

    secret_json = json.dumps({"GITHUB_APP_SECRET": _PEM_B64, "CLICKHOUSE_PASSWORD": _CH_PASSWORD})
    fake_boto3 = MagicMock()
    fake_boto3.client.return_value.get_secret_value.return_value = {"SecretString": secret_json}
    fake_github = MagicMock()
    fake_github.GithubIntegration.return_value.get_app.return_value.slug = _APP_SLUG
    monkeypatch.setitem(sys.modules, "boto3", fake_boto3)
    # Ensure the real github module is in sys.modules before replacing it, so monkeypatch restores
    # it on teardown instead of deleting the key; a later `from github import ...` would otherwise
    # rebuild the exception classes and break isinstance checks in other tests.
    importlib.import_module("github")
    monkeypatch.setitem(sys.modules, "github", fake_github)

    planner, runner = _Recorder(), _Recorder(result="done")
    invoker = Mock(name="invoke")
    monkeypatch.setattr(fanout, "Planner", planner)
    monkeypatch.setattr(fanout, "lambda_invoker", Mock(return_value=invoker))
    monkeypatch.setattr(worker, "Worker", runner)
    monkeypatch.setattr(state_dynamo, "DynamoStore", Mock(name="DynamoStore"))
    return {"boto3": fake_boto3, "github": fake_github, "planner": planner, "worker": runner, "invoker": invoker}


def test_the_schedule_runs_the_planner(fakes):
    result = lambda_handler.handler(dict(_SCHEDULE), object())

    assert result == {"status": "ok"}
    fake_github, planner = fakes["github"], fakes["planner"]
    fakes["boto3"].client.assert_called_once_with("secretsmanager", region_name="us-east-1")
    assert os.environ["CLICKHOUSE_PASSWORD"] == _CH_PASSWORD
    fake_github.Auth.AppAuth.assert_called_once_with(_APP_ID, _PEM)
    config = planner.args[0]
    assert (config.state_table, config.max_workers) == (_TABLE, 3)
    kwargs = planner.kwargs
    assert kwargs["tick"] == "2026-11-24T12:00:00Z"
    assert kwargs["store"] is state_dynamo.DynamoStore.return_value  # type: ignore[attr-defined]
    state_dynamo.DynamoStore.assert_called_once_with(_TABLE)  # type: ignore[attr-defined]
    tokens = kwargs["tokens"]
    assert isinstance(tokens, app_tokens.AppTokens)
    assert tokens._integration is fake_github.GithubIntegration.return_value
    assert (tokens._installation_id, tokens._owner) == (_INSTALLATION_ID, "pytorch")
    assert kwargs["invoke"] is fakes["invoker"]
    fanout.lambda_invoker.assert_called_once_with(_FUNCTION)  # type: ignore[attr-defined]
    assert kwargs["bot_login"] == f"{_APP_SLUG}[bot]"
    assert (kwargs["max_dispatches"], kwargs["ref"], kwargs["timeout_minutes"]) == (30, "main", 45)
    assert isinstance(kwargs["started"], float)
    assert "BOT_LOGIN" not in os.environ
    assert "PYTORCH_GREENLIGHT_GITHUB_TOKEN" not in os.environ


def test_a_schedule_without_its_time_ticks_on_the_invocations_start(fakes):
    event: dict[str, object] = {key: value for key, value in _SCHEDULE.items() if key != "time"}

    lambda_handler.handler(event, object())

    assert fakes["planner"].kwargs["tick"].endswith("+00:00")


def test_a_worker_event_runs_that_repos_worker(fakes):
    result = lambda_handler.handler(json.loads(json.dumps(_WORKER)), object())

    assert result == {"status": "done"}
    runner = fakes["worker"]
    assert runner.args[1] == WorkerPayload("pytorch/vision", "2026-11-24T12:00:00Z", 3)
    assert (runner.kwargs["ref"], runner.kwargs["timeout_minutes"]) == ("main", 45)
    get_app = fakes["github"].GithubIntegration.return_value.get_app
    get_app.assert_not_called()
    assert runner.kwargs["resolve_bot_login"]() == f"{_APP_SLUG}[bot]"
    assert fakes["planner"].args == ()
    fanout.lambda_invoker.assert_not_called()  # type: ignore[attr-defined]


def test_a_worker_needs_no_function_name(fakes, monkeypatch):
    monkeypatch.delenv("AWS_LAMBDA_FUNCTION_NAME")

    assert lambda_handler.handler(json.loads(json.dumps(_WORKER)), object()) == {"status": "done"}


@pytest.mark.parametrize(
    "event",
    [
        pytest.param({}, id="empty"),
        pytest.param({"source": "eventbridge"}, id="old-shape"),
        pytest.param({"source": "aws.events"}, id="no-detail-type"),
        pytest.param({"source": "aws.events", "detail-type": "Object Created"}, id="other-detail-type"),
    ],
)
def test_any_other_event_is_refused_before_anything_is_read(fakes, event):
    with pytest.raises(ValueError, match="refusing an event that is neither the scan schedule nor a worker event"):
        lambda_handler.handler(event, object())

    fakes["boto3"].client.assert_not_called()
    fakes["github"].GithubIntegration.assert_not_called()


def test_a_malformed_worker_event_is_refused_before_anything_is_read(fakes):
    with pytest.raises(ValueError, match="a worker event is exactly"):
        lambda_handler.handler({"greenlight_worker": {"repo": "pytorch/vision"}}, object())

    fakes["boto3"].client.assert_not_called()


@pytest.mark.parametrize(("raw", "expected"), [("", 30), ("   ", 30), ("5", 5), ("  7  ", 7), ("0", 0), ("31", 31)])
def test_the_max_dispatches_knob(fakes, monkeypatch, raw, expected):
    monkeypatch.setenv(_MAX_ENV, raw)

    lambda_handler.handler(dict(_SCHEDULE), object())

    assert fakes["planner"].kwargs["max_dispatches"] == expected


@pytest.mark.parametrize(
    ("raw", "match"), [("thirty", "must be an integer"), ("30.5", "must be an integer"), ("-1", "must not be negative")]
)
def test_a_bad_max_dispatches_is_refused_before_any_token(fakes, monkeypatch, raw, match):
    monkeypatch.setenv(_MAX_ENV, raw)

    with pytest.raises(ValueError, match=match):
        lambda_handler.handler(dict(_SCHEDULE), object())

    fakes["github"].GithubIntegration.assert_not_called()


@pytest.mark.parametrize("slug", [pytest.param("", id="empty"), pytest.param(None, id="absent")])
def test_an_unusable_app_slug_raises(fakes, slug):
    fakes["github"].GithubIntegration.return_value.get_app.return_value.slug = slug

    with pytest.raises(ValueError, match="unusable app slug"):
        lambda_handler.handler(dict(_SCHEDULE), object())


@pytest.mark.parametrize(
    "missing",
    [
        "SECRET_STORE_NAME",
        "GITHUB_APP_ID",
        "GITHUB_INSTALLATION_ID",
        "CLICKHOUSE_USERNAME",
        "AWS_LAMBDA_FUNCTION_NAME",
        "PYTORCH_GREENLIGHT_STATE_TABLE",
    ],
)
def test_a_missing_setting_raises(fakes, monkeypatch, missing):
    monkeypatch.delenv(missing)

    with pytest.raises(ValueError, match=missing):
        lambda_handler.handler(dict(_SCHEDULE), object())

    fakes["github"].GithubIntegration.assert_not_called()


def test_a_missing_clickhouse_host_and_endpoint_raises(fakes, monkeypatch):
    monkeypatch.delenv("CLICKHOUSE_HOST")

    with pytest.raises(ValueError, match="CLICKHOUSE_HOST or CLICKHOUSE_ENDPOINT"):
        lambda_handler.handler(dict(_SCHEDULE), object())


def test_a_non_numeric_installation_id_raises(fakes, monkeypatch):
    monkeypatch.setenv("GITHUB_INSTALLATION_ID", "not-a-number")

    with pytest.raises(ValueError, match="invalid literal for int"):
        lambda_handler.handler(dict(_SCHEDULE), object())


@pytest.mark.parametrize("missing", ["GITHUB_APP_SECRET", "CLICKHOUSE_PASSWORD"])
def test_a_secret_missing_a_key_raises(fakes, missing):
    secret = {"GITHUB_APP_SECRET": _PEM_B64, "CLICKHOUSE_PASSWORD": _CH_PASSWORD}
    del secret[missing]
    fakes["boto3"].client.return_value.get_secret_value.return_value = {"SecretString": json.dumps(secret)}

    with pytest.raises(ValueError, match=missing) as excinfo:
        lambda_handler.handler(dict(_SCHEDULE), object())

    assert _SECRET_STORE in str(excinfo.value)


def test_a_planner_failure_propagates(fakes):
    fakes["planner"].error = RuntimeError("pytorch/vision: its worker could not be invoked")

    with pytest.raises(RuntimeError, match="could not be invoked"):
        lambda_handler.handler(dict(_SCHEDULE), object())
