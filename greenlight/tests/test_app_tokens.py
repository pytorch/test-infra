from __future__ import annotations

import http.server
import json
import logging
import threading
from typing import TYPE_CHECKING, Any

import pytest
from github import Auth, Github, GithubException

from greenlight import app_tokens
from greenlight.app_tokens import (
    DISPATCH_TOKEN_PERMISSIONS,
    LISTING_TOKEN_PERMISSIONS,
    REPO_TOKEN_PERMISSIONS,
    AppTokens,
)
from greenlight.constants import TARGET_REPO
from greenlight.guards import IterationTimeout
from greenlight.repo_config import BUILTIN_PYTORCH, RepoConfig, RepoEntry
from greenlight.tick import RepoUnavailable

if TYPE_CHECKING:
    from collections.abc import Iterator

_INSTALLATION = 42
_MINT_URL = f"/app/installations/{_INSTALLATION}/access_tokens"
_VISION = RepoEntry("pytorch/vision", "greenlight", "gate", "write_permission", "shadow")
_AUDIO = RepoEntry("pytorch/audio", "greenlight", "gate", "merge_rules", "shadow")


def _listed(full_name: str, *, private: bool = False, branch: str = "main") -> dict[str, object]:
    return {"full_name": full_name, "private": private, "default_branch": branch}


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
        return {}, {"token": "listing" if key is None else "token-" + ",".join(key)}


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

    assert tokens.dispatch_token() == "token-test-infra"
    assert tokens.dispatch_token() == "token-test-infra"

    assert integration.mints == [{"permissions": DISPATCH_TOKEN_PERMISSIONS, "repositories": ["test-infra"]}]


def test_a_repo_token_is_minted_for_that_repo_alone_after_one_paginated_listing(installation):
    server = installation(
        [_listed(TARGET_REPO), _listed("pytorch/audio"), _listed("pytorch/other"), _listed("pytorch/vision")]
    )
    integration = _Integration()
    tokens = _tokens(integration, server)

    assert tokens.repo_token(_VISION) == "token-vision"
    assert tokens.repo_token(BUILTIN_PYTORCH) == "token-pytorch"

    assert integration.mints == [
        {"permissions": LISTING_TOKEN_PERMISSIONS},
        {"permissions": REPO_TOKEN_PERMISSIONS, "repositories": ["vision"]},
        {"permissions": REPO_TOKEN_PERMISSIONS, "repositories": ["pytorch"]},
    ]
    assert [path for path, _auth in server.requests] == [
        "/installation/repositories",
        "/installation/repositories?page=2",
    ]
    assert {auth for _path, auth in server.requests} == {"token listing"}


@pytest.mark.parametrize(
    ("listed", "reason"),
    [
        pytest.param([_listed(TARGET_REPO)], "the GitHub App is not installed on it", id="not-installed"),
        pytest.param([_listed("pytorch/vision", private=True)], "it is private", id="private"),
        pytest.param([_listed("pytorch/Vision")], "GitHub names it 'pytorch/Vision'", id="non-canonical"),
        pytest.param([_listed("pytorch/vision", branch="master")], "its default branch is 'master'", id="non-main"),
    ],
)
def test_a_repo_the_listing_refuses_gets_no_token(installation, listed, reason):
    integration = _Integration()
    tokens = _tokens(integration, installation(listed))

    with pytest.raises(RepoUnavailable, match=reason):
        tokens.repo_token(_VISION)

    assert integration.mints == [{"permissions": LISTING_TOKEN_PERMISSIONS}]


@pytest.mark.parametrize("cause", ["mint", "listing"])
def test_a_failed_listing_still_mints_the_primary_and_refuses_the_others(installation, caplog, cause):
    integration = _Integration({None: GithubException(500, {"message": "down"})} if cause == "mint" else None)
    server = installation([], status=404 if cause == "listing" else 200)
    tokens = _tokens(integration, server)

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        with pytest.raises(RepoUnavailable, match="the installation listing failed"):
            tokens.repo_token(_VISION)
        assert tokens.repo_token(BUILTIN_PYTORCH) == "token-pytorch"
        with pytest.raises(RepoUnavailable, match="the installation listing failed"):
            tokens.repo_token(_AUDIO)

    assert [mint.get("repositories") for mint in integration.mints] == [None, ["pytorch"]]
    assert "minting its token without the live checks" in caplog.text
    assert any(record.exc_info for record in caplog.records if "cannot list" in record.getMessage())


def test_a_422_mint_failure_refuses_that_repo_only(installation):
    integration = _Integration(
        {
            ("vision",): GithubException(
                422,
                {
                    "message": "There is at least one repository that does not exist or is not accessible to the "
                    "parent installation."
                },
            )
        }
    )
    tokens = _tokens(integration, installation([_listed("pytorch/vision"), _listed("pytorch/audio")]))

    with pytest.raises(RepoUnavailable, match="cannot mint its installation token: 422"):
        tokens.repo_token(_VISION)
    assert tokens.repo_token(_AUDIO) == "token-audio"


def test_an_iteration_timeout_listing_the_installation_is_never_swallowed():
    tokens = AppTokens(_Integration({None: IterationTimeout("late")}), _INSTALLATION)  # type: ignore[arg-type]

    with pytest.raises(IterationTimeout):
        tokens.repo_token(_VISION)


def test_an_iteration_timeout_minting_a_repo_token_is_never_swallowed(installation):
    tokens = _tokens(_Integration({("vision",): IterationTimeout("late")}), installation([_listed("pytorch/vision")]))

    with pytest.raises(IterationTimeout):
        tokens.repo_token(_VISION)


def test_a_repo_outside_the_installations_account_gets_no_token():
    integration = _Integration()
    tokens = AppTokens(integration, _INSTALLATION, owner="other")  # type: ignore[arg-type]

    with pytest.raises(RepoUnavailable, match="not in other"):
        tokens.repo_token(_VISION)
    assert integration.mints == []


def test_a_mint_answer_without_a_token_fails():
    integration = _Integration()
    integration.requestJsonAndCheck = lambda *_args, **_kwargs: ({}, {})  # type: ignore[method-assign]

    with pytest.raises(ValueError, match="installation token response is missing required key 'token'"):
        AppTokens(integration, _INSTALLATION).dispatch_token()  # type: ignore[arg-type]


def test_repo_token_names_lists_the_served_then_the_safety_only_repos_primary_first():
    config = RepoConfig(
        served=(_VISION, BUILTIN_PYTORCH), safety_only=((_AUDIO, "unknown key(s) ['x']"),), refused=(("x", "y"),)
    )

    assert app_tokens.repo_token_names(config) == "pytorch,vision,audio"


def test_require_key_names_the_missing_key_and_its_source():
    assert app_tokens.require_key({"a": "1"}, "a", "secret s") == "1"
    with pytest.raises(ValueError, match="secret s is missing required key 'b'"):
        app_tokens.require_key({}, "b", "secret s")
