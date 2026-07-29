import logging

import pytest

from greenlight import github_client, plan
from greenlight.github_client import OpenPR


def test_run_with_prs_logs_count_and_one_line_per_pr(make_config, caplog):
    prs = [
        OpenPR(repo="pytorch/pytorch", number=1, author="octocat", title="fix a", url="https://example.test/1"),
        OpenPR(repo="pytorch/pytorch", number=2, author="octocat", title="fix b", url="https://example.test/2"),
    ]

    with caplog.at_level(logging.INFO, logger="greenlight"):
        plan.run(make_config(), fetch=lambda config: prs)

    messages = [record.getMessage() for record in caplog.records]
    assert any("found 2 open PR(s)" in message for message in messages)
    assert any("#1" in message and "octocat" in message and "fix a" in message for message in messages)
    assert any("#2" in message and "octocat" in message and "fix b" in message for message in messages)


def test_run_with_no_prs_logs_zero_count(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        plan.run(make_config(), fetch=lambda config: [])

    messages = [record.getMessage() for record in caplog.records]
    assert any("found 0 open PR(s)" in message for message in messages)


def test_default_fetch_without_token_raises(make_config):
    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        plan._default_fetch(make_config(github_token=None))


def test_default_fetch_with_token_builds_client_and_lists_prs(make_config, monkeypatch):
    fake_client = object()
    built_with: dict[str, object] = {}
    listed_with: dict[str, object] = {}
    expected_prs = [
        OpenPR(repo=plan.TARGET_REPO, number=1, author="octocat", title="fix", url="https://example.test/1")
    ]

    def fake_build_client(token):
        built_with["token"] = token
        return fake_client

    def fake_list_open_prs_by_authors(client, repo, authors):
        listed_with["client"] = client
        listed_with["repo"] = repo
        listed_with["authors"] = set(authors)
        return expected_prs

    monkeypatch.setattr(github_client, "build_client", fake_build_client)
    monkeypatch.setattr(github_client, "list_open_prs_by_authors", fake_list_open_prs_by_authors)

    result = plan._default_fetch(make_config(github_token="secret-token"))

    assert result is expected_prs
    assert built_with["token"] == "secret-token"
    assert listed_with["client"] is fake_client
    assert listed_with["repo"] == plan.TARGET_REPO
    assert listed_with["authors"] == plan.TRUSTED_AUTHORS
