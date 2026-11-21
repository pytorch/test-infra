from __future__ import annotations

import dataclasses
import gzip
import json
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, NoReturn, cast

import pytest
from github import GithubException

from greenlight import (
    comment_format,
    constants,
    gate_rules,
    github_client,
    land_approval,
    repo_config,
    verdict,
    verdict_input,
)

# has_eligible_author is imported rather than read off verdict: conftest swaps verdict's attribute for
# a refusing guard in every test, while this name keeps the real function for the fake clients.
from greenlight.approvals import GREENLIGHT_LOGIN
from greenlight.author_eligibility import has_eligible_author
from greenlight.verdict import VerdictRequest
from greenlight.verdict import _repo_entry as _REAL_REPO_ENTRY
from tests.test_author_eligibility import _REVIEWED, _FakeRulesClient

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from github.Commit import Commit

    from greenlight.config import Config

_FIXED = datetime(2026, 7, 30, 12, 0, tzinfo=UTC)
_HASH = "a" * 64
_BOT = GREENLIGHT_LOGIN
_VERSION = "2026-07-30 12:00:00.000"
_VERSION_COMPACT = "20260730T120000_000"
_EMIT_ID = "e" * 32

# The eligibility fake installed below answers True for _TRUSTED_AUTHOR alone, and _FakePR defaults
# to that author, so every LAND test approves unless it names another author or asks for shadow.
_TRUSTED_AUTHOR = "albanD"
_SHADOW_AUTHOR = "some-newcomer"


@pytest.fixture(autouse=True)
def eligibility(set_eligible):
    return set_eligible(_TRUSTED_AUTHOR)


class _Recorder:
    def __init__(self) -> None:
        self.events: list[str] = []


class _FakeEmit:
    def __init__(self, rec: _Recorder) -> None:
        self._rec = rec
        self.row_gzip: bytes | None = None
        self.key: str | None = None

    def __call__(self, row_gzip: bytes, key: str) -> None:
        self._rec.events.append("emit")
        self.row_gzip = row_gzip
        self.key = key


class _FakeUser:
    def __init__(self, login: str | None, type: str = "User") -> None:
        self.login = login
        self.type = type


class _FakeReview:
    def __init__(self, id: int, login: str | None, state: str, rec: _Recorder, commit_id: str | None = None) -> None:
        self.id = id
        self.user = _FakeUser(login) if login is not None else None
        self.state = state
        self.commit_id = commit_id
        self._rec = rec
        self.dismissed_with: str | None = None

    def dismiss(self, message: str) -> None:
        self.dismissed_with = message
        self._rec.events.append(f"dismiss:{self.id}")


class _FakeCommit:
    def __init__(self, sha: str) -> None:
        self.sha = sha


class _FakeHead:
    def __init__(self, sha: str, ref: str = "feature") -> None:
        self.sha = sha
        self.ref = ref


class _FakeBaseRepo:
    def __init__(self, default_branch: str) -> None:
        self.default_branch = default_branch


class _FakeRef:
    def __init__(self, ref: str, default_branch: str = constants.TARGET_BRANCH) -> None:
        self.ref = ref
        self.repo = _FakeBaseRepo(default_branch)


class _FakeComment:
    def __init__(self, body: str, login: str | None, rec: _Recorder) -> None:
        self.body = body
        self.user = _FakeUser(login) if login is not None else None
        self._rec = rec

    def edit(self, body: str) -> None:
        self.body = body
        self._rec.events.append("edit")


class _FakeFile:
    def __init__(self, filename: str) -> None:
        self.filename = filename


class _FakeLabel:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakePR:
    def __init__(
        self,
        head_sha: str,
        rec: _Recorder,
        reviews: list[_FakeReview] | None = None,
        issue_comments: list[_FakeComment] | None = None,
        author: str | None = _TRUSTED_AUTHOR,
        author_type: str = "User",
    ) -> None:
        self.head = _FakeHead(head_sha)
        self.base = _FakeRef(constants.TARGET_BRANCH)
        self.raw_data: dict[str, object] = {}
        self.user = _FakeUser(author, author_type) if author is not None else None
        self.labels: list[_FakeLabel] = []
        self.state = "open"
        self._rec = rec
        self._reviews = reviews or []
        self._issue_comments = issue_comments or []
        self.created_reviews: list[tuple[str, str]] = []
        self.review_commits: list[str] = []
        self.comments: list[str] = []

    def create_review(self, *, commit: Commit, body: str, event: str) -> _FakeReview:
        self.created_reviews.append((event, body))
        self.review_commits.append(commit.sha)
        self._rec.events.append(f"review:{event}")
        return _FakeReview(1000 + len(self.created_reviews), _BOT, "APPROVED", self._rec, commit.sha)

    def create_issue_comment(self, body: str) -> object:
        self.comments.append(body)
        self._rec.events.append("comment")
        return object()

    def get_issue_comments(self) -> list[_FakeComment]:
        return self._issue_comments

    def get_reviews(self) -> list[_FakeReview]:
        return self._reviews

    def get_files(self) -> list[_FakeFile]:
        return []

    def add_to_labels(self, *labels: str) -> None: ...

    def remove_from_labels(self, label: str) -> None: ...


class _FakeRepo:
    def __init__(self, pr: _FakePR) -> None:
        self._pr = pr
        self.get_pull_numbers: list[int] = []

    def get_pull(self, number: int) -> _FakePR:
        self.get_pull_numbers.append(number)
        return self._pr

    def get_commit(self, sha: str) -> Commit:
        return cast("Commit", _FakeCommit(sha))


class _FakeGithub:
    def __init__(self, repo: _FakeRepo) -> None:
        self._repo = repo
        self.get_repo_names: list[str] = []

    def get_repo(self, full_name_or_id: str) -> _FakeRepo:
        self.get_repo_names.append(full_name_or_id)
        return self._repo


def _write_verdict(tmp_path: Path, **payload: object) -> str:
    path = tmp_path / "verdict.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


def _decode(row_gzip: bytes | None) -> dict[str, object]:
    assert row_gzip is not None
    data: dict[str, object] = json.loads(gzip.decompress(row_gzip))
    return data


def _boom_build_github(token: str) -> NoReturn:
    raise AssertionError("build_github should not be called")


def _boom_emit(row_gzip: bytes, key: str) -> NoReturn:
    raise AssertionError("emit should not be called")


def test_full_land_emits_payload_then_approves(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("headsha", rec)
    repo = _FakeRepo(pr)
    gh = _FakeGithub(repo)
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=7, head_sha="headsha", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )
    captured: dict[str, object] = {}

    def build_github(token):
        captured["token"] = token
        return gh

    verdict.run(
        req,
        make_config(github_token="tok"),
        build_github=build_github,
        emit=emit,
        now=lambda: _FIXED,
        new_emit_id=lambda: _EMIT_ID,
    )

    assert captured["token"] == "tok"
    # The PR read, the reviewed head's commit, and the re-read after the approval.
    assert gh.get_repo_names == ["pytorch/pytorch", "pytorch/pytorch", "pytorch/pytorch"]
    assert repo.get_pull_numbers == [7, 7]
    assert pr.review_commits == ["headsha"]
    # pytorch/pytorch delegates its status comment to Dr. CI, so only the merge gate acts.
    assert rec.events == ["emit", "review:APPROVE"]
    assert pr.comments == []
    assert _decode(emit.row_gzip) == {
        "repo": "pytorch/pytorch",
        "pr_number": 7,
        "head_sha": "headsha",
        "status": "LAND",
        "reason": "clean",
        "eval_hash": _HASH,
        "message": "LGTM",
        "eval_job": "",
        "agent_job": "",
        "version": _VERSION,
        "run_id": 0,
        "emit_id": _EMIT_ID,
        "shadow": False,
    }
    assert emit.key == f"greenlight_pr_state/pytorch/pytorch/7/{_VERSION_COMPACT}-{_EMIT_ID}.json.gz"
    event, body = pr.created_reviews[0]
    assert event == "APPROVE"
    assert body == land_approval.LAND_REVIEW_BODY == ""


def test_full_land_on_non_delegating_repo_approves_then_comments(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("headsha", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="pytorch/vision", pr_number=7, head_sha="headsha", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # Everywhere except the delegating repos, greenlight still owns the status comment.
    assert rec.events == ["emit", "review:APPROVE", "comment"]
    comment = pr.comments[0]
    assert comment_format.COMMENT_MARKER in comment
    assert f"**{comment_format.LAND_HEADLINE}**" in comment
    assert "LGTM" in comment


def test_full_no_land_on_delegating_repo_dismisses_without_commenting(make_config, tmp_path, caplog):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    pr = _FakePR("h", rec, reviews=reviews)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="unclear_intent", message="needs work")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=8, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict.run(
            req,
            make_config(github_token="tok"),
            build_github=lambda t: gh,
            emit=emit,
            now=lambda: _FIXED,
        )

    # The dismissal is the merge gate and must survive the comment gate untouched.
    assert rec.events == ["dismiss:1", "emit"]
    assert reviews[0].dismissed_with == land_approval.SUPERSEDED_MESSAGE
    assert pr.comments == []
    assert any("skipping upsert" in record.getMessage() for record in caplog.records)


def test_marker_on_delegating_repo_emits_row_without_commenting(make_config):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    req = VerdictRequest(
        repo="pytorch/pytorch",
        pr_number=12,
        head_sha="h",
        status="AI_REVIEW_STARTED",
        bot_login=_BOT,
        eval_job_url="https://run",
        run_id=123,
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit"]
    assert pr.comments == []


def test_full_land_scrubs_secret_in_both_row_and_comment(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    secret = "ghp_0123456789abcdefghijABCDEFGHIJ0123456789"
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message=f"LGTM token {secret}")
    req = VerdictRequest(repo="r", pr_number=30, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # Both sinks receive the scrubbed message: the ClickHouse row and the GitHub comment.
    payload = _decode(emit.row_gzip)
    assert payload["message"] == "LGTM token [REDACTED]"
    assert secret not in str(payload["message"])
    body = pr.comments[0]
    assert "[REDACTED]" in body
    assert secret not in body


def test_full_land_with_an_outline_message_comments_the_html_list_and_scrubs_it(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    secret = "ghp_0123456789abcdefghijABCDEFGHIJ0123456789"
    message = "\n".join(["- Scope: one guard plus its test", f"  - the token {secret} is in the diff", "- Risk: low"])
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message=message)
    req = VerdictRequest(
        repo="pytorch/vision", pr_number=31, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit", "review:APPROVE", "comment"]
    # The row stores the outline verbatim once scrubbed; the comment renders it as the HTML list.
    assert _decode(emit.row_gzip)["message"] == message.replace(secret, "[REDACTED]")
    body = pr.comments[0]
    assert body.startswith(comment_format.COMMENT_MARKER)
    assert "<ul><li><b>Scope: one guard plus its test</b><ul>" in body
    assert "<li>the token [REDACTED] is in the diff</li>" in body
    assert "```" not in body
    assert secret not in body
    assert "reason: `clean`" in body
    assert body.endswith("</details>")


def test_emit_payload_is_single_gzipped_jsoneachrow_line(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="ok")
    req = VerdictRequest(repo="o/r", pr_number=3, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert emit.row_gzip is not None
    raw = gzip.decompress(emit.row_gzip).decode("utf-8")
    assert raw.endswith("\n")
    assert raw.count("\n") == 1  # exactly one JSONEachRow line
    obj = json.loads(raw)
    assert list(obj.keys()) == [
        "repo",
        "pr_number",
        "head_sha",
        "status",
        "reason",
        "eval_hash",
        "message",
        "eval_job",
        "agent_job",
        "version",
        "run_id",
        "emit_id",
        "shadow",
    ]
    assert isinstance(obj["pr_number"], int)
    assert isinstance(obj["version"], str)
    assert obj["version"] == _VERSION


def test_emit_payload_keeps_one_jsoneachrow_line_for_a_multiline_message(make_config, tmp_path):
    # The outline format made a multi-line message the normal case, and one unescaped break
    # reaching the row splits it into two JSONEachRow lines. The replicator's positional SELECT *
    # then raises on the halves and swallows it into errors.gen_errors: the row never lands and
    # nothing alerts. Every shape a reader might treat as a break is here, plus a NUL.
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    separators = chr(0x2028) + chr(0x2029)  # by code point, so this source carries neither
    message = f"- Scope\n  - one file\r\n  - a lone \r return{separators}and a nul\x00here"
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message=message)
    req = VerdictRequest(repo="o/r", pr_number=4, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert emit.row_gzip is not None
    raw = gzip.decompress(emit.row_gzip).decode("utf-8")
    assert raw.endswith("\n")
    assert raw.count("\n") == 1  # exactly one JSONEachRow line
    assert "\r" not in raw
    # Escaped on the way out and identical on the way back: the row keeps the outline it stores.
    assert json.loads(raw)["message"] == message


def test_verdict_emitted_row_is_byte_stable(make_config):
    # Golden characterization: the verdict emit path (now routed through state_emit.emit_row)
    # MUST keep producing this exact JSONEachRow line -- field order, separators, values, and the
    # trailing newline are the positional S3 -> ClickHouse replicator contract.
    rec = _Recorder()
    emit = _FakeEmit(rec)
    req = VerdictRequest(repo="pytorch/pytorch", pr_number=9, head_sha="h", status="CANCELLED")

    verdict.run(
        req,
        make_config(github_token="tok"),
        build_github=_boom_build_github,
        emit=emit,
        now=lambda: _FIXED,
        new_emit_id=lambda: _EMIT_ID,
    )

    assert emit.row_gzip is not None
    raw = gzip.decompress(emit.row_gzip).decode("utf-8")
    assert raw == (
        '{"repo":"pytorch/pytorch","pr_number":9,"head_sha":"h","status":"CANCELLED",'
        '"reason":"","eval_hash":"","message":"","eval_job":"","agent_job":"",'
        f'"version":"{_VERSION}","run_id":0,"emit_id":"{_EMIT_ID}","shadow":false}}\n'
    )


@pytest.mark.parametrize(("run_id", "expected"), [(123, 123), (None, 0)])
def test_emit_payload_stores_run_id_coercing_none_to_zero(make_config, run_id, expected):
    # A JSON null into the Int64 run_id column would fail the replicator, so None becomes 0.
    rec = _Recorder()
    emit = _FakeEmit(rec)
    req = VerdictRequest(repo="r", pr_number=1, head_sha="h", status="CANCELLED", run_id=run_id)

    verdict.run(req, make_config(github_token="tok"), build_github=_boom_build_github, emit=emit, now=lambda: _FIXED)

    assert _decode(emit.row_gzip)["run_id"] == expected


def test_two_emits_get_distinct_emit_ids(make_config):
    rows: list[dict[str, object]] = []

    def collect(row_gzip: bytes, key: str) -> None:
        rows.append(_decode(row_gzip))

    req = VerdictRequest(repo="r", pr_number=1, head_sha="h", status="CANCELLED", run_id=5)
    for _ in range(2):
        verdict.run(
            req,
            make_config(github_token="tok"),
            build_github=_boom_build_github,
            emit=collect,
            now=lambda: _FIXED,
        )

    first, second = (str(row["emit_id"]) for row in rows)
    assert first != second
    assert len(first) == len(second) == 32


def test_verdict_run_rejects_scan_only_dispatched_status(make_config):
    # AI_REVIEW_DISPATCHED is scan-only (written via state_emit's S3 path). The verdict CLI must
    # reject it outright -- emitting neither a row nor the misleading "did not complete" comment.
    req = VerdictRequest(repo="r", pr_number=1, head_sha="h", status="AI_REVIEW_DISPATCHED")
    with pytest.raises(ValueError, match="unknown verdict status 'AI_REVIEW_DISPATCHED'"):
        verdict.run(req, make_config(github_token="tok"), build_github=_boom_build_github, emit=_boom_emit)
    assert "AI_REVIEW_DISPATCHED" not in verdict.VERDICT_STATUSES


def test_full_no_land_dismisses_then_emits_payload_then_comments(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [
        _FakeReview(1, _BOT, "APPROVED", rec),
        _FakeReview(2, "alice", "APPROVED", rec),
        _FakeReview(3, _BOT, "COMMENTED", rec),
    ]
    pr = _FakePR("headsha", rec, reviews=reviews)
    gh = _FakeGithub(_FakeRepo(pr))
    secret = "ghp_0123456789abcdefghijABCDEFGHIJ0123456789"
    vf = _write_verdict(
        tmp_path,
        status="NO_LAND",
        reason="scope_too_large",
        message=f"@pytorchbot please split; token {secret}",
    )
    req = VerdictRequest(
        repo="pytorch/vision",
        pr_number=8,
        head_sha="headsha",
        eval_hash=_HASH,
        verdict_file=vf,
        eval_job_url="https://eval-run",
        bot_login=_BOT,
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["dismiss:1", "emit", "comment"]
    assert reviews[0].dismissed_with == land_approval.SUPERSEDED_MESSAGE
    payload = _decode(emit.row_gzip)
    # The stored message is scrubbed of secrets but otherwise verbatim -- not @-defanged like the
    # comment; the row keeps the readable text with only the credential replaced.
    assert payload["message"] == "@pytorchbot please split; token [REDACTED]"
    assert secret not in str(payload["message"])
    assert payload["status"] == "NO_LAND"
    assert payload["reason"] == "scope_too_large"
    assert payload["eval_job"] == "https://eval-run"
    assert emit.key == f"greenlight_pr_state/pytorch/vision/8/{_VERSION_COMPACT}-{payload['emit_id']}.json.gz"
    # The upserted comment is defanged: marker + headline + <details> why, @ neutralized, fenced.
    body = pr.comments[0]
    assert body.startswith(comment_format.COMMENT_MARKER)
    assert f"**{comment_format.NO_LAND_HEADLINE}**" in body
    assert "reason: `scope_too_large`" in body
    assert "[Inference job](https://eval-run)" in body
    assert "@pytorchbot" not in body
    assert "pytorchbot" in body
    assert comment_format._ZERO_WIDTH_SPACE in body
    assert "```" in body
    # The comment path also receives the scrubbed text: the secret never reaches GitHub.
    assert "[REDACTED]" in body
    assert secret not in body


def test_full_no_land_without_prior_approval_still_comments(make_config, tmp_path, caplog):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec, reviews=[_FakeReview(1, "alice", "APPROVED", rec)])
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="unclear_intent", message="needs work")
    req = VerdictRequest(repo="r", pr_number=1, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit", "comment"]
    assert pr.comments[0].startswith(comment_format.COMMENT_MARKER)
    assert f"**{comment_format.NO_LAND_HEADLINE}**" in pr.comments[0]
    assert "reason: `unclear_intent`" in pr.comments[0]
    assert any("no prior greenlight approval to dismiss" in record.getMessage() for record in caplog.records)


def test_full_land_upserts_existing_marked_comment(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    existing = _FakeComment(f"{comment_format.COMMENT_MARKER}\nprevious NO_LAND text", _BOT, rec)
    pr = _FakePR("h", rec, issue_comments=[existing])
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(repo="r", pr_number=1, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # LAND approves with the one-liner, then edits its own comment in place (no new create).
    assert rec.events == ["emit", "review:APPROVE", "edit"]
    assert pr.created_reviews[0] == ("APPROVE", land_approval.LAND_REVIEW_BODY)
    assert pr.review_commits == [req.head_sha]
    assert pr.comments == []
    assert comment_format.COMMENT_MARKER in existing.body
    assert f"**{comment_format.LAND_HEADLINE}**" in existing.body
    assert "LGTM" in existing.body


def test_full_no_land_upserts_existing_marked_comment(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    existing = _FakeComment(f"{comment_format.COMMENT_MARKER}\nprevious LAND text", _BOT, rec)
    pr = _FakePR("h", rec, reviews=reviews, issue_comments=[existing])
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="unclear_intent", message="needs work")
    req = VerdictRequest(repo="r", pr_number=1, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # NO_LAND dismisses the prior approval, then edits the same comment in place.
    assert rec.events == ["dismiss:1", "emit", "edit"]
    assert pr.comments == []
    assert f"**{comment_format.NO_LAND_HEADLINE}**" in existing.body
    assert "needs work" in existing.body


def test_mismatched_head_land_still_records_and_approves(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("actual-sha", rec)  # live head differs from the input head_sha
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="r", pr_number=1, head_sha="expected-sha", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # A moved head no longer aborts: the row is emitted and the PR is approved.
    assert rec.events == ["emit", "review:APPROVE", "comment"]
    assert _decode(emit.row_gzip)["head_sha"] == "expected-sha"  # the INPUT head_sha is stored verbatim
    assert pr.created_reviews[0][0] == "APPROVE"


def test_land_whose_lookup_refuses_the_moved_head_is_shadow_and_approves_nothing(make_config, tmp_path, monkeypatch):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    pr = _ReviewBoomPR("pushed-after-review", rec, reviews=reviews)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=62, head_sha="reviewed", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    # Stands in for the lookup, which answers only while the live head is the one it was handed.
    def eligible_on_the_live_head_only(
        token: str,
        repo: str,
        pr_number: int,
        head_sha: str,
        author: str | None,
        *,
        eligibility: str,
        author_type: str | None,
        strict_base: bool,
    ) -> bool:
        return head_sha == pr.head.sha

    monkeypatch.setattr(verdict, "has_eligible_author", eligible_on_the_live_head_only)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert pr.created_reviews == []
    assert rec.events == ["dismiss:1", "emit"]
    assert _decode(emit.row_gzip)["shadow"] is True


def test_mismatched_head_no_land_still_records_and_comments(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    pr = _FakePR("actual-sha", rec, reviews=reviews)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="scope_too_large", message="split")
    req = VerdictRequest(
        repo="r", pr_number=1, head_sha="expected-sha", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["dismiss:1", "emit", "comment"]
    assert _decode(emit.row_gzip)["head_sha"] == "expected-sha"  # the INPUT head_sha is stored verbatim


def test_marker_cancelled_emits_payload_only(make_config):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    req = VerdictRequest(repo="pytorch/pytorch", pr_number=9, head_sha="h", status="CANCELLED")

    verdict.run(
        req,
        make_config(github_token="tok"),
        build_github=_boom_build_github,
        emit=emit,
        now=lambda: _FIXED,
        new_emit_id=lambda: _EMIT_ID,
    )

    assert rec.events == ["emit"]
    assert _decode(emit.row_gzip) == {
        "repo": "pytorch/pytorch",
        "pr_number": 9,
        "head_sha": "h",
        "status": "CANCELLED",
        "reason": "",
        "eval_hash": "",
        "message": "",
        "eval_job": "",
        "agent_job": "",
        "version": _VERSION,
        "run_id": 0,
        "emit_id": _EMIT_ID,
        "shadow": False,
    }
    assert emit.key == f"greenlight_pr_state/pytorch/pytorch/9/{_VERSION_COMPACT}-{_EMIT_ID}.json.gz"


def test_marker_failed_stores_eval_hash_verbatim_without_validation(make_config):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    req = VerdictRequest(repo="r", pr_number=2, head_sha="h", status="FAILED", eval_hash="not-a-valid-hash")

    verdict.run(req, make_config(github_token="tok"), build_github=_boom_build_github, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit"]
    # eval_hash is stored verbatim for markers -- no hex validation.
    payload = _decode(emit.row_gzip)
    assert payload["eval_hash"] == "not-a-valid-hash"
    assert payload["status"] == "FAILED"


def test_marker_ai_review_started_emits_payload_only(make_config):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    req = VerdictRequest(repo="pytorch/pytorch", pr_number=11, head_sha="h", status="AI_REVIEW_STARTED")

    verdict.run(
        req,
        make_config(github_token="tok"),
        build_github=_boom_build_github,
        emit=emit,
        now=lambda: _FIXED,
        new_emit_id=lambda: _EMIT_ID,
    )

    assert rec.events == ["emit"]
    assert _decode(emit.row_gzip) == {
        "repo": "pytorch/pytorch",
        "pr_number": 11,
        "head_sha": "h",
        "status": "AI_REVIEW_STARTED",
        "reason": "",
        "eval_hash": "",
        "message": "",
        "eval_job": "",
        "agent_job": "",
        "version": _VERSION,
        "run_id": 0,
        "emit_id": _EMIT_ID,
        "shadow": False,
    }
    assert emit.key == f"greenlight_pr_state/pytorch/pytorch/11/{_VERSION_COMPACT}-{_EMIT_ID}.json.gz"


def test_marker_ai_review_started_with_bot_login_emits_row_then_upserts_reviewing_comment(make_config):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    captured: dict[str, object] = {}
    req = VerdictRequest(
        repo="pytorch/vision",
        pr_number=12,
        head_sha="h",
        status="AI_REVIEW_STARTED",
        bot_login=_BOT,
        eval_job_url="https://run",
        run_id=123,
    )

    def build_github(token):
        captured["token"] = token
        return gh

    verdict.run(req, make_config(github_token="tok"), build_github=build_github, emit=emit, now=lambda: _FIXED)

    # The row is authoritative and emitted first; the reviewing comment is the follow-up.
    assert rec.events == ["emit", "comment"]
    assert captured["token"] == "tok"
    assert gh.get_repo_names == ["pytorch/vision"]
    body = pr.comments[0]
    assert body.startswith(comment_format.COMMENT_MARKER)
    assert github_client.format_run_marker(123) in body
    assert f"**{comment_format.REVIEWING_HEADLINE}**" in body
    assert "Green Light is reviewing this PR." in body
    assert "[Inference job](https://run)" in body


def test_marker_ai_review_started_prefers_agent_job_url(make_config):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    req = VerdictRequest(
        repo="r",
        pr_number=12,
        head_sha="h",
        status="AI_REVIEW_STARTED",
        bot_login=_BOT,
        agent_job_url="https://agent",
        eval_job_url="https://eval",
        run_id=1,
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert "[Inference job](https://agent)" in pr.comments[0]


def test_marker_with_bot_login_but_no_token_is_row_only(make_config):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    req = VerdictRequest(repo="r", pr_number=16, head_sha="h", status="AI_REVIEW_STARTED", bot_login=_BOT, run_id=1)

    verdict.run(req, make_config(github_token=None), build_github=_boom_build_github, emit=emit, now=lambda: _FIXED)

    # No token means no comment path is attempted: build_github must not be called.
    assert rec.events == ["emit"]


def test_marker_ai_review_started_comment_failure_is_best_effort(make_config, caplog):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    req = VerdictRequest(repo="r", pr_number=13, head_sha="h", status="AI_REVIEW_STARTED", bot_login=_BOT, run_id=1)

    def boom_build(token):
        raise RuntimeError("gh exploded")

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"), build_github=boom_build, emit=emit, now=lambda: _FIXED)

    # The row survives a comment-post failure; the error is logged, not raised.
    assert rec.events == ["emit"]
    assert any("Failed to upsert verdict comment" in record.getMessage() for record in caplog.records)


def test_marker_cancelled_with_bot_login_upserts_did_not_complete_comment(make_config):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    req = VerdictRequest(
        repo="r",
        pr_number=14,
        head_sha="h",
        status="CANCELLED",
        bot_login=_BOT,
        eval_job_url="https://run",
        run_id=7,
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit", "comment"]
    body = pr.comments[0]
    assert f"**{comment_format.INCOMPLETE_HEADLINE}**" in body
    assert "reason: `cancelled`" in body
    assert github_client.format_run_marker(7) in body
    assert "[Inference job](https://run)" in body


def test_marker_failed_with_bot_login_upserts_did_not_complete_comment(make_config):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    req = VerdictRequest(
        repo="r", pr_number=15, head_sha="h", status="FAILED", bot_login=_BOT, eval_job_url="https://run", run_id=8
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit", "comment"]
    body = pr.comments[0]
    assert f"**{comment_format.INCOMPLETE_HEADLINE}**" in body
    assert "reason: `failed`" in body


def test_full_land_comment_includes_run_stamp(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="r", pr_number=17, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT, run_id=99
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert github_client.format_run_marker(99) in pr.comments[0]


def test_full_land_approves_with_empty_body(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(repo="r", pr_number=18, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert pr.created_reviews == [("APPROVE", "")]


def test_full_land_skips_reapproval_when_already_approved(make_config, tmp_path, caplog):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec, "h")]
    pr = _FakePR("h", rec, reviews=reviews)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(repo="r", pr_number=40, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # A live greenlight approval already stands on the reviewed head: no second APPROVE review is posted
    # (the prior one is left intact), yet the canonical comment is still upserted and the skip is logged.
    assert pr.created_reviews == []
    assert reviews[0].dismissed_with is None
    assert rec.events == ["emit", "comment"]
    assert pr.comments[0].startswith(comment_format.COMMENT_MARKER)
    assert f"**{comment_format.LAND_HEADLINE}**" in pr.comments[0]
    assert "LGTM" in pr.comments[0]
    assert any("skipping re-approval" in record.getMessage() for record in caplog.records)


def test_full_land_reapproves_when_prior_bot_approval_dismissed(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec, reviews=[_FakeReview(1, _BOT, "DISMISSED", rec)])
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(repo="r", pr_number=41, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # A prior greenlight approval that was dismissed is not live, so LAND re-approves.
    assert pr.created_reviews == [("APPROVE", "")]
    assert rec.events == ["emit", "review:APPROVE", "comment"]


def test_full_land_approves_when_only_other_author_approved(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec, reviews=[_FakeReview(1, "alice", "APPROVED", rec)])
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(repo="r", pr_number=42, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # A human's approval is not greenlight's own, so LAND still posts greenlight's approval.
    assert pr.created_reviews == [("APPROVE", "")]
    assert rec.events == ["emit", "review:APPROVE", "comment"]


def test_full_land_approves_when_only_bot_commented_review(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec, reviews=[_FakeReview(1, _BOT, "COMMENTED", rec)])
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(repo="r", pr_number=43, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # A COMMENTED review from greenlight is not an approval, so LAND posts one.
    assert pr.created_reviews == [("APPROVE", "")]
    assert rec.events == ["emit", "review:APPROVE", "comment"]


class _CommentBoomPR(_FakePR):
    """A PR whose issue-comment create always fails, to prove the cosmetic write is best-effort."""

    def create_issue_comment(self, body: str) -> object:
        raise RuntimeError("comment 5xx")


class _ReviewBoomPR(_FakePR):
    """A PR whose approving review always fails, to prove the merge-gate write stays fatal."""

    def create_review(self, *, commit: Commit, body: str, event: str) -> _FakeReview:
        raise RuntimeError("review 5xx")


def test_full_land_comment_failure_is_best_effort(make_config, tmp_path, caplog):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _CommentBoomPR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(repo="r", pr_number=20, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # The APPROVE review posted (merge gate) and the row emitted; the failed comment did not raise.
    assert rec.events == ["emit", "review:APPROVE"]
    assert pr.created_reviews == [("APPROVE", "")]
    assert emit.row_gzip is not None
    assert any("Failed to upsert verdict comment" in record.getMessage() for record in caplog.records)


def test_full_land_post_review_failure_is_fatal(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _ReviewBoomPR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(repo="r", pr_number=21, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    with pytest.raises(RuntimeError, match="review 5xx"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # The approving review is the merge gate: its failure must propagate, not be swallowed.
    assert rec.events == ["emit"]
    assert pr.created_reviews == []


def test_shadow_land_posts_no_approval(make_config, tmp_path, caplog):
    # THE load-bearing invariant of shadow mode. pytorch/pytorch's merge_rules.yaml gives the
    # "Greenlight Review Bot" rule patterns ['*'], so one greenlight approval authorizes a merge of
    # any path in the repo. A shadow evaluation must never post one.
    rec = _Recorder()
    emit = _FakeEmit(rec)
    # _ReviewBoomPR raises from create_review, so a regressed gate explodes here instead of
    # failing quietly on an equality check.
    pr = _ReviewBoomPR("h", rec, author=_SHADOW_AUTHOR)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=50, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert pr.created_reviews == []
    assert rec.events == ["emit"]
    assert _decode(emit.row_gzip)["shadow"] is True
    assert any("withholding approval" in record.getMessage() for record in caplog.records)


@pytest.mark.parametrize(
    ("requested_shadow", "author"),
    [
        pytest.param(False, _SHADOW_AUTHOR, id="derived-only"),
        pytest.param(True, _TRUSTED_AUTHOR, id="requested-only"),
        pytest.param(True, _SHADOW_AUTHOR, id="both"),
        pytest.param(False, None, id="unidentified-author"),
    ],
)
def test_land_withholds_approval_and_stamps_row_when_either_source_says_shadow(
    make_config, tmp_path, requested_shadow, author
):
    # The requested value and the freshly-fetched author are derived independently and OR'd. The
    # row follows the same OR: one that claimed authority while the approval was withheld would
    # render a LAND in Dr. CI that no review backs.
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _ReviewBoomPR("h", rec, author=author)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="pytorch/pytorch",
        pr_number=51,
        head_sha="h",
        eval_hash=_HASH,
        verdict_file=vf,
        bot_login=_BOT,
        shadow=requested_shadow,
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert pr.created_reviews == []
    assert rec.events == ["emit"]
    assert _decode(emit.row_gzip)["shadow"] is True


def test_non_shadow_land_approves_and_stamps_the_row_authoritative(make_config, tmp_path, eligibility):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec, author=_TRUSTED_AUTHOR)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=52, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # Neither source says shadow, so the approval path is exactly what it was before shadow mode.
    assert pr.created_reviews == [("APPROVE", "")]
    assert rec.events == ["emit", "review:APPROVE"]
    assert _decode(emit.row_gzip)["shadow"] is False
    assert eligibility.calls == [("tok", "pytorch/pytorch", 52, "h", _TRUSTED_AUTHOR)]


def test_shadow_land_dismisses_the_prior_approval_a_demoted_author_still_holds(make_config, tmp_path):
    # The demotion path end to end. Withholding a new approval does not take back the one this
    # author collected while trusted, and a live greenlight approval satisfies the wildcard
    # merge_rules rule on its own -- so shadow must dismiss it, making the invariant absolute:
    # a shadow PR never has a live greenlight approval.
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    pr = _ReviewBoomPR("h", rec, reviews=reviews, author=_SHADOW_AUTHOR)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=56, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["dismiss:1", "emit"]
    assert reviews[0].dismissed_with == land_approval.SUPERSEDED_MESSAGE
    assert pr.created_reviews == []
    assert _decode(emit.row_gzip)["shadow"] is True


def test_shadow_land_leaves_a_third_party_approval_alone(make_config, tmp_path):
    # The dismissal is scoped to greenlight's own approvals by bot_login; a human reviewer's
    # approval is not greenlight's authority to revoke.
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, "alice", "APPROVED", rec)]
    pr = _ReviewBoomPR("h", rec, reviews=reviews, author=_SHADOW_AUTHOR)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=57, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit"]
    assert reviews[0].dismissed_with is None


def test_shadow_no_land_still_dismisses_prior_approval(make_config, tmp_path):
    # The dismissal is idempotent and covers demotion: an author who collected a live greenlight
    # approval while trusted and is evaluated as shadow after leaving the set.
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    pr = _FakePR("h", rec, reviews=reviews, author=_SHADOW_AUTHOR)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="unclear_intent", message="needs work")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=53, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["dismiss:1", "emit"]
    assert reviews[0].dismissed_with == land_approval.SUPERSEDED_MESSAGE
    assert _decode(emit.row_gzip)["shadow"] is True


def test_shadow_request_never_resolves_eligibility(make_config, tmp_path, eligibility):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _ReviewBoomPR("h", rec, author=_TRUSTED_AUTHOR)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="m")
    req = VerdictRequest(
        repo="pytorch/pytorch",
        pr_number=58,
        head_sha="h",
        eval_hash=_HASH,
        verdict_file=vf,
        bot_login=_BOT,
        shadow=True,
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert eligibility.calls == []
    assert rec.events == ["emit"]
    assert _decode(emit.row_gzip)["shadow"] is True


def test_no_land_dismisses_before_a_failing_eligibility_lookup_and_records_nothing(make_config, tmp_path, monkeypatch):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    pr = _FakePR("h", rec, reviews=reviews)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="unclear_intent", message="needs work")
    req = VerdictRequest(
        repo="pytorch/vision", pr_number=59, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    def failing_lookup(
        token: str,
        repo: str,
        pr_number: int,
        head_sha: str,
        author: str | None,
        *,
        eligibility: str,
        author_type: str | None,
        strict_base: bool,
    ) -> NoReturn:
        rec.events.append("lookup")
        raise RuntimeError("merge rules unreadable")

    monkeypatch.setattr(verdict, "has_eligible_author", failing_lookup)

    with pytest.raises(RuntimeError, match="merge rules unreadable"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["dismiss:1", "lookup"]
    assert emit.row_gzip is None


@pytest.mark.parametrize(
    "requested_shadow",
    [pytest.param(False, id="authoritative"), pytest.param(True, id="shadow")],
)
def test_marker_ignores_pr_author_and_honours_requested_shadow(make_config, requested_shadow):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec, author=_SHADOW_AUTHOR)
    gh = _FakeGithub(_FakeRepo(pr))
    req = VerdictRequest(
        repo="pytorch/vision",
        pr_number=54,
        head_sha="h",
        status="AI_REVIEW_STARTED",
        bot_login=_BOT,
        run_id=1,
        shadow=requested_shadow,
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # The comment path fetched the PR, so an untrusted author was right there to be read -- and the
    # stamped value still follows the request rather than the author. A shadow marker posts no comment.
    assert rec.events == (["emit"] if requested_shadow else ["emit", "comment"])
    assert _decode(emit.row_gzip)["shadow"] is requested_shadow


@pytest.mark.parametrize("status", ["AI_REVIEW_STARTED", "CANCELLED", "FAILED"])
def test_marker_emits_requested_shadow_without_fetching_the_pr(make_config, status):
    # The marker path must stay token-independent: both jobs that reach it mint the App token with
    # continue-on-error, and fail-closed derivation from a failed author lookup would hide a
    # trusted author's in-flight marker from the merge gate -- a WAIT, then a DENY.
    rec = _Recorder()
    emit = _FakeEmit(rec)
    req = VerdictRequest(repo="pytorch/pytorch", pr_number=55, head_sha="h", status=status, shadow=True)

    verdict.run(req, make_config(github_token="tok"), build_github=_boom_build_github, emit=emit, now=lambda: _FIXED)

    # _boom_build_github raises if called: no client is built, so no PR and no author are fetched.
    assert rec.events == ["emit"]
    assert _decode(emit.row_gzip)["shadow"] is True


def test_full_no_land_comment_failure_is_best_effort_and_still_dismisses(make_config, tmp_path, caplog):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    pr = _CommentBoomPR("h", rec, reviews=reviews)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="unclear_intent", message="needs work")
    req = VerdictRequest(repo="r", pr_number=22, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # The dismissal (security action) ran and the row emitted; the failed comment did not raise.
    assert rec.events == ["dismiss:1", "emit"]
    assert reviews[0].dismissed_with == land_approval.SUPERSEDED_MESSAGE
    assert emit.row_gzip is not None
    assert any("Failed to upsert verdict comment" in record.getMessage() for record in caplog.records)


def test_dry_run_full_is_offline(make_config, tmp_path, caplog):
    rec = _Recorder()
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="m")
    req = VerdictRequest(
        repo="pytorch/pytorch",
        pr_number=3,
        head_sha="h",
        eval_hash=_HASH,
        verdict_file=vf,
        dry_run=True,
        bot_login=_BOT,
    )

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict.run(
            req,
            make_config(github_token="tok"),
            build_github=_boom_build_github,
            emit=_boom_emit,
            now=lambda: _FIXED,
        )

    assert rec.events == []
    assert any("[dry-run]" in record.getMessage() for record in caplog.records)


def test_dry_run_marker_makes_no_calls_with_default_seams(make_config, caplog):
    req = VerdictRequest(repo="r", pr_number=4, head_sha="h", status="CANCELLED", dry_run=True)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"))

    assert any("[dry-run]" in record.getMessage() for record in caplog.records)


def test_full_rejects_reason_not_in_allowlist(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="LAND", reason="looks_good", message="m")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash=_HASH, verdict_file=vf)

    with pytest.raises(ValueError, match="not an allowed verdict reason"):
        verdict.run(
            req, make_config(github_token="tok"), build_github=_boom_build_github, emit=_boom_emit, now=lambda: _FIXED
        )


def test_full_rejects_a_land_carrying_another_reason(make_config, tmp_path):
    # The record job is the layer that matters: the Stop hook that rejects the same pairing runs in
    # the untrusted review job, and the row this raise prevents is what the merge gate reads. The
    # request is otherwise complete, so the reason pairing is the only thing refusing it.
    vf = _write_verdict(tmp_path, status="LAND", reason="not_trivial", message="m")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    with pytest.raises(ValueError, match="must carry reason"):
        verdict.run(
            req, make_config(github_token="tok"), build_github=_boom_build_github, emit=_boom_emit, now=lambda: _FIXED
        )


def test_full_rejects_empty_message(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="   ")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash=_HASH, verdict_file=vf)

    with pytest.raises(ValueError, match="non-empty message"):
        verdict.run(
            req, make_config(github_token="tok"), build_github=_boom_build_github, emit=_boom_emit, now=lambda: _FIXED
        )


def test_full_rejects_missing_message_key(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="LAND", reason="clean")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash=_HASH, verdict_file=vf)

    with pytest.raises(ValueError, match="non-empty message"):
        verdict.run(
            req, make_config(github_token="tok"), build_github=_boom_build_github, emit=_boom_emit, now=lambda: _FIXED
        )


def test_no_land_without_bot_login_raises(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="scope_too_large", message="m")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash=_HASH, verdict_file=vf)

    with pytest.raises(ValueError, match="LAND/NO_LAND requires --bot-login"):
        verdict.run(
            req, make_config(github_token="tok"), build_github=_boom_build_github, emit=_boom_emit, now=lambda: _FIXED
        )


def test_land_without_bot_login_raises(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="m")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash=_HASH, verdict_file=vf)

    with pytest.raises(ValueError, match="LAND/NO_LAND requires --bot-login"):
        verdict.run(
            req, make_config(github_token="tok"), build_github=_boom_build_github, emit=_boom_emit, now=lambda: _FIXED
        )


@pytest.mark.parametrize("good", ["greenlight-app[bot]", "pytorch-greenlight[bot]", "a[bot]"])
def test_terminal_accepts_app_shaped_bot_login(make_config, tmp_path, good):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="unclear_intent", message="needs work")
    req = VerdictRequest(repo="r", pr_number=1, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=good)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit", "comment"]


@pytest.mark.parametrize("bad", ["[bot]", "greenlight", "greenlight-app"])
def test_terminal_rejects_malformed_bot_login_shape(make_config, tmp_path, bad):
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="scope_too_large", message="m")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=bad)

    with pytest.raises(ValueError, match="must be a GitHub App login"):
        verdict.run(
            req, make_config(github_token="tok"), build_github=_boom_build_github, emit=_boom_emit, now=lambda: _FIXED
        )


def test_bot_login_empty_and_malformed_raise_distinct_messages(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="unclear_intent", message="m")

    def run_with(login: str) -> None:
        req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=login)
        verdict.run(
            req, make_config(github_token="tok"), build_github=_boom_build_github, emit=_boom_emit, now=lambda: _FIXED
        )

    with pytest.raises(ValueError, match="requires --bot-login") as empty_err:
        run_with("")
    with pytest.raises(ValueError, match="must be a GitHub App login") as malformed_err:
        run_with("[bot]")

    assert str(empty_err.value) != str(malformed_err.value)


@pytest.mark.parametrize("bot_login", ["", "[bot]", "greenlight"])
def test_marker_status_ignores_bot_login_shape(make_config, bot_login):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    req = VerdictRequest(repo="r", pr_number=9, head_sha="h", status="CANCELLED", bot_login=bot_login)

    verdict.run(req, make_config(github_token=None), build_github=_boom_build_github, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit"]


def test_full_invalid_eval_hash_rejected_before_github(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="m")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash="short", verdict_file=vf)

    with pytest.raises(ValueError, match="eval_hash"):
        verdict.run(
            req, make_config(github_token="tok"), build_github=_boom_build_github, emit=_boom_emit, now=lambda: _FIXED
        )


def test_full_missing_github_token_raises(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="m")
    req = VerdictRequest(repo="r", pr_number=6, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        verdict.run(
            req, make_config(github_token=None), build_github=_boom_build_github, emit=_boom_emit, now=lambda: _FIXED
        )


def test_emit_errors_are_not_swallowed(make_config, tmp_path):
    rec = _Recorder()
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="m")
    req = VerdictRequest(repo="r", pr_number=7, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    def raising_emit(row_gzip: bytes, key: str) -> NoReturn:
        raise RuntimeError("emit boom")

    with pytest.raises(RuntimeError, match="emit boom"):
        verdict.run(
            req, make_config(github_token="tok"), build_github=lambda t: gh, emit=raising_emit, now=lambda: _FIXED
        )

    assert pr.created_reviews == []  # emit failed before the post


def test_utcnow_is_timezone_aware_utc():
    assert verdict._utcnow().tzinfo is UTC


def test_default_emit_writes_row_and_key_files(tmp_path, monkeypatch):
    row_path = tmp_path / "row.json.gz"
    key_path = tmp_path / "key.txt"
    monkeypatch.setattr(verdict, "_ROW_PATH", str(row_path))
    monkeypatch.setattr(verdict, "_KEY_PATH", str(key_path))

    verdict._default_emit(b"gzip-bytes", "greenlight_pr_state/o/r/1/x.json.gz")

    assert row_path.read_bytes() == b"gzip-bytes"
    assert key_path.read_text(encoding="utf-8") == "greenlight_pr_state/o/r/1/x.json.gz"


def test_resolve_cli_status_overrides_file(tmp_path):
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="r", message="m")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", status="LAND", verdict_file=vf)

    assert verdict_input._resolve_verdict(req) == ("LAND", "r", "m")


def test_resolve_status_from_file_is_normalized(tmp_path):
    vf = _write_verdict(tmp_path, status="land", reason="r", message="m")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=vf)

    assert verdict_input._resolve_verdict(req) == ("LAND", "r", "m")


def test_resolve_cli_marker_needs_no_file():
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", status="cancelled")

    assert verdict_input._resolve_verdict(req) == ("CANCELLED", "", "")


def test_resolve_cli_marker_ignores_a_supplied_file(tmp_path):
    # The CLI marker short-circuits before the file is opened, so an unreadable path is harmless.
    missing = str(tmp_path / "nope.json")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", status="CANCELLED", verdict_file=missing)

    assert verdict_input._resolve_verdict(req) == ("CANCELLED", "", "")


def test_resolve_file_marker_drops_reason_and_message(tmp_path):
    vf = _write_verdict(tmp_path, status="FAILED", reason="ignored", message="ignored")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=vf)

    assert verdict_input._resolve_verdict(req) == ("FAILED", "", "")


def test_resolve_full_status_without_file_raises():
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", status="LAND")

    with pytest.raises(ValueError, match="requires --verdict-file"):
        verdict_input._resolve_verdict(req)


def test_resolve_no_status_anywhere_raises():
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h")

    with pytest.raises(ValueError, match="verdict status is required"):
        verdict_input._resolve_verdict(req)


def test_resolve_unknown_status_raises(tmp_path):
    vf = _write_verdict(tmp_path, status="BOGUS", reason="r", message="m")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=vf)

    with pytest.raises(ValueError, match="unknown verdict status"):
        verdict_input._resolve_verdict(req)


def test_resolve_rejects_scan_only_dispatched_status():
    # AI_REVIEW_DISPATCHED is scan-only: it lives in IN_FLIGHT_STATUSES for decide() but must
    # never resolve through this command.
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", status="AI_REVIEW_DISPATCHED")

    with pytest.raises(ValueError, match="unknown verdict status 'AI_REVIEW_DISPATCHED'"):
        verdict_input._resolve_verdict(req)

    assert "AI_REVIEW_DISPATCHED" not in verdict_input._MARKER_STATUSES


def test_load_bad_json_raises(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("{not valid", encoding="utf-8")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=str(path))

    with pytest.raises(ValueError, match="not valid JSON"):
        verdict_input._resolve_verdict(req)


def test_load_missing_file_raises(tmp_path):
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=str(tmp_path / "nope.json"))

    with pytest.raises(ValueError, match="cannot read verdict file"):
        verdict_input._resolve_verdict(req)


def test_load_non_object_json_raises(tmp_path):
    path = tmp_path / "arr.json"
    path.write_text("[1, 2, 3]", encoding="utf-8")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=str(path))

    with pytest.raises(ValueError, match="must contain a JSON object"):
        verdict_input._resolve_verdict(req)


def test_load_non_string_reason_raises(tmp_path):
    path = tmp_path / "v.json"
    path.write_text(json.dumps({"status": "LAND", "reason": 123, "message": "m"}), encoding="utf-8")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=str(path))

    with pytest.raises(ValueError, match="field 'reason' must be a string"):
        verdict_input._resolve_verdict(req)


def test_load_non_string_status_raises(tmp_path):
    path = tmp_path / "v.json"
    path.write_text(json.dumps({"status": 5, "reason": "r", "message": "m"}), encoding="utf-8")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=str(path))

    with pytest.raises(ValueError, match="field 'status' must be a string"):
        verdict_input._resolve_verdict(req)


def test_load_verdict_file_returns_the_parsed_document(tmp_path):
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")

    doc = verdict_input._load_verdict_file(vf)

    assert (doc.status, doc.reason, doc.message) == ("LAND", "clean", "LGTM")


def test_load_verdict_file_defaults_absent_fields(tmp_path):
    # An absent reason/message reads as empty and is rejected later by the validators; an absent
    # status is None so the CLI --status can still supply it.
    path = tmp_path / "v.json"
    path.write_text("{}", encoding="utf-8")

    doc = verdict_input._load_verdict_file(str(path))

    assert (doc.status, doc.reason, doc.message) == (None, "", "")


def test_validate_eval_hash_accepts_64_lowercase_hex():
    verdict_input._validate_eval_hash("0123456789abcdef" * 4)


@pytest.mark.parametrize("bad", ["", "abc", "A" * 64, "g" * 64, "a" * 63, "a" * 65])
def test_validate_eval_hash_rejects(bad):
    with pytest.raises(ValueError, match="eval_hash"):
        verdict_input._validate_eval_hash(bad)


@pytest.mark.parametrize("reason", sorted(verdict.ALLOWED_REASONS))
def test_validate_reason_accepts_every_canonical_reason(reason: str) -> None:
    verdict_input._validate_reason("NO_LAND", reason)


@pytest.mark.parametrize("bad", ["", "looks_good", "CLEAN"])
def test_validate_reason_rejects(bad):
    with pytest.raises(ValueError, match="not an allowed verdict reason"):
        verdict_input._validate_reason("NO_LAND", bad)


@pytest.mark.parametrize("reason", sorted(verdict.ALLOWED_REASONS - {constants.LAND_REASON}))
def test_validate_reason_rejects_every_other_reason_beside_land(reason: str) -> None:
    # Every reason but `clean` names a reason not to land, and the pytorch-side land guard gates on
    # the recorded status alone, so a LAND carrying one authorizes exactly the merge it objects to.
    # The same reason under NO_LAND must stay acceptable: the guard is the pairing, not the code.
    with pytest.raises(ValueError, match="must carry reason"):
        verdict_input._validate_reason("LAND", reason)
    verdict_input._validate_reason("NO_LAND", reason)


def test_validate_reason_accepts_the_land_reason_on_both_statuses() -> None:
    verdict_input._validate_reason("LAND", constants.LAND_REASON)
    verdict_input._validate_reason("NO_LAND", constants.LAND_REASON)


def test_validate_message_accepts_non_blank():
    verdict_input._validate_message("needs work")


@pytest.mark.parametrize("bad", ["", "   ", "\n\t"])
def test_validate_message_rejects_blank(bad):
    with pytest.raises(ValueError, match="non-empty message"):
        verdict_input._validate_message(bad)


class _RecordingLabelPR(_FakePR):
    """A PR that keeps the labels written to it and records each write call, to observe the verdict's labels."""

    def __init__(
        self,
        head_sha: str,
        rec: _Recorder,
        labels: tuple[str, ...] = (),
        *,
        reviews: list[_FakeReview] | None = None,
        author: str | None = _TRUSTED_AUTHOR,
        label_error: Exception | None = None,
    ) -> None:
        super().__init__(head_sha, rec, reviews=reviews, author=author)
        self.labels = [_FakeLabel(name) for name in labels]
        self._label_error = label_error

    def add_to_labels(self, *labels: str) -> None:
        self._rec.events.append(f"label+:{','.join(labels)}")
        if self._label_error is not None:
            raise self._label_error
        self.labels.extend(_FakeLabel(name) for name in labels)

    def remove_from_labels(self, label: str) -> None:
        self._rec.events.append(f"label-:{label}")
        if self._label_error is not None:
            raise self._label_error
        self.labels = [held for held in self.labels if held.name != label]

    def label_names(self) -> list[str]:
        return [label.name for label in self.labels]


_VERDICTS = [pytest.param("LAND", "clean", id="land"), pytest.param("NO_LAND", "unclear_intent", id="no-land")]


def test_an_authoritative_land_leaves_gl_approved_as_the_prs_only_greenlight_label(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _RecordingLabelPR("h", rec, ("module: nn", "GL/human", "GL/superseded"))
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=70, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit", "review:APPROVE", "label-:GL/human", "label-:GL/superseded", "label+:GL/approved"]
    assert pr.label_names() == ["module: nn", "GL/approved"]
    assert _decode(emit.row_gzip)["shadow"] is False


def test_an_authoritative_no_land_leaves_gl_human_as_the_prs_only_greenlight_label(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    pr = _RecordingLabelPR("h", rec, ("GL/approved", "GL/superseded"), reviews=reviews)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="unclear_intent", message="needs work")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=71, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["dismiss:1", "emit", "label-:GL/approved", "label-:GL/superseded", "label+:GL/human"]
    assert pr.label_names() == ["GL/human"]
    assert _decode(emit.row_gzip)["shadow"] is False


def test_a_land_greenlight_had_already_approved_still_gets_its_label(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _RecordingLabelPR("h", rec, reviews=[_FakeReview(1, _BOT, "APPROVED", rec, "h")])
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=72, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit", "label+:GL/approved"]
    assert pr.label_names() == ["GL/approved"]


def test_a_verdict_whose_label_is_already_the_prs_only_greenlight_label_writes_none(make_config, tmp_path):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _RecordingLabelPR("h", rec, ("GL/approved", "module: nn"))
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=73, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit", "review:APPROVE"]
    assert pr.label_names() == ["GL/approved", "module: nn"]


@pytest.mark.parametrize(
    ("status", "reason", "review_state", "expected"),
    [
        pytest.param(
            "LAND",
            "clean",
            "DISMISSED",
            ["emit", "review:APPROVE", "label-:GL/superseded", "label+:GL/approved", "comment"],
            id="land",
        ),
        pytest.param(
            "NO_LAND",
            "unclear_intent",
            "APPROVED",
            ["dismiss:1", "emit", "label-:GL/superseded", "label+:GL/human", "comment"],
            id="no-land",
        ),
    ],
)
def test_the_verdict_labels_after_its_merge_gate_write_and_before_its_comment(
    make_config, tmp_path, status, reason, review_state, expected
):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _RecordingLabelPR("h", rec, ("GL/superseded",), reviews=[_FakeReview(1, _BOT, review_state, rec)])
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status=status, reason=reason, message="m")
    req = VerdictRequest(
        repo="pytorch/vision", pr_number=74, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == expected


@pytest.mark.parametrize(("status", "reason"), _VERDICTS)
@pytest.mark.parametrize(
    ("requested_shadow", "author"),
    [
        pytest.param(False, _SHADOW_AUTHOR, id="record-time-downgrade"),
        pytest.param(True, _TRUSTED_AUTHOR, id="requested"),
    ],
)
def test_a_shadow_verdict_writes_no_label(make_config, tmp_path, status, reason, requested_shadow, author):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _RecordingLabelPR("h", rec, ("GL/superseded",), author=author)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status=status, reason=reason, message="m")
    req = VerdictRequest(
        repo="pytorch/pytorch",
        pr_number=75,
        head_sha="h",
        eval_hash=_HASH,
        verdict_file=vf,
        bot_login=_BOT,
        shadow=requested_shadow,
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit"]
    assert pr.label_names() == ["GL/superseded"]
    assert _decode(emit.row_gzip)["shadow"] is True


@pytest.mark.parametrize(("status", "reason"), _VERDICTS)
def test_a_dry_run_verdict_writes_no_label(make_config, tmp_path, status, reason):
    rec = _Recorder()
    pr = _RecordingLabelPR("h", rec, ("GL/superseded",))
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status=status, reason=reason, message="m")
    req = VerdictRequest(
        repo="pytorch/pytorch",
        pr_number=76,
        head_sha="h",
        eval_hash=_HASH,
        verdict_file=vf,
        bot_login=_BOT,
        dry_run=True,
    )

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=_boom_emit, now=lambda: _FIXED)

    assert rec.events == []
    assert gh.get_repo_names == []
    assert pr.label_names() == ["GL/superseded"]


@pytest.mark.parametrize(
    ("status", "reason", "expected"),
    [
        pytest.param("LAND", "clean", ["emit", "review:APPROVE"], id="land"),
        pytest.param("NO_LAND", "unclear_intent", ["emit"], id="no-land"),
    ],
)
def test_a_verdict_on_a_pr_that_moved_off_the_reviewed_head_leaves_its_labels_to_the_scan(
    make_config, tmp_path, caplog, status, reason, expected
):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _RecordingLabelPR("pushed", rec, ("GL/superseded",))
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status=status, reason=reason, message="m")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=77, head_sha="reviewed", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == expected
    assert pr.label_names() == ["GL/superseded"]
    assert "PR #77 moved off the reviewed head reviewed; the scan labels it" in caplog.text


@pytest.mark.parametrize("reverted", ["Reverted", "reverted"])
@pytest.mark.parametrize(("status", "reason"), _VERDICTS)
def test_a_verdict_on_a_reverted_pr_leaves_its_labels_to_the_scan(
    make_config, tmp_path, caplog, status, reason, reverted
):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _RecordingLabelPR("h", rec, (reverted, "GL/superseded"))
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status=status, reason=reason, message="m")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=78, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert [event for event in rec.events if event.startswith("label")] == []
    assert pr.label_names() == [reverted, "GL/superseded"]
    assert "PR #78 is reverted; the scan labels it" in caplog.text


@pytest.mark.parametrize(("status", "reason"), _VERDICTS)
def test_a_verdict_on_a_closed_pr_records_and_leaves_its_labels_alone(make_config, tmp_path, caplog, status, reason):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _RecordingLabelPR("h", rec, ("GL/superseded",))
    pr.state = "closed"
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status=status, reason=reason, message="m")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=81, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert [event for event in rec.events if event.startswith("label")] == []
    assert pr.label_names() == ["GL/superseded"]
    assert _decode(emit.row_gzip)["status"] == status
    assert "PR #81 is closed; its labels stay as they are" in caplog.text


@pytest.mark.parametrize(
    ("status", "reason", "labels", "expected"),
    [
        pytest.param("LAND", "clean", (), ["emit", "label+:GL/approved", "comment"], id="add-fails"),
        pytest.param(
            "NO_LAND",
            "unclear_intent",
            ("GL/approved",),
            ["dismiss:1", "emit", "label-:GL/approved", "comment"],
            id="remove-fails",
        ),
    ],
)
def test_a_failed_label_write_is_logged_and_the_verdict_still_records_and_comments(
    make_config, tmp_path, caplog, status, reason, labels, expected
):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec, "h")]
    error = GithubException(502, {"message": "Server Error"})
    pr = _RecordingLabelPR("h", rec, labels, reviews=reviews, label_error=error)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status=status, reason=reason, message="m")
    req = VerdictRequest(
        repo="pytorch/vision", pr_number=79, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == expected
    assert pr.label_names() == list(labels)
    assert _decode(emit.row_gzip)["status"] == status
    assert any(
        record.exc_info is not None and f"failed to label the {status} verdict on PR #79" in record.getMessage()
        for record in caplog.records
    )


@pytest.mark.parametrize("status", ["AI_REVIEW_STARTED", "CANCELLED", "FAILED"])
def test_a_marker_leaves_the_labels_alone(make_config, status):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _RecordingLabelPR("h", rec, ("GL/approved",))
    gh = _FakeGithub(_FakeRepo(pr))
    req = VerdictRequest(repo="pytorch/vision", pr_number=80, head_sha="h", status=status, bot_login=_BOT, run_id=1)

    verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit", "comment"]
    assert pr.label_names() == ["GL/approved"]


def _record_land(
    make_config: Callable[..., Config],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    client: _FakeRulesClient,
    rec: _Recorder,
    emit: _FakeEmit,
) -> _FakePR:
    monkeypatch.setattr(verdict, "has_eligible_author", has_eligible_author)
    monkeypatch.setattr(github_client, "build_authz_client", lambda token: client)
    pr = _FakePR(_REVIEWED, rec, reviews=[_FakeReview(1, _BOT, "APPROVED", rec)], author="CatchAll")
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo=constants.TARGET_REPO, pr_number=7, head_sha=_REVIEWED, eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )
    verdict.run(
        req,
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=emit,
        now=lambda: _FIXED,
    )
    return pr


@pytest.mark.parametrize(
    "live",
    [
        pytest.param({"live_head": "c" * 40}, id="head-moved"),
        pytest.param({"base_ref": "release/2.9"}, id="refused-base"),
    ],
)
def test_a_catch_all_authors_land_off_the_reviewed_head_or_on_a_refused_base_is_shadow(
    make_config, tmp_path, monkeypatch, live
):
    rec = _Recorder()
    emit = _FakeEmit(rec)

    pr = _record_land(make_config, tmp_path, monkeypatch, _FakeRulesClient(**live), rec, emit)

    assert _decode(emit.row_gzip)["shadow"] is True
    assert pr.created_reviews == []
    assert "dismiss:1" in rec.events


def test_a_record_time_pr_read_failure_fails_the_verdict_and_writes_no_row(make_config, tmp_path, monkeypatch):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    client = _FakeRulesClient(pull_error=GithubException(502))

    with pytest.raises(GithubException):
        _record_land(make_config, tmp_path, monkeypatch, client, rec, emit)

    assert client.pull_reads == 1
    assert emit.row_gzip is None
    assert rec.events == []


def _vision_entry(**fields: str) -> repo_config.RepoEntry:
    base = {"status_comment": "greenlight", "safety": "gate", "eligibility": "merge_rules", "mode": "active"}
    return repo_config.RepoEntry("pytorch/vision", **{**base, **fields})  # type: ignore[arg-type]


def _land(
    tmp_path: Path, *, repo: str = "pytorch/vision", status: str = "LAND", reason: str = "clean"
) -> VerdictRequest:
    vf = _write_verdict(tmp_path, status=status, reason=reason, message="LGTM")
    return VerdictRequest(repo=repo, pr_number=70, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)


@pytest.mark.parametrize(
    ("entry", "served"),
    [
        pytest.param(_vision_entry(mode="shadow"), True, id="shadow-mode"),
        pytest.param(_vision_entry(mode="off"), True, id="off-mode"),
        pytest.param(_vision_entry(), False, id="safety-only"),
    ],
)
def test_land_on_a_repo_not_served_and_active_is_shadow_with_no_lookup_and_no_comment(
    make_config, tmp_path, set_repo_entry, eligibility, entry, served
):
    set_repo_entry("pytorch/vision", entry, served=served)
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec, author=_TRUSTED_AUTHOR)

    verdict.run(
        _land(tmp_path),
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=emit,
        now=lambda: _FIXED,
    )

    assert pr.created_reviews == []
    assert rec.events == ["emit"]
    assert _decode(emit.row_gzip)["shadow"] is True
    assert eligibility.calls == []


def test_land_on_an_active_repo_resolves_its_configured_eligibility(make_config, tmp_path, eligibility):
    rec = _Recorder()
    pr = _FakePR("h", rec, author=_TRUSTED_AUTHOR)

    verdict.run(
        _land(tmp_path),
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=_FakeEmit(rec),
        now=lambda: _FIXED,
    )

    assert eligibility.calls == [("tok", "pytorch/vision", 70, "h", _TRUSTED_AUTHOR)]
    assert eligibility.eligibilities == ["merge_rules"]
    assert rec.events == ["emit", "review:APPROVE", "comment"]


@pytest.mark.parametrize(
    ("author", "author_type", "expected_type"),
    [
        pytest.param(_TRUSTED_AUTHOR, "User", "User", id="user"),
        pytest.param(_TRUSTED_AUTHOR, "Bot", "Bot", id="bot"),
        pytest.param(None, "User", None, id="no-author"),
    ],
)
def test_land_on_a_write_permission_repo_hands_the_lookup_the_authors_account_type(
    make_config, tmp_path, set_repo_entry, eligibility, author, author_type, expected_type
):
    set_repo_entry("pytorch/vision", _vision_entry(eligibility="write_permission"))
    rec = _Recorder()
    pr = _FakePR("h", rec, author=author, author_type=author_type)

    verdict.run(
        _land(tmp_path),
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=_FakeEmit(rec),
        now=lambda: _FIXED,
    )

    assert eligibility.eligibilities == ["write_permission"]
    assert eligibility.author_types == [expected_type]


def _record_writer_land(
    make_config: Callable[..., Config],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    set_repo_entry: Callable[..., None],
    client: _FakeRulesClient,
    pr: _FakePR,
    emit: _FakeEmit,
) -> None:
    set_repo_entry("pytorch/vision", _vision_entry(eligibility="write_permission"))
    monkeypatch.setattr(verdict, "has_eligible_author", has_eligible_author)
    monkeypatch.setattr(github_client, "build_authz_client", lambda token: client)
    verdict.run(
        VerdictRequest(
            repo="pytorch/vision",
            pr_number=7,
            head_sha=_REVIEWED,
            eval_hash=_HASH,
            verdict_file=_write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM"),
            bot_login=_BOT,
        ),
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=emit,
        now=lambda: _FIXED,
    )


def test_a_writers_land_is_approved_through_the_live_permission_check(
    make_config, tmp_path, monkeypatch, set_repo_entry
):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    client = _FakeRulesClient()
    pr = _FakePR(_REVIEWED, rec, author="Writer")

    _record_writer_land(make_config, tmp_path, monkeypatch, set_repo_entry, client, pr, emit)

    assert client.permission_reads == ["Writer"]
    assert client.contents_reads == 0
    assert _decode(emit.row_gzip)["shadow"] is False
    assert pr.created_reviews == [("APPROVE", "")]


@pytest.mark.parametrize(
    ("author_type", "permission", "reads"),
    [
        pytest.param("Bot", "write", [], id="bot-typed-author"),
        pytest.param("User", "read", ["Writer"], id="read-only-author"),
    ],
)
def test_a_land_by_a_bot_or_a_reader_on_a_write_permission_repo_is_shadow(
    make_config, tmp_path, monkeypatch, set_repo_entry, author_type, permission, reads
):
    rec = _Recorder()
    emit = _FakeEmit(rec)
    client = _FakeRulesClient(permission=permission)
    pr = _FakePR(_REVIEWED, rec, author="Writer", author_type=author_type)

    _record_writer_land(make_config, tmp_path, monkeypatch, set_repo_entry, client, pr, emit)

    assert client.permission_reads == reads
    assert client.pull_reads == 0
    assert _decode(emit.row_gzip)["shadow"] is True
    assert pr.created_reviews == []


def test_land_on_a_repo_with_no_valid_entry_fails_before_any_github_call(make_config, tmp_path, set_repo_entry):
    set_repo_entry("pytorch/vision", None)
    emit = _FakeEmit(_Recorder())

    with pytest.raises(ValueError, match="pytorch/vision has no valid entry"):
        verdict.run(
            _land(tmp_path),
            make_config(github_token="tok"),
            build_github=_boom_build_github,
            emit=emit,
            now=lambda: _FIXED,
        )

    assert emit.row_gzip is None


def test_no_land_on_a_repo_with_no_valid_entry_dismisses_first_then_fails(make_config, tmp_path, set_repo_entry):
    set_repo_entry("pytorch/vision", None)
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec, reviews=[_FakeReview(1, _BOT, "APPROVED", rec)])

    with pytest.raises(ValueError, match="pytorch/vision has no valid entry"):
        verdict.run(
            _land(tmp_path, status="NO_LAND", reason="unclear_intent"),
            make_config(github_token="tok"),
            build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
            emit=emit,
            now=lambda: _FIXED,
        )

    assert rec.events == ["dismiss:1"]
    assert emit.row_gzip is None


def test_marker_on_a_repo_with_no_valid_entry_fails_with_no_row(make_config, set_repo_entry):
    set_repo_entry("pytorch/vision", None)
    emit = _FakeEmit(_Recorder())
    req = VerdictRequest(repo="pytorch/vision", pr_number=71, head_sha="h", status="CANCELLED")

    with pytest.raises(ValueError, match="no valid entry"):
        verdict.run(
            req, make_config(github_token="tok"), build_github=_boom_build_github, emit=emit, now=lambda: _FIXED
        )

    assert emit.row_gzip is None


@pytest.mark.parametrize(
    ("entry", "served"),
    [
        pytest.param(_vision_entry(mode="shadow"), True, id="shadow-mode"),
        pytest.param(_vision_entry(), False, id="safety-only"),
    ],
)
def test_marker_on_a_repo_not_served_and_active_is_shadow_and_posts_no_comment(
    make_config, set_repo_entry, entry, served
):
    set_repo_entry("pytorch/vision", entry, served=served)
    rec = _Recorder()
    emit = _FakeEmit(rec)
    req = VerdictRequest(repo="pytorch/vision", pr_number=72, head_sha="h", status="AI_REVIEW_STARTED", bot_login=_BOT)

    verdict.run(req, make_config(github_token="tok"), build_github=_boom_build_github, emit=emit, now=lambda: _FIXED)

    assert rec.events == ["emit"]
    assert _decode(emit.row_gzip)["shadow"] is True


def test_a_drci_entry_never_gets_greenlights_own_comment(make_config, tmp_path, set_repo_entry):
    set_repo_entry("pytorch/vision", _vision_entry(status_comment="drci"))
    rec = _Recorder()
    pr = _FakePR("h", rec, author=_TRUSTED_AUTHOR)

    verdict.run(
        _land(tmp_path),
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=_FakeEmit(rec),
        now=lambda: _FIXED,
    )

    assert rec.events == ["emit", "review:APPROVE"]


def test_the_default_entry_lookup_reads_the_local_repos_yaml():
    builtin = repo_config.BUILTIN_PYTORCH
    found = _REAL_REPO_ENTRY(constants.TARGET_REPO)
    assert found is not None
    entry, served = found
    assert served
    assert entry.change_source in repo_config.CHANGE_SOURCES
    assert (
        dataclasses.replace(entry, change_source=builtin.change_source, full_tick_minutes=builtin.full_tick_minutes)
        == builtin
    )
    assert _REAL_REPO_ENTRY("pytorch/no-such-repo") is None


def test_a_requested_shadow_land_with_no_valid_entry_dismisses_first_then_fails(make_config, tmp_path, set_repo_entry):
    set_repo_entry("pytorch/vision", None)
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec, reviews=[_FakeReview(1, _BOT, "APPROVED", rec)])
    req = dataclasses.replace(_land(tmp_path), shadow=True)

    with pytest.raises(ValueError, match="pytorch/vision has no valid entry"):
        verdict.run(
            req,
            make_config(github_token="tok"),
            build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
            emit=emit,
            now=lambda: _FIXED,
        )

    assert rec.events == ["dismiss:1"]
    assert emit.row_gzip is None


class _FailingEmit:
    def __init__(self, rec: _Recorder) -> None:
        self._rec = rec

    def __call__(self, row_gzip: bytes, key: str) -> None:
        self._rec.events.append("emit")
        raise OSError("disk full")


@pytest.mark.parametrize(
    ("entry", "requested", "author"),
    [
        pytest.param(_vision_entry(mode="shadow"), False, _TRUSTED_AUTHOR, id="config-shadow"),
        pytest.param(_vision_entry(), True, _TRUSTED_AUTHOR, id="requested-shadow"),
        pytest.param(_vision_entry(), False, _SHADOW_AUTHOR, id="eligibility-shadow"),
    ],
)
def test_a_shadow_land_dismisses_once_before_an_emit_that_fails(
    make_config, tmp_path, set_repo_entry, eligibility, entry, requested, author
):
    set_repo_entry("pytorch/vision", entry)
    rec = _Recorder()
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    pr = _FakePR("h", rec, reviews=reviews, author=author)
    req = dataclasses.replace(_land(tmp_path), shadow=requested)

    with pytest.raises(OSError, match="disk full"):
        verdict.run(
            req,
            make_config(github_token="tok"),
            build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
            emit=_FailingEmit(rec),
            now=lambda: _FIXED,
        )

    assert rec.events == ["dismiss:1", "emit"]
    assert reviews[0].dismissed_with == land_approval.SUPERSEDED_MESSAGE
    assert pr.created_reviews == []


def test_a_no_land_still_dismisses_once_before_its_emit(make_config, tmp_path, set_repo_entry):
    set_repo_entry("pytorch/vision", _vision_entry(mode="shadow"))
    rec = _Recorder()
    emit = _FakeEmit(rec)
    pr = _FakePR("h", rec, reviews=[_FakeReview(1, _BOT, "APPROVED", rec)])

    verdict.run(
        _land(tmp_path, status="NO_LAND", reason="unclear_intent"),
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=emit,
        now=lambda: _FIXED,
    )

    assert rec.events == ["dismiss:1", "emit"]


class _ClosingClient:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    def close(self) -> None:
        self._events.append("close")


def test_a_gate_repo_reads_its_rules_on_a_closed_client_before_the_eligibility_lookup(
    make_config, tmp_path, monkeypatch
):
    rec = _Recorder()
    pr = _FakePR("h", rec, author=_TRUSTED_AUTHOR)

    def read_rules(client: object, repo: str) -> gate_rules.GateRules:
        rec.events.append(f"rules:{repo}")
        return gate_rules.GateRules(enforced=True)

    def lookup(*_args: object, strict_base: bool, **_kwargs: object) -> bool:
        rec.events.append(f"lookup:strict={strict_base}")
        return True

    monkeypatch.setattr(verdict, "read_gate_rules", read_rules)
    monkeypatch.setattr(verdict, "has_eligible_author", lookup)
    monkeypatch.setattr(github_client, "build_authz_client", lambda token: _ClosingClient(rec.events))

    verdict.run(
        _land(tmp_path),
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=_FakeEmit(rec),
        now=lambda: _FIXED,
    )

    # Nothing slow sits between the lookup's PR read and the approval.
    assert rec.events == ["rules:pytorch/vision", "close", "lookup:strict=True", "emit", "review:APPROVE", "comment"]


def test_a_gate_repo_whose_rules_do_not_enforce_the_gate_is_shadow_with_no_lookup(
    make_config, tmp_path, eligibility, gate_rules_reader, caplog
):
    gate_rules_reader.result = gate_rules.GateRules(enforced=False, problems=("p1", "p2"))
    rec = _Recorder()
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec, "h")]
    pr = _FakePR("h", rec, reviews=reviews, author=_TRUSTED_AUTHOR)
    emit = _FakeEmit(rec)

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        verdict.run(
            _land(tmp_path),
            make_config(github_token="tok"),
            build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
            emit=emit,
            now=lambda: _FIXED,
        )

    # The shadow LAND path dismisses the standing approval and withholds a new one.
    assert gate_rules_reader.repos == ["pytorch/vision"]
    assert eligibility.calls == []
    assert pr.created_reviews == []
    assert rec.events == ["dismiss:1", "emit"]
    assert _decode(emit.row_gzip)["shadow"] is True
    assert "pytorch/vision does not enforce the gate: p1; p2" in caplog.text


@pytest.mark.parametrize("bot_login", ["greenlight-app[bot]", "pytorchgreenlight-staging[bot]"])
def test_a_gate_repo_land_by_another_account_is_shadow_with_no_rules_read_or_lookup(
    make_config, tmp_path, eligibility, gate_rules_reader, caplog, bot_login
):
    rec = _Recorder()
    standing = _FakeReview(1, bot_login, "APPROVED", rec, "h")
    pr = _FakePR("h", rec, reviews=[standing], author=_TRUSTED_AUTHOR)
    emit = _FakeEmit(rec)

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        verdict.run(
            dataclasses.replace(_land(tmp_path), bot_login=bot_login),
            make_config(github_token="tok"),
            build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
            emit=emit,
            now=lambda: _FIXED,
        )

    # The merge gate and the scan judge GreenLight's own account alone, so another one's approval carries nothing.
    assert (gate_rules_reader.repos, eligibility.calls, pr.created_reviews) == ([], [], [])
    assert rec.events == ["dismiss:1", "emit"]
    assert _decode(emit.row_gzip)["shadow"] is True
    assert f"pytorch/vision: --bot-login {bot_login!r} is not {GREENLIGHT_LOGIN}, whom the gate judges" in caplog.text


def test_a_pytorchbot_repo_land_takes_any_app_login(make_config, tmp_path, eligibility, gate_rules_reader):
    rec = _Recorder()
    pr = _FakePR("h", rec, author=_TRUSTED_AUTHOR)
    emit = _FakeEmit(rec)

    verdict.run(
        dataclasses.replace(_land(tmp_path, repo=constants.TARGET_REPO), bot_login="greenlight-app[bot]"),
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=emit,
        now=lambda: _FIXED,
    )

    assert gate_rules_reader.repos == []
    assert len(eligibility.calls) == 1
    assert _decode(emit.row_gzip)["shadow"] is False
    assert rec.events == ["emit", "review:APPROVE"]


def test_a_gate_repo_whose_rules_cannot_be_read_fails_the_command_with_no_row(
    make_config, tmp_path, eligibility, gate_rules_reader
):
    gate_rules_reader.result = GithubException(502, {"message": "Server Error"})
    rec = _Recorder()
    pr = _FakePR("h", rec, reviews=[_FakeReview(1, _BOT, "APPROVED", rec, "h")], author=_TRUSTED_AUTHOR)
    emit = _FakeEmit(rec)

    with pytest.raises(GithubException):
        verdict.run(
            _land(tmp_path),
            make_config(github_token="tok"),
            build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
            emit=emit,
            now=lambda: _FIXED,
        )

    assert eligibility.calls == []
    assert rec.events == []
    assert emit.row_gzip is None


@pytest.mark.parametrize(
    ("repo", "status", "reason", "shadow"),
    [
        pytest.param(constants.TARGET_REPO, "LAND", "clean", False, id="pytorch-land"),
        pytest.param("pytorch/vision", "NO_LAND", "unclear_intent", False, id="gate-no-land"),
        pytest.param("pytorch/vision", "LAND", "clean", True, id="gate-land-requested-shadow"),
    ],
)
def test_the_rules_are_read_only_for_an_authoritative_land_on_a_gate_repo(
    make_config, tmp_path, eligibility, gate_rules_reader, repo, status, reason, shadow
):
    rec = _Recorder()
    pr = _FakePR("h", rec, author=_TRUSTED_AUTHOR)
    request = dataclasses.replace(_land(tmp_path, repo=repo, status=status, reason=reason), shadow=shadow)

    verdict.run(
        request,
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=_FakeEmit(rec),
        now=lambda: _FIXED,
    )

    assert gate_rules_reader.repos == []


@pytest.mark.parametrize(("repo", "strict_base"), [(constants.TARGET_REPO, False), ("pytorch/vision", True)])
def test_the_lookup_is_handed_the_entrys_base_rule(make_config, tmp_path, eligibility, repo, strict_base):
    rec = _Recorder()
    pr = _FakePR("h", rec, author=_TRUSTED_AUTHOR)

    verdict.run(
        _land(tmp_path, repo=repo),
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=_FakeEmit(rec),
        now=lambda: _FIXED,
    )

    assert eligibility.strict_bases == [strict_base]


def test_a_re_land_after_a_push_on_pytorch_dismisses_the_old_approval_and_posts_a_pinned_one(make_config, tmp_path):
    rec = _Recorder()
    old = _FakeReview(1, _BOT, "APPROVED", rec, "old-head")
    pr = _FakePR("new-head", rec, reviews=[old])
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(
        repo=constants.TARGET_REPO, pr_number=7, head_sha="new-head", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(
        req,
        make_config(github_token="tok"),
        build_github=lambda t: _FakeGithub(_FakeRepo(pr)),
        emit=_FakeEmit(rec),
        now=lambda: _FIXED,
    )

    assert old.dismissed_with == land_approval.SUPERSEDED_MESSAGE
    assert pr.review_commits == ["new-head"]
    assert rec.events == ["emit", "dismiss:1", "review:APPROVE"]
