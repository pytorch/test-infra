import base64
import importlib
import json
import logging
import os
import sys
from unittest.mock import MagicMock, Mock

import pytest

from greenlight import cli, lambda_handler
from greenlight.exit_codes import EXIT_ALREADY_RUNNING, EXIT_FAILURE, EXIT_OK

_PEM = "-----BEGIN RSA PRIVATE KEY-----\nline-one\nline-two\n-----END RSA PRIVATE KEY-----\n"
_PEM_B64 = base64.b64encode(_PEM.encode("utf-8")).decode("ascii")
_CH_PASSWORD = "clickhouse-secret-pw"
_CH_USERNAME = "greenlight-ro"
_CH_HOST = "greenlight.clickhouse.cloud"
_TOKEN = "ghs_minted_installation_token"
_SECRET_STORE = "greenlight/prod"
_APP_ID = "123456"
_INSTALLATION_ID = 42
_EXPECTED_ARGV = ["review", "--ref", "main"]
_EXPECTED_PERMISSIONS = {
    "actions": "write",
    "pull_requests": "read",
    "contents": "read",
    "members": "read",
}
_EXPECTED_REPOSITORIES = ["pytorch", "test-infra"]


@pytest.fixture(autouse=True)
def _restore_environ():
    """Snapshot os.environ so the handler's direct writes never leak across tests."""
    saved = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(saved)


@pytest.fixture
def fakes(monkeypatch):
    monkeypatch.setenv("SECRET_STORE_NAME", _SECRET_STORE)
    monkeypatch.setenv("GITHUB_APP_ID", _APP_ID)
    monkeypatch.setenv("GITHUB_INSTALLATION_ID", str(_INSTALLATION_ID))
    monkeypatch.setenv("CLICKHOUSE_USERNAME", _CH_USERNAME)
    monkeypatch.setenv("CLICKHOUSE_HOST", _CH_HOST)
    monkeypatch.delenv("CLICKHOUSE_ENDPOINT", raising=False)

    secret_json = json.dumps({"GITHUB_APP_SECRET": _PEM_B64, "CLICKHOUSE_PASSWORD": _CH_PASSWORD})
    fake_boto3 = MagicMock()
    fake_boto3.client.return_value.get_secret_value.return_value = {"SecretString": secret_json}

    fake_github = MagicMock()
    fake_github.GithubIntegration.return_value.requester.requestJsonAndCheck.return_value = (
        {},
        {"token": _TOKEN},
    )

    monkeypatch.setitem(sys.modules, "boto3", fake_boto3)
    # Ensure the real github module is in sys.modules before replacing it, so monkeypatch restores
    # it on teardown instead of deleting the key. A run that has not yet imported github (github is
    # lazy-imported everywhere) would otherwise evict it here; the next `from github import ...`
    # would rebuild the exception classes, breaking isinstance in later tests such as
    # github_client.is_rate_limit_error.
    importlib.import_module("github")
    monkeypatch.setitem(sys.modules, "github", fake_github)
    return fake_boto3, fake_github


def test_handler_happy_path(monkeypatch, fakes):
    fake_boto3, fake_github = fakes
    main_mock = Mock(return_value=EXIT_OK)
    monkeypatch.setattr(cli, "main", main_mock)

    result = lambda_handler.handler({"source": "eventbridge"}, object())

    assert result == {"status": "ok"}

    fake_boto3.client.assert_called_once_with("secretsmanager", region_name="us-east-1")
    fake_boto3.client.return_value.get_secret_value.assert_called_once_with(SecretId=_SECRET_STORE)
    assert os.environ["CLICKHOUSE_PASSWORD"] == _CH_PASSWORD

    fake_github.Auth.AppAuth.assert_called_once_with(_APP_ID, _PEM)
    fake_github.GithubIntegration.assert_called_once_with(auth=fake_github.Auth.AppAuth.return_value)
    fake_github.GithubIntegration.return_value.requester.requestJsonAndCheck.assert_called_once_with(
        "POST",
        f"/app/installations/{_INSTALLATION_ID}/access_tokens",
        input={"permissions": _EXPECTED_PERMISSIONS, "repositories": _EXPECTED_REPOSITORIES},
    )
    assert os.environ["PYTORCH_GREENLIGHT_GITHUB_TOKEN"] == _TOKEN
    assert os.environ["PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS"] == "0"

    main_mock.assert_called_once_with(_EXPECTED_ARGV)


def test_handler_decodes_base64_pem(monkeypatch, fakes):
    _fake_boto3, fake_github = fakes
    monkeypatch.setattr(cli, "main", Mock(return_value=EXIT_OK))

    lambda_handler.handler({}, object())

    app_id_arg, pem_arg = fake_github.Auth.AppAuth.call_args.args
    assert app_id_arg == _APP_ID
    assert pem_arg == _PEM
    assert pem_arg == base64.b64decode(_PEM_B64).decode("utf-8")


def test_handler_already_running_returns_status(monkeypatch, fakes, caplog):
    monkeypatch.setattr(cli, "main", Mock(return_value=EXIT_ALREADY_RUNNING))

    with caplog.at_level(logging.WARNING, logger="greenlight.lambda_handler"):
        result = lambda_handler.handler({}, object())

    assert result == {"status": "already_running"}
    assert "another instance" in caplog.text


@pytest.mark.parametrize("rc", [EXIT_FAILURE, 2, 99])
def test_handler_failure_raises(monkeypatch, fakes, rc):
    monkeypatch.setattr(cli, "main", Mock(return_value=rc))

    with pytest.raises(RuntimeError, match=f"exit code {rc}"):
        lambda_handler.handler({}, object())


@pytest.mark.parametrize("missing", ["SECRET_STORE_NAME", "GITHUB_APP_ID", "GITHUB_INSTALLATION_ID"])
def test_handler_missing_env_raises(monkeypatch, fakes, missing):
    monkeypatch.delenv(missing, raising=False)
    main_mock = Mock()
    monkeypatch.setattr(cli, "main", main_mock)

    with pytest.raises(ValueError, match=missing):
        lambda_handler.handler({}, object())

    main_mock.assert_not_called()


def test_handler_missing_clickhouse_username_raises(monkeypatch, fakes):
    _fake_boto3, fake_github = fakes
    monkeypatch.delenv("CLICKHOUSE_USERNAME", raising=False)
    main_mock = Mock()
    monkeypatch.setattr(cli, "main", main_mock)

    with pytest.raises(ValueError, match="CLICKHOUSE_USERNAME"):
        lambda_handler.handler({}, object())

    fake_github.GithubIntegration.assert_not_called()
    main_mock.assert_not_called()


def test_handler_missing_clickhouse_host_and_endpoint_raises(monkeypatch, fakes):
    _fake_boto3, fake_github = fakes
    monkeypatch.delenv("CLICKHOUSE_HOST", raising=False)
    monkeypatch.delenv("CLICKHOUSE_ENDPOINT", raising=False)
    main_mock = Mock()
    monkeypatch.setattr(cli, "main", main_mock)

    with pytest.raises(ValueError, match="CLICKHOUSE_HOST or CLICKHOUSE_ENDPOINT"):
        lambda_handler.handler({}, object())

    fake_github.GithubIntegration.assert_not_called()
    main_mock.assert_not_called()


def test_handler_non_numeric_installation_id_raises(monkeypatch, fakes):
    monkeypatch.setenv("GITHUB_INSTALLATION_ID", "not-a-number")
    main_mock = Mock()
    monkeypatch.setattr(cli, "main", main_mock)

    with pytest.raises(ValueError, match="invalid literal for int"):
        lambda_handler.handler({}, object())

    main_mock.assert_not_called()


def test_handler_secret_missing_app_secret_raises(monkeypatch, fakes):
    fake_boto3, _fake_github = fakes
    secret_json = json.dumps({"CLICKHOUSE_PASSWORD": _CH_PASSWORD})
    fake_boto3.client.return_value.get_secret_value.return_value = {"SecretString": secret_json}
    main_mock = Mock()
    monkeypatch.setattr(cli, "main", main_mock)

    with pytest.raises(ValueError, match="GITHUB_APP_SECRET") as exc_info:
        lambda_handler.handler({}, object())

    assert _SECRET_STORE in str(exc_info.value)
    main_mock.assert_not_called()


def test_handler_secret_missing_clickhouse_password_raises(monkeypatch, fakes):
    fake_boto3, _fake_github = fakes
    secret_json = json.dumps({"GITHUB_APP_SECRET": _PEM_B64})
    fake_boto3.client.return_value.get_secret_value.return_value = {"SecretString": secret_json}
    main_mock = Mock()
    monkeypatch.setattr(cli, "main", main_mock)

    with pytest.raises(ValueError, match="CLICKHOUSE_PASSWORD") as exc_info:
        lambda_handler.handler({}, object())

    assert _SECRET_STORE in str(exc_info.value)
    main_mock.assert_not_called()


def test_handler_token_mint_error_propagates(monkeypatch, fakes):
    _fake_boto3, fake_github = fakes

    class _GithubError(Exception):
        pass

    fake_github.GithubException = _GithubError
    fake_github.GithubIntegration.return_value.requester.requestJsonAndCheck.side_effect = _GithubError(
        "installation token mint failed"
    )
    main_mock = Mock()
    monkeypatch.setattr(cli, "main", main_mock)

    with pytest.raises(_GithubError, match="installation token mint failed"):
        lambda_handler.handler({}, object())

    main_mock.assert_not_called()


def test_handler_token_response_missing_token_raises(monkeypatch, fakes):
    _fake_boto3, fake_github = fakes
    fake_github.GithubIntegration.return_value.requester.requestJsonAndCheck.return_value = ({}, {})
    main_mock = Mock()
    monkeypatch.setattr(cli, "main", main_mock)

    with pytest.raises(ValueError, match="installation token response"):
        lambda_handler.handler({}, object())

    main_mock.assert_not_called()


def test_handler_cli_main_error_propagates(monkeypatch, fakes):
    monkeypatch.setattr(cli, "main", Mock(side_effect=RuntimeError("cli main exploded")))

    with pytest.raises(RuntimeError, match="cli main exploded"):
        lambda_handler.handler({}, object())
