from __future__ import annotations

import logging
import textwrap
from types import SimpleNamespace
from typing import TYPE_CHECKING, NoReturn

import pytest
from github import GithubException, UnknownObjectException

from greenlight import constants, github_client

# Imported rather than read off ``verdict``: conftest swaps ``verdict.has_eligible_author`` for a refusing
# guard in every test, while this name keeps the real function for the fake clients.
from greenlight.author_eligibility import has_eligible_author

if TYPE_CHECKING:
    from greenlight.repo_config import Safety

_REVIEWED = "b" * 40
_MERGE_RULES = textwrap.dedent(
    """
    - name: Superusers
      patterns: ["*"]
      approved_by: [CatchAll]
    - name: Docs Maintainers
      patterns: ["docs/**"]
      approved_by: [Scoped, pytorch/doc-writers]
    - name: Broken
      patterns: ["docs/{a,b}/**"]
      approved_by: [OnlyBroken]
    """
)
_UNEXPECTED_PR_READ = AssertionError("the PR was read")


class _FakeContent:
    def __init__(self, text: str) -> None:
        self.decoded_content = text.encode("utf-8")


class _FakeMember:
    def __init__(self, login: str) -> None:
        self.login = login


class _FakeTeam:
    def get_members(self) -> list[_FakeMember]:
        return [_FakeMember("TeamMember"), _FakeMember("Concealed")]


class _FakeOrg:
    def get_team_by_slug(self, slug: str) -> _FakeTeam:
        return _FakeTeam()


class _FakeLivePR:
    def __init__(
        self, head_sha: str, head_ref: str, base_ref: str, trunk: str | None, default_branch: str | None
    ) -> None:
        self.head = SimpleNamespace(sha=head_sha, ref=head_ref)
        self.base = SimpleNamespace(ref=base_ref, repo=SimpleNamespace(default_branch=default_branch))
        self.raw_data: dict[str, object] = {} if trunk is None else {"stack": {"base": {"ref": trunk}}}

    def get_files(self) -> NoReturn:
        raise AssertionError("eligibility never lists the PR's files")


class _FakeRulesClient:
    """Serves merge_rules.yaml, one team, every author's ``permission`` and PR #7 as it reads live.

    PR #7 reads at ``live_head`` with its refs, stack trunk and the repo's default branch as that read
    reports it; a ``None`` trunk is a PR in no native stack. ``pull_error`` replaces the PR read with that
    failure.
    """

    def __init__(
        self,
        *,
        merge_rules: str | Exception = _MERGE_RULES,
        pull_error: Exception | None = None,
        live_head: str = _REVIEWED,
        head_ref: str = "feature",
        base_ref: str = constants.TARGET_BRANCH,
        trunk: str | None = None,
        default_branch: str | None = constants.TARGET_BRANCH,
        permission: str = "write",
    ) -> None:
        self.merge_rules = merge_rules
        self.pull_error = pull_error
        self.live = _FakeLivePR(live_head, head_ref, base_ref, trunk, default_branch)
        self.permission = permission
        self.pull_reads = 0
        self.permission_reads: list[str] = []
        self.contents_reads = 0

    def get_repo(self, full_name_or_id: str) -> _FakeRulesClient:
        return self

    def get_contents(self, path: str) -> _FakeContent:
        self.contents_reads += 1
        if isinstance(self.merge_rules, Exception):
            raise self.merge_rules
        return _FakeContent(self.merge_rules)

    def get_pull(self, number: int) -> _FakeLivePR:
        self.pull_reads += 1
        if self.pull_error is not None:
            raise self.pull_error
        return self.live

    def get_organization(self, login: str) -> _FakeOrg:
        return _FakeOrg()

    def get_collaborator_permission(self, collaborator: str) -> str:
        self.permission_reads.append(collaborator)
        return self.permission


@pytest.fixture
def eligible(monkeypatch):
    def check(client: _FakeRulesClient, author: str | None, safety: Safety = "pytorchbot") -> bool:
        monkeypatch.setattr(github_client, "build_authz_client", lambda token: client)
        return has_eligible_author(
            "tok",
            constants.TARGET_REPO,
            7,
            _REVIEWED,
            author,
            eligibility="merge_rules",
            author_type="User",
            safety=safety,
        )

    return check


@pytest.mark.parametrize("author", ["CatchAll", "Scoped", "TeamMember"])
def test_has_eligible_author_passes_any_author_a_valid_rule_names_with_one_pr_read(eligible, author):
    client = _FakeRulesClient()

    assert eligible(client, author) is True
    assert client.pull_reads == 1


@pytest.mark.parametrize("author", ["mallory", "catchall", "OnlyBroken", None])
def test_has_eligible_author_refuses_an_author_no_valid_rule_names_without_reading_the_pr(eligible, author):
    client = _FakeRulesClient(pull_error=_UNEXPECTED_PR_READ)

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
    assert eligible(_FakeRulesClient(**live), author) is True


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
        assert eligible(_FakeRulesClient(**live), author) is False

    assert f"author {author!r} is not eligible: {reason}" in caplog.text


@pytest.mark.parametrize(
    "client",
    [
        pytest.param(_FakeRulesClient(merge_rules=UnknownObjectException(404)), id="merge-rules"),
        pytest.param(_FakeRulesClient(pull_error=GithubException(502)), id="pull"),
    ],
)
def test_has_eligible_author_raises_a_read_failure(eligible, client):
    with pytest.raises(GithubException):
        eligible(client, "CatchAll")


def test_has_eligible_author_logs_its_decision_without_naming_a_rule_or_a_team_member(eligible, caplog):
    with caplog.at_level(logging.DEBUG, logger="greenlight"):
        assert eligible(_FakeRulesClient(), "TeamMember") is True
        assert eligible(_FakeRulesClient(base_ref="release/2.9"), "Concealed") is False

    # The record job's log is public: a rule name can imply a team membership, and Concealed reaches
    # greenlight through the team alone, so only its login, never the team or rule, may appear.
    assert "merge-rule eligibility" in caplog.text
    assert not [word for word in ("Superusers", "Docs Maintainers", "doc-writers") if word in caplog.text]


@pytest.mark.parametrize("author", ["CatchAll", "Scoped"])
def test_a_gate_repo_passes_a_pr_on_main_when_main_is_the_default_branch_with_one_pr_read(eligible, author):
    client = _FakeRulesClient()

    assert eligible(client, author, "gate") is True
    assert client.pull_reads == 1


@pytest.mark.parametrize(
    "live",
    [
        pytest.param({"head_ref": "gh/scoped/1/head", "base_ref": "gh/scoped/1/base"}, id="ghstack"),
        pytest.param({"base_ref": "scoped/part-1", "trunk": constants.TARGET_BRANCH}, id="native-stack-on-main"),
        pytest.param({"base_ref": "release/2.9"}, id="release-base"),
        pytest.param({"default_branch": "trunk"}, id="main-is-not-the-default-branch"),
        pytest.param({"default_branch": None}, id="no-default-branch"),
    ],
)
def test_a_gate_repo_refuses_any_base_but_main_as_the_default_branch(eligible, caplog, live):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        assert eligible(_FakeRulesClient(**live), "CatchAll", "gate") is False

    # A gate repo has no trymerge to land a stack, so the base must be main and main the default branch.
    assert "author 'CatchAll' is not eligible: base not accepted" in caplog.text


def test_a_pytorchbot_repo_ignores_the_default_branch(eligible):
    # The default branch is read only for a gate repo; pytorchbot keeps trymerge's base rule.
    assert eligible(_FakeRulesClient(default_branch="trunk"), "CatchAll") is True


@pytest.fixture
def writer_eligible(monkeypatch):
    def check(client: _FakeRulesClient, author: str | None, author_type: str | None = "User") -> bool:
        monkeypatch.setattr(github_client, "build_authz_client", lambda token: client)
        return has_eligible_author(
            "tok",
            "pytorch/vision",
            7,
            _REVIEWED,
            author,
            eligibility="write_permission",
            author_type=author_type,
            safety="pytorchbot",
        )

    return check


@pytest.mark.parametrize("permission", ["admin", "write"])
def test_a_write_permission_author_with_write_access_is_eligible_with_one_permission_and_one_pr_read(
    writer_eligible, permission
):
    client = _FakeRulesClient(permission=permission)

    assert writer_eligible(client, "Writer") is True
    assert client.permission_reads == ["Writer"]
    assert client.pull_reads == 1
    assert client.contents_reads == 0


@pytest.mark.parametrize("permission", ["read", "none"])
def test_a_write_permission_author_without_write_access_is_refused_without_reading_the_pr(
    writer_eligible, caplog, permission
):
    client = _FakeRulesClient(permission=permission, pull_error=_UNEXPECTED_PR_READ)

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
    client = _FakeRulesClient(pull_error=_UNEXPECTED_PR_READ)

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
        assert writer_eligible(_FakeRulesClient(**live), "Writer") is False

    assert f"author 'Writer' is not eligible: {reason}" in caplog.text


def test_a_write_permission_read_failure_raises(writer_eligible):
    class _FailingPermission(_FakeRulesClient):
        def get_collaborator_permission(self, collaborator: str) -> str:
            raise GithubException(502)

    with pytest.raises(GithubException):
        writer_eligible(_FailingPermission(), "Writer")
