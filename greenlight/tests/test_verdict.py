import json
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, NoReturn

import pytest

from greenlight import clickhouse_client, verdict
from greenlight.verdict import VerdictRequest

if TYPE_CHECKING:
    from pathlib import Path

_FIXED = datetime(2026, 7, 30, 12, 0, tzinfo=UTC)
_HASH = "a" * 64
_COLUMNS = list(clickhouse_client.INSERT_COLUMNS)
_BOT = "greenlight-app[bot]"


class _Recorder:
    def __init__(self) -> None:
        self.events: list[str] = []


class _FakeCHClient:
    def __init__(self, rec: _Recorder) -> None:
        self._rec = rec
        self.rows: list[tuple[str, list[list[object]], list[str]]] = []

    def insert(self, table, data, *, column_names):
        self._rec.events.append("insert")
        self.rows.append((table, data, list(column_names)))
        return object()


class _RaisingCHClient:
    def insert(self, table, data, *, column_names):
        raise RuntimeError("ch boom")


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


class _FakePR:
    def __init__(self, head_sha: str, rec: _Recorder, reviews: list[_FakeReview] | None = None) -> None:
        self.head = _FakeHead(head_sha)
        self._rec = rec
        self._reviews = reviews or []
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


def _boom_build_github(token: str) -> NoReturn:
    raise AssertionError("build_github should not be called")


def _boom_connect() -> NoReturn:
    raise AssertionError("ch_connect should not be called")


def test_full_land_writes_row_then_approves(make_config, tmp_path):
    rec = _Recorder()
    ch = _FakeCHClient(rec)
    pr = _FakePR("headsha", rec)
    repo = _FakeRepo(pr)
    gh = _FakeGithub(repo)
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(repo="pytorch/pytorch", pr_number=7, head_sha="headsha", eval_hash=_HASH, verdict_file=vf)
    captured: dict[str, object] = {}

    def build_github(token):
        captured["token"] = token
        return gh

    verdict.run(
        req, make_config(github_token="tok"), build_github=build_github, ch_connect=lambda: ch, now=lambda: _FIXED
    )

    assert captured["token"] == "tok"
    assert gh.get_repo_names == ["pytorch/pytorch"]
    assert repo.get_pull_numbers == [7]
    assert rec.events == ["insert", "review:APPROVE"]
    # ClickHouse row stores the full message verbatim.
    assert ch.rows[0][1][0] == ["pytorch/pytorch", 7, "headsha", "LAND", "clean", _HASH, "LGTM", "", "", _FIXED]
    assert ch.rows[0][2] == _COLUMNS
    event, body = pr.created_reviews[0]
    assert event == "APPROVE"
    assert body.startswith("Green Light: LAND (reason: clean)")
    assert "LGTM" in body


def test_full_no_land_writes_row_dismisses_then_comments(make_config, tmp_path):
    rec = _Recorder()
    ch = _FakeCHClient(rec)
    reviews = [
        _FakeReview(1, _BOT, "APPROVED", rec),
        _FakeReview(2, "alice", "APPROVED", rec),
        _FakeReview(3, _BOT, "COMMENTED", rec),
    ]
    pr = _FakePR("headsha", rec, reviews=reviews)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="scope_too_large", message="@pytorchbot please split")
    req = VerdictRequest(
        repo="pytorch/pytorch",
        pr_number=8,
        head_sha="headsha",
        eval_hash=_HASH,
        verdict_file=vf,
        eval_job_url="https://eval-run",
        bot_login=_BOT,
    )

    verdict.run(
        req, make_config(github_token="tok"), build_github=lambda t: gh, ch_connect=lambda: ch, now=lambda: _FIXED
    )

    assert rec.events == ["insert", "dismiss:1", "comment"]
    assert reviews[0].dismissed_with == verdict._SUPERSEDED_MESSAGE
    # ClickHouse stores the FULL, un-defanged message.
    assert ch.rows[0][1][0] == [
        "pytorch/pytorch",
        8,
        "headsha",
        "NO_LAND",
        "scope_too_large",
        _HASH,
        "@pytorchbot please split",
        "https://eval-run",
        "",
        _FIXED,
    ]
    # The posted comment is defanged: header + run URL, @ neutralized, fenced.
    body = pr.comments[0]
    assert body.startswith("Green Light: NO_LAND (reason: scope_too_large)\nhttps://eval-run")
    assert "@pytorchbot" not in body
    assert "pytorchbot" in body
    assert verdict._ZERO_WIDTH_SPACE in body
    assert "```" in body


def test_full_no_land_without_prior_approval_still_comments(make_config, tmp_path):
    rec = _Recorder()
    ch = _FakeCHClient(rec)
    pr = _FakePR("h", rec, reviews=[_FakeReview(1, "alice", "APPROVED", rec)])
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="unclear_intent", message="needs work")
    req = VerdictRequest(repo="r", pr_number=1, head_sha="h", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT)

    verdict.run(
        req, make_config(github_token="tok"), build_github=lambda t: gh, ch_connect=lambda: ch, now=lambda: _FIXED
    )

    assert rec.events == ["insert", "comment"]
    assert pr.comments[0].startswith("Green Light: NO_LAND (reason: unclear_intent)")


def test_mismatched_head_land_still_records_and_approves(make_config, tmp_path):
    rec = _Recorder()
    ch = _FakeCHClient(rec)
    pr = _FakePR("actual-sha", rec)  # live head differs from the input head_sha
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="LGTM")
    req = VerdictRequest(repo="r", pr_number=1, head_sha="expected-sha", eval_hash=_HASH, verdict_file=vf)

    verdict.run(
        req, make_config(github_token="tok"), build_github=lambda t: gh, ch_connect=lambda: ch, now=lambda: _FIXED
    )

    # A moved head no longer aborts: the row is written and the PR is approved.
    assert rec.events == ["insert", "review:APPROVE"]
    assert ch.rows[0][1][0][2] == "expected-sha"  # the INPUT head_sha is stored verbatim
    assert pr.created_reviews[0][0] == "APPROVE"


def test_mismatched_head_no_land_still_records_and_comments(make_config, tmp_path):
    rec = _Recorder()
    ch = _FakeCHClient(rec)
    reviews = [_FakeReview(1, _BOT, "APPROVED", rec)]
    pr = _FakePR("actual-sha", rec, reviews=reviews)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="scope_too_large", message="split")
    req = VerdictRequest(
        repo="r", pr_number=1, head_sha="expected-sha", eval_hash=_HASH, verdict_file=vf, bot_login=_BOT
    )

    verdict.run(
        req, make_config(github_token="tok"), build_github=lambda t: gh, ch_connect=lambda: ch, now=lambda: _FIXED
    )

    assert rec.events == ["insert", "dismiss:1", "comment"]
    assert ch.rows[0][1][0][2] == "expected-sha"  # the INPUT head_sha is stored verbatim


def test_marker_cancelled_writes_row_only(make_config):
    rec = _Recorder()
    ch = _FakeCHClient(rec)
    req = VerdictRequest(repo="pytorch/pytorch", pr_number=9, head_sha="h", status="CANCELLED")

    verdict.run(
        req, make_config(github_token="tok"), build_github=_boom_build_github, ch_connect=lambda: ch, now=lambda: _FIXED
    )

    assert rec.events == ["insert"]
    assert ch.rows[0][1][0] == ["pytorch/pytorch", 9, "h", "CANCELLED", "", "", "", "", "", _FIXED]


def test_marker_failed_stores_eval_hash_verbatim_without_validation(make_config):
    rec = _Recorder()
    ch = _FakeCHClient(rec)
    req = VerdictRequest(repo="r", pr_number=2, head_sha="h", status="FAILED", eval_hash="not-a-valid-hash")

    verdict.run(
        req, make_config(github_token="tok"), build_github=_boom_build_github, ch_connect=lambda: ch, now=lambda: _FIXED
    )

    assert rec.events == ["insert"]
    # eval_hash column is stored verbatim for markers -- no hex validation.
    assert ch.rows[0][1][0][5] == "not-a-valid-hash"
    assert ch.rows[0][1][0][3] == "FAILED"


def test_dry_run_full_is_offline(make_config, tmp_path, caplog):
    rec = _Recorder()
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="m")
    req = VerdictRequest(
        repo="pytorch/pytorch", pr_number=3, head_sha="h", eval_hash=_HASH, verdict_file=vf, dry_run=True
    )

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict.run(
            req,
            make_config(github_token="tok"),
            build_github=_boom_build_github,
            ch_connect=_boom_connect,
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
            req,
            make_config(github_token="tok"),
            build_github=_boom_build_github,
            ch_connect=_boom_connect,
            now=lambda: _FIXED,
        )


def test_full_rejects_empty_message(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="   ")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash=_HASH, verdict_file=vf)

    with pytest.raises(ValueError, match="non-empty message"):
        verdict.run(
            req,
            make_config(github_token="tok"),
            build_github=_boom_build_github,
            ch_connect=_boom_connect,
            now=lambda: _FIXED,
        )


def test_full_rejects_missing_message_key(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="LAND", reason="clean")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash=_HASH, verdict_file=vf)

    with pytest.raises(ValueError, match="non-empty message"):
        verdict.run(
            req,
            make_config(github_token="tok"),
            build_github=_boom_build_github,
            ch_connect=_boom_connect,
            now=lambda: _FIXED,
        )


def test_no_land_without_bot_login_raises(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="NO_LAND", reason="scope_too_large", message="m")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash=_HASH, verdict_file=vf)

    with pytest.raises(ValueError, match="NO_LAND requires --bot-login"):
        verdict.run(
            req,
            make_config(github_token="tok"),
            build_github=_boom_build_github,
            ch_connect=_boom_connect,
            now=lambda: _FIXED,
        )


def test_full_invalid_eval_hash_rejected_before_github(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="m")
    req = VerdictRequest(repo="r", pr_number=5, head_sha="h", eval_hash="short", verdict_file=vf)

    with pytest.raises(ValueError, match="eval_hash"):
        verdict.run(
            req,
            make_config(github_token="tok"),
            build_github=_boom_build_github,
            ch_connect=_boom_connect,
            now=lambda: _FIXED,
        )


def test_full_missing_github_token_raises(make_config, tmp_path):
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="m")
    req = VerdictRequest(repo="r", pr_number=6, head_sha="h", eval_hash=_HASH, verdict_file=vf)

    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        verdict.run(
            req,
            make_config(github_token=None),
            build_github=_boom_build_github,
            ch_connect=_boom_connect,
            now=lambda: _FIXED,
        )


def test_clickhouse_insert_errors_are_not_swallowed(make_config, tmp_path):
    rec = _Recorder()
    pr = _FakePR("h", rec)
    gh = _FakeGithub(_FakeRepo(pr))
    vf = _write_verdict(tmp_path, status="LAND", reason="clean", message="m")
    req = VerdictRequest(repo="r", pr_number=7, head_sha="h", eval_hash=_HASH, verdict_file=vf)

    with pytest.raises(RuntimeError, match="ch boom"):
        verdict.run(
            req,
            make_config(github_token="tok"),
            build_github=lambda t: gh,
            ch_connect=_RaisingCHClient,
            now=lambda: _FIXED,
        )

    assert pr.created_reviews == []


def test_defang_neutralizes_at_mentions_and_wraps_in_fence():
    out = verdict._defang("ping @pytorchbot now")

    assert "@pytorchbot" not in out
    assert "pytorchbot" in out
    assert verdict._ZERO_WIDTH_SPACE in out
    assert out.startswith("```")
    assert out.endswith("```")


def test_defang_caps_length():
    out = verdict._defang("x" * 5000)

    assert out.count("x") == 4000


def test_defang_uses_longer_fence_than_backtick_run():
    out = verdict._defang("before ``` after")

    assert out.split("\n", 1)[0] == "`" * 4
    assert "before ``` after" in out


def test_post_body_includes_header_and_run_url():
    body = verdict._post_body("LAND", "clean", "hi", "https://run")

    assert body.startswith("Green Light: LAND (reason: clean)\nhttps://run\n\n")
    assert "hi" in body


def test_post_body_omits_url_line_when_absent():
    body = verdict._post_body("NO_LAND", "scope_too_large", "hi", "")

    assert body.startswith("Green Light: NO_LAND (reason: scope_too_large)\n\n")
    assert "https" not in body


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
