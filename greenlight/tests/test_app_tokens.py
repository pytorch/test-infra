from __future__ import annotations

import http.server
import json
import threading
from typing import TYPE_CHECKING, Any

import pytest
from github import Auth, Github, GithubException

from greenlight import app_tokens, github_client
from greenlight.app_tokens import (
    CONTENTS_TOKEN_PERMISSIONS,
    DISPATCH_TOKEN_PERMISSIONS,
    LISTING_TOKEN_PERMISSIONS,
    REPO_TOKEN_PERMISSIONS,
    AppTokens,
)
from greenlight.constants import TARGET_REPO
from greenlight.guards import IterationTimeout
from greenlight.repo_scan import RepoIdentity, RepoUnavailable

if TYPE_CHECKING:
    from collections.abc import Iterator

_INSTALLATION = 42
_MINT_URL = f"/app/installations/{_INSTALLATION}/access_tokens"


def _listed(
    full_name: str, *, private: bool = False, branch: str = "main", archived: bool = False
) -> dict[str, object]:
    return {"full_name": full_name, "private": private, "default_branch": branch, "archived": archived}


class _Integration:
    """The integration's requester: records each token mint and answers with a token named after its scope."""

    def __init__(self, failures: dict[tuple[str, ...] | None, BaseException] | None = None) -> None:
        self.requester = self
        self.failures = failures or {}
        self.mints: list[dict[str, Any]] = []

    def requestJsonAndCheck(self, verb: str, url: str, *, input: dict[str, Any]) -> tuple[dict[str, str], Any]:
        assert (verb, url) == ("POST", _MINT_URL)
        self.mints.append(input)
        repositories = input.get("repositories")
        key = None if repositories is None else tuple(repositories)
        failure = self.failures.get(key)
        if failure is not None:
            raise failure
        if key is None:
            return {}, {"token": "listing"}
        return {}, {"token": f"{input['permissions'].get('pull_requests', 'contents')}-" + ",".join(key)}


class _Installation:
    """A local stand-in for ``GET /installation/repositories``, two repos per page."""

    def __init__(self, repos: list[dict[str, object]], *, status: int = 200) -> None:
        self.repos = repos
        self.status = status
        self.requests: list[tuple[str, str | None]] = []
        installation = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                installation.requests.append((self.path, self.headers.get("Authorization")))
                page = 2 if "page=2" in self.path else 1
                chunk = installation.repos[(page - 1) * 2 : page * 2]
                body = json.dumps({"total_count": len(installation.repos), "repositories": chunk}).encode()
                self.send_response(installation.status)
                if page == 1 and len(installation.repos) > 2:
                    self.send_header("Link", f'<{installation.url}/installation/repositories?page=2>; rel="next"')
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args: object) -> None:
                return None

        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"
        self.clients: list[Github] = []

    def build(self, token: str) -> Github:
        self.clients.append(Github(auth=Auth.Token(token), base_url=self.url, retry=None))
        return self.clients[-1]


@pytest.fixture
def installation(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    servers: list[_Installation] = []
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setenv("no_proxy", "127.0.0.1")

    def start(repos: list[dict[str, object]], *, status: int = 200) -> _Installation:
        server = _Installation(repos, status=status)
        threading.Thread(target=server.httpd.serve_forever, daemon=True).start()
        servers.append(server)
        return server

    yield start
    for server in servers:
        server.httpd.shutdown()
        server.httpd.server_close()


def _tokens(integration: _Integration, server: _Installation) -> AppTokens:
    return AppTokens(integration, _INSTALLATION, build_github=server.build)  # type: ignore[arg-type]


def test_the_dispatch_token_is_minted_once_for_test_infra_with_the_dispatch_permissions():
    integration = _Integration()
    tokens = AppTokens(integration, _INSTALLATION)  # type: ignore[arg-type]

    assert tokens.dispatch_token() == "contents-test-infra"
    assert tokens.dispatch_token() == "contents-test-infra"

    assert integration.mints == [{"permissions": DISPATCH_TOKEN_PERMISSIONS, "repositories": ["test-infra"]}]


def test_a_repo_token_is_minted_for_that_repo_alone_with_the_repo_permissions():
    integration = _Integration()
    tokens = AppTokens(integration, _INSTALLATION)  # type: ignore[arg-type]

    assert tokens.repo_token("pytorch/vision") == "write-vision"
    assert tokens.repo_token(TARGET_REPO) == "write-pytorch"

    assert integration.mints == [
        {"permissions": REPO_TOKEN_PERMISSIONS, "repositories": ["vision"]},
        {"permissions": REPO_TOKEN_PERMISSIONS, "repositories": ["pytorch"]},
    ]


def test_a_422_mint_failure_refuses_that_repo_only(caplog):
    message = "There is at least one repository that does not exist or is not accessible to the parent installation."
    integration = _Integration({("vision",): GithubException(422, {"message": message})})
    tokens = AppTokens(integration, _INSTALLATION)  # type: ignore[arg-type]

    with pytest.raises(RepoUnavailable, match="cannot mint its installation token: 422"):
        tokens.repo_token("pytorch/vision")
    assert tokens.repo_token("pytorch/audio") == "write-audio"
    assert any(record.exc_info for record in caplog.records if "cannot mint" in record.getMessage())


def test_a_rate_limit_minting_a_repo_token_is_raised_as_it_is():
    integration = _Integration({("vision",): GithubException(429, {"message": "secondary rate limit"})})

    with pytest.raises(GithubException) as excinfo:
        AppTokens(integration, _INSTALLATION).repo_token("pytorch/vision")  # type: ignore[arg-type]

    assert not isinstance(excinfo.value, RepoUnavailable)
    assert github_client.is_rate_limit_error(excinfo.value)


def test_an_iteration_timeout_minting_a_repo_token_is_never_swallowed():
    tokens = AppTokens(_Integration({("vision",): IterationTimeout("late")}), _INSTALLATION)  # type: ignore[arg-type]

    with pytest.raises(IterationTimeout):
        tokens.repo_token("pytorch/vision")


def test_a_repo_outside_the_installations_account_gets_no_token():
    integration = _Integration()
    tokens = AppTokens(integration, _INSTALLATION, owner="other")  # type: ignore[arg-type]

    with pytest.raises(RepoUnavailable, match="not in other"):
        tokens.repo_token("pytorch/vision")
    assert integration.mints == []


def test_the_installation_is_listed_once_paginated_with_the_listing_token(installation):
    server = installation(
        [
            _listed(TARGET_REPO),
            _listed("pytorch/Audio", private=True),
            _listed("pytorch/old", archived=True),
            _listed("pytorch/vision", branch="master"),
        ]
    )
    integration = _Integration()

    listing = _tokens(integration, server).installation()

    assert listing == {
        "pytorch/pytorch": RepoIdentity(TARGET_REPO, False, "main", False),
        "pytorch/audio": RepoIdentity("pytorch/Audio", True, "main", False),
        "pytorch/old": RepoIdentity("pytorch/old", False, "main", True),
        "pytorch/vision": RepoIdentity("pytorch/vision", False, "master", False),
    }
    assert integration.mints == [{"permissions": LISTING_TOKEN_PERMISSIONS}]
    assert [path for path, _auth in server.requests] == [
        "/installation/repositories",
        "/installation/repositories?page=2",
    ]
    assert {auth for _path, auth in server.requests} == {"token listing"}


def test_the_installation_listing_uses_the_builder_it_is_given(installation):
    server = installation([_listed("pytorch/vision")])
    built: list[str] = []

    def build(token: str) -> Github:
        built.append(token)
        client: Github = server.build(token)
        return client

    listing = AppTokens(_Integration(), _INSTALLATION).installation(build)  # type: ignore[arg-type]

    assert set(listing) == {"pytorch/vision"}
    assert built == ["listing"]


@pytest.mark.parametrize("status", [404, 429])
def test_a_failed_listing_is_raised_as_it_is(installation, status):
    tokens = _tokens(_Integration(), installation([], status=status))

    with pytest.raises(GithubException) as excinfo:
        tokens.installation()

    assert excinfo.value.status == status
    assert github_client.is_rate_limit_error(excinfo.value) is (status == 429)


def test_contents_tokens_share_one_mint_per_500_repos(monkeypatch):
    monkeypatch.setattr(app_tokens, "_MAX_TOKEN_REPOSITORIES", 2)
    integration = _Integration()
    tokens = AppTokens(integration, _INSTALLATION)  # type: ignore[arg-type]

    minted = tokens.contents_tokens(["pytorch/audio", "pytorch/data", "pytorch/vision"])

    assert minted == {
        "pytorch/audio": "contents-audio,data",
        "pytorch/data": "contents-audio,data",
        "pytorch/vision": "contents-vision",
    }
    assert integration.mints == [
        {"permissions": CONTENTS_TOKEN_PERMISSIONS, "repositories": ["audio", "data"]},
        {"permissions": CONTENTS_TOKEN_PERMISSIONS, "repositories": ["vision"]},
    ]
    assert tokens.contents_tokens([]) == {}


def test_a_failed_contents_mint_is_raised_as_it_is():
    integration = _Integration({("vision",): GithubException(429, {"message": "secondary rate limit"})})

    with pytest.raises(GithubException):
        AppTokens(integration, _INSTALLATION).contents_tokens(["pytorch/vision"])  # type: ignore[arg-type]


def test_the_contents_token_reads_contents_only():
    assert CONTENTS_TOKEN_PERMISSIONS == {"contents": "read"}
    assert app_tokens._MAX_TOKEN_REPOSITORIES == 500


def test_a_mint_answer_without_a_token_fails():
    integration = _Integration()
    integration.requestJsonAndCheck = lambda *_args, **_kwargs: ({}, {})  # type: ignore[method-assign]

    with pytest.raises(ValueError, match="installation token response is missing required key 'token'"):
        AppTokens(integration, _INSTALLATION).dispatch_token()  # type: ignore[arg-type]


def test_require_key_names_the_missing_key_and_its_source():
    assert app_tokens.require_key({"a": "1"}, "a", "secret s") == "1"
    with pytest.raises(ValueError, match="secret s is missing required key 'b'"):
        app_tokens.require_key({}, "b", "secret s")


class _IdentityClient:
    def __init__(self, data: dict[str, object]) -> None:
        self.requester = self
        self.data = data
        self.closed = 0

    def requestJsonAndCheck(self, verb: str, url: str) -> tuple[dict[str, str], dict[str, object]]:
        return {}, {**self.data, "url": url}

    def close(self) -> None:
        self.closed += 1


def test_env_tokens_use_the_scan_token_for_every_repo_after_its_live_checks(make_config):
    built: list[_IdentityClient] = []

    def build(_token: str) -> Any:
        built.append(_IdentityClient({"full_name": "pytorch/vision", "private": False, "default_branch": "main"}))
        return built[-1]

    tokens = app_tokens.EnvTokens(make_config(github_token="scan"), build)

    assert tokens.repo_token(_VISION) == "scan"
    assert tokens.dispatch_token() == "scan"
    assert app_tokens.EnvTokens(make_config(github_token="scan", dispatch_token="d")).dispatch_token() == "d"
    assert [client.closed for client in built] == [1]


@pytest.mark.parametrize(
    ("identity", "reason"),
    [
        pytest.param({"full_name": "pytorch/Vision"}, "GitHub names it 'pytorch/Vision'", id="case"),
        pytest.param({"private": True}, "it is private", id="private"),
        pytest.param({"default_branch": "master"}, "its default branch is 'master'", id="branch"),
    ],
)
def test_env_tokens_refuse_a_repo_failing_a_live_check(make_config, identity, reason):
    data: dict[str, object] = {"full_name": "pytorch/vision", "private": False, "default_branch": "main", **identity}
    tokens = app_tokens.EnvTokens(make_config(github_token="scan"), lambda _token: _IdentityClient(data))  # type: ignore[arg-type,return-value]

    with pytest.raises(RepoUnavailable, match=reason):
        tokens.repo_token(_VISION)


def test_env_tokens_need_the_scan_token(make_config):
    tokens = app_tokens.EnvTokens(make_config(dispatch_token="d"))

    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        tokens.dispatch_token()
    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        tokens.repo_token(_VISION)
