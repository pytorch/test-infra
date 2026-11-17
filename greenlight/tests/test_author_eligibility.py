from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import pytest
from github import GithubException, UnknownObjectException

from greenlight import constants, github_client

# Imported rather than read off ``verdict``: conftest swaps ``verdict.has_eligible_author`` for a refusing
# guard in every test, while this name keeps the real function for the fake clients.
from greenlight.author_eligibility import has_eligible_author
from tests.eligibility_fakes import REVIEWED, FakeRulesClient

if TYPE_CHECKING:
    from greenlight.repo_config import MinimumRole

_UNEXPECTED_PR_READ = AssertionError("the PR was read")


@pytest.fixture
def eligible(monkeypatch):
    def check(client: FakeRulesClient, author: str | None) -> bool:
        monkeypatch.setattr(github_client, "build_authz_client", lambda token: client)
        return has_eligible_author(
            "tok",
            constants.TARGET_REPO,
            7,
            REVIEWED,
            author,
            eligibility="merge_rules",
            minimum_role="write",
            author_type="User",
        )

    return check


@pytest.mark.parametrize("author", ["CatchAll", "Scoped", "TeamMember"])
def test_has_eligible_author_passes_any_author_a_valid_rule_names_with_one_pr_read(eligible, author):
    client = FakeRulesClient()

    assert eligible(client, author) is True
    assert client.pull_reads == 1


@pytest.mark.parametrize("author", ["mallory", "catchall", "OnlyBroken", None])
def test_has_eligible_author_refuses_an_author_no_valid_rule_names_without_reading_the_pr(eligible, author):
    client = FakeRulesClient(pull_error=_UNEXPECTED_PR_READ)

    assert eligible(client, author) is False
    assert client.pull_reads == 0


@pytest.mark.parametrize(
    "live",
    [
        pytest.param({"head_ref": "gh/scoped/1/head", "base_ref": "gh/scoped/1/base"}, id="ghstack-off-main"),
        pytest.param({"base_ref": "scoped/part-1", "trunk": constants.TARGET_BRANCH}, id="native-stack-on-main"),
        pytest.param({"trunk": "release/2.9"}, id="main-based-in-a-stack-off-main"),
    ],
)
@pytest.mark.parametrize("author", ["CatchAll", "Scoped"])
def test_has_eligible_author_passes_a_pr_on_any_base_trymerge_accepts(eligible, live, author):
    assert eligible(FakeRulesClient(**live), author) is True


@pytest.mark.parametrize(
    ("live", "reason"),
    [
        pytest.param({"live_head": "c" * 40}, "head moved", id="head-moved"),
        pytest.param({"base_ref": "release/2.9"}, "base not accepted", id="release-base"),
        pytest.param({"base_ref": "scoped/part-1", "trunk": "release/2.9"}, "base not accepted", id="stack-off-main"),
        pytest.param({"base_ref": "scoped/part-1"}, "base not accepted", id="stack-left"),
    ],
)
@pytest.mark.parametrize("author", ["CatchAll", "Scoped"])
def test_has_eligible_author_refuses_any_author_off_the_reviewed_head_or_on_a_refused_base(
    eligible, caplog, live, reason, author
):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        assert eligible(FakeRulesClient(**live), author) is False

    assert f"author {author!r} is not eligible: {reason}" in caplog.text


@pytest.mark.parametrize(
    "client",
    [
        pytest.param(FakeRulesClient(merge_rules=UnknownObjectException(404)), id="merge-rules"),
        pytest.param(FakeRulesClient(pull_error=GithubException(502)), id="pull"),
    ],
)
def test_has_eligible_author_raises_a_read_failure(eligible, client):
    with pytest.raises(GithubException):
        eligible(client, "CatchAll")


def test_has_eligible_author_logs_its_decision_without_naming_a_rule_or_a_team_member(eligible, caplog):
    with caplog.at_level(logging.DEBUG, logger="greenlight"):
        assert eligible(FakeRulesClient(), "TeamMember") is True
        assert eligible(FakeRulesClient(base_ref="release/2.9"), "Concealed") is False

    # The record job's log is public: a rule name can imply a team membership, and Concealed reaches
    # greenlight through the team alone, so only its login, never the team or rule, may appear.
    assert "merge-rule eligibility" in caplog.text
    assert not [word for word in ("Superusers", "Docs Maintainers", "doc-writers") if word in caplog.text]


@pytest.fixture
def writer_eligible(monkeypatch):
    def check(
        client: FakeRulesClient,
        author: str | None,
        author_type: str | None = "User",
        minimum_role: MinimumRole = "write",
    ) -> bool:
        monkeypatch.setattr(github_client, "build_authz_client", lambda token: client)
        return has_eligible_author(
            "tok",
            "pytorch/vision",
            7,
            REVIEWED,
            author,
            eligibility="write_permission",
            minimum_role=minimum_role,
            author_type=author_type,
        )

    return check


@pytest.mark.parametrize("permission", ["admin", "write"])
def test_a_write_permission_author_with_write_access_is_eligible_with_one_permission_and_one_pr_read(
    writer_eligible, permission
):
    client = FakeRulesClient(permission=permission)

    assert writer_eligible(client, "Writer") is True
    assert client.permission_reads == ["Writer"]
    assert client.pull_reads == 1
    assert client.contents_reads == 0
    assert client.requester.urls == []


def test_a_maintain_role_author_is_eligible_with_one_raw_permission_read_and_one_pr_read(writer_eligible, caplog):
    client = FakeRulesClient(maintain=True, permission="write")

    with caplog.at_level(logging.INFO, logger="greenlight"):
        assert writer_eligible(client, "Maintainer", minimum_role="maintain") is True

    assert client.requester.urls == ["/repos/pytorch/vision/collaborators/Maintainer/permission"]
    assert client.permission_reads == []
    assert client.pull_reads == 1
    assert "maintain-permission eligibility on pytorch/vision#7: author 'Maintainer' is eligible" in caplog.text


def test_a_writer_without_the_maintain_role_is_refused_on_a_maintain_repo_without_reading_the_pr(
    writer_eligible, caplog
):
    client = FakeRulesClient(maintain=False, permission="write", pull_error=_UNEXPECTED_PR_READ)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        assert writer_eligible(client, "Writer", minimum_role="maintain") is False

    assert "author 'Writer' is not eligible: no maintain permission" in caplog.text


@pytest.mark.parametrize("permission", ["read", "none"])
def test_a_write_permission_author_without_write_access_is_refused_without_reading_the_pr(
    writer_eligible, caplog, permission
):
    client = FakeRulesClient(permission=permission, pull_error=_UNEXPECTED_PR_READ)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        assert writer_eligible(client, "Reader") is False

    assert "write-permission eligibility on pytorch/vision#7: author 'Reader' is not eligible: no write permission" in (
        caplog.text
    )


@pytest.mark.parametrize(
    ("author", "author_type", "reads"),
    [
        pytest.param("renovate", "Bot", [], id="bot-typed"),
        pytest.param("someone", None, [], id="no-type"),
        pytest.param(None, "User", [], id="no-author"),
        pytest.param("pytorchgreenlight", "User", ["pytorchgreenlight"], id="greenlight-itself"),
    ],
)
def test_a_write_permission_author_greenlight_excludes_is_refused_without_reading_the_pr(
    writer_eligible, author, author_type, reads
):
    client = FakeRulesClient(pull_error=_UNEXPECTED_PR_READ)

    assert writer_eligible(client, author, author_type) is False
    assert client.permission_reads == reads


@pytest.mark.parametrize(
    ("live", "reason"),
    [
        pytest.param({"live_head": "c" * 40}, "head moved", id="head-moved"),
        pytest.param({"base_ref": "release/2.9"}, "base not accepted", id="release-base"),
    ],
)
def test_a_write_permission_author_off_the_reviewed_head_or_on_a_refused_base_is_refused(
    writer_eligible, caplog, live, reason
):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        assert writer_eligible(FakeRulesClient(**live), "Writer") is False

    assert f"author 'Writer' is not eligible: {reason}" in caplog.text


def test_a_write_permission_read_failure_raises(writer_eligible):
    class _FailingPermission(FakeRulesClient):
        def get_collaborator_permission(self, collaborator: str) -> str:
            raise GithubException(502)

    with pytest.raises(GithubException):
        writer_eligible(_FailingPermission(), "Writer")


@pytest.mark.parametrize("eligibility", ["write", "Merge_Rules", ""])
def test_an_unknown_eligibility_fails_closed_before_any_read(monkeypatch, eligibility):
    client = FakeRulesClient(pull_error=_UNEXPECTED_PR_READ)
    monkeypatch.setattr(github_client, "build_authz_client", lambda token: client)

    with pytest.raises(AssertionError, match="Expected code to be unreachable"):
        has_eligible_author(
            "tok",
            "pytorch/vision",
            7,
            REVIEWED,
            "Writer",
            eligibility=eligibility,
            minimum_role="write",
            author_type="User",
        )

    assert (client.permission_reads, client.contents_reads, client.requester.urls) == ([], 0, [])
