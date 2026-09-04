from __future__ import annotations

import gzip
import json
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, NoReturn

import pytest

from greenlight import comment_format, github_client, verdict
from greenlight.verdict import VerdictRequest

if TYPE_CHECKING:
    from pathlib import Path

_FIXED = datetime(2026, 7, 30, 12, 0, tzinfo=UTC)
_HASH = "a" * 64
_BOT = "greenlight-app[bot]"
_VERSION = "2026-07-30 12:00:00.000"
_VERSION_COMPACT = "20260730T120000_000"
_EMIT_ID = "e" * 32


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
    def __init__(self, login: str | None) -> None:
        self.login = login


class _FakeReview:
    def __init__(self, id: int, login: str | None, state: str, rec: _Recorder) -> None:
        self.id = id
        self.user = _FakeUser(login) if login is not None else None
        self.state = state
        self._rec = rec
        self.dismissed_with: str | None = None

    def dismiss(self, message: str) -> None:
        self.dismissed_with = message
        self._rec.events.append(f"dismiss:{self.id}")


class _FakeHead:
    def __init__(self, sha: str) -> None:
        self.sha = sha


class _FakeComment:
    def __init__(self, body: str, login: str | None, rec: _Recorder) -> None:
        self.body = body
        self.user = _FakeUser(login) if login is not None else None
        self._rec = rec

    def edit(self, body: str) -> None:
        self.body = body
        self._rec.events.append("edit")


class _FakePR:
    def __init__(
        self,
        head_sha: str,
        rec: _Recorder,
        reviews: list[_FakeReview] | None = None,
        issue_comments: list[_FakeComment] | None = None,
    ) -> None:
        self.head = _FakeHead(head_sha)
        self._rec = rec
        self._reviews = reviews or []
        self._issue_comments = issue_comments or []
        self.created_reviews: list[tuple[str, str]] = []
        self.comments: list[str] = []

    def create_review(self, *, body: str, event: str) -> object:
        self.created_reviews.append((event, body))
        self._rec.events.append(f"review:{event}")
        return object()

    def create_issue_comment(self, body: str) -> object:
        self.comments.append(body)
        self._rec.events.append("comment")
        return object()

    def get_issue_comments(self) -> list[_FakeComment]:
        return self._issue_comments

    def get_reviews(self) -> list[_FakeReview]:
        return self._reviews


class _FakeRepo:
    def __init__(self, pr: _FakePR) -> None:
        self._pr = pr
        self.get_pull_numbers: list[int] = []

    def get_pull(self, number: int) -> _FakePR:
        self.get_pull_numbers.append(number)
        return self._pr


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
    assert gh.get_repo_names == ["pytorch/pytorch"]
    assert repo.get_pull_numbers == [7]
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
    assert body == verdict._LAND_REVIEW_BODY == ""


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
    assert rec.events == ["emit", "dismiss:1"]
    assert reviews[0].dismissed_with == verdict._SUPERSEDED_MESSAGE
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


def test_full_no_land_emits_payload_dismisses_then_comments(make_config, tmp_path):
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

    assert rec.events == ["emit", "dismiss:1", "comment"]
    assert reviews[0].dismissed_with == verdict._SUPERSEDED_MESSAGE
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
    assert pr.created_reviews[0] == ("APPROVE", verdict._LAND_REVIEW_BODY)
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
    assert rec.events == ["emit", "dismiss:1", "edit"]
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

    assert rec.events == ["emit", "dismiss:1", "comment"]
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
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    pr = _FakePR("h", rec, reviews=reviews)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(repo="r", pr_number=40, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict.run(req, make_config(github_token="tok"), build_github=lambda t: gh, emit=emit, now=lambda: _FIXED)

    # A live greenlight approval already exists: no second APPROVE review is posted (the prior one is
    # left intact), yet the canonical comment is still upserted and the skip is logged.
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

    def create_review(self, *, body: str, event: str) -> object:
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
    assert rec.events == ["emit", "dismiss:1"]
    assert reviews[0].dismissed_with == verdict._SUPERSEDED_MESSAGE
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

    assert verdict._resolve_verdict(req) == ("LAND", "r", "m")


def test_resolve_status_from_file_is_normalized(tmp_path):
    vf = _write_verdict(tmp_path, status="land", reason="r", message="m")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=vf)

    assert verdict._resolve_verdict(req) == ("LAND", "r", "m")


def test_resolve_cli_marker_needs_no_file():
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", status="cancelled")

    assert verdict._resolve_verdict(req) == ("CANCELLED", "", "")


def test_resolve_file_marker_drops_reason_and_message(tmp_path):
    vf = _write_verdict(tmp_path, status="FAILED", reason="ignored", message="ignored")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=vf)

    assert verdict._resolve_verdict(req) == ("FAILED", "", "")


def test_resolve_full_status_without_file_raises():
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", status="LAND")

    with pytest.raises(ValueError, match="requires --verdict-file"):
        verdict._resolve_verdict(req)


def test_resolve_no_status_anywhere_raises():
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h")

    with pytest.raises(ValueError, match="verdict status is required"):
        verdict._resolve_verdict(req)


def test_resolve_unknown_status_raises(tmp_path):
    vf = _write_verdict(tmp_path, status="BOGUS", reason="r", message="m")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=vf)

    with pytest.raises(ValueError, match="unknown verdict status"):
        verdict._resolve_verdict(req)


def test_load_bad_json_raises(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("{not valid", encoding="utf-8")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=str(path))

    with pytest.raises(ValueError, match="not valid JSON"):
        verdict._resolve_verdict(req)


def test_load_missing_file_raises(tmp_path):
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=str(tmp_path / "nope.json"))

    with pytest.raises(ValueError, match="cannot read verdict file"):
        verdict._resolve_verdict(req)


def test_load_non_object_json_raises(tmp_path):
    path = tmp_path / "arr.json"
    path.write_text("[1, 2, 3]", encoding="utf-8")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=str(path))

    with pytest.raises(ValueError, match="must contain a JSON object"):
        verdict._resolve_verdict(req)


def test_load_non_string_reason_raises(tmp_path):
    path = tmp_path / "v.json"
    path.write_text(json.dumps({"status": "LAND", "reason": 123, "message": "m"}), encoding="utf-8")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=str(path))

    with pytest.raises(ValueError, match="field 'reason' must be a string"):
        verdict._resolve_verdict(req)


def test_load_non_string_status_raises(tmp_path):
    path = tmp_path / "v.json"
    path.write_text(json.dumps({"status": 5, "reason": "r", "message": "m"}), encoding="utf-8")
    req = VerdictRequest(repo="x", pr_number=1, head_sha="h", verdict_file=str(path))

    with pytest.raises(ValueError, match="field 'status' must be a string"):
        verdict._resolve_verdict(req)


def test_validate_eval_hash_accepts_64_lowercase_hex():
    verdict._validate_eval_hash("0123456789abcdef" * 4)


@pytest.mark.parametrize("bad", ["", "abc", "A" * 64, "g" * 64, "a" * 63, "a" * 65])
def test_validate_eval_hash_rejects(bad):
    with pytest.raises(ValueError, match="eval_hash"):
        verdict._validate_eval_hash(bad)
