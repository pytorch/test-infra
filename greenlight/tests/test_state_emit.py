import gzip
import json
import re
from datetime import UTC, datetime
from typing import Any

from greenlight import constants, state_emit

_FIXED = datetime(2026, 7, 30, 12, 0, tzinfo=UTC)
_VERSION = "2026-07-30 12:00:00.000"
_VERSION_COMPACT = "20260730T120000_000"
_EMIT_ID = "e" * 32
_HASH = "a" * 64
_VERSION_RE = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}")
_EMIT_ID_RE = re.compile(r"[0-9a-f]{32}")

_ROW_KEYS = [
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
]


class _Capture:
    """Records the ``(gzip_bytes, key)`` handed to an emit/upload seam."""

    def __init__(self) -> None:
        self.row: bytes | None = None
        self.key: str | None = None

    def __call__(self, row_gzip: bytes, key: str) -> None:
        self.row = row_gzip
        self.key = key

    def decoded(self) -> dict[str, object]:
        assert self.row is not None
        raw = gzip.decompress(self.row).decode("utf-8")
        assert raw.endswith("\n")
        assert raw.count("\n") == 1  # exactly one JSONEachRow line
        data: dict[str, object] = json.loads(raw)
        return data


class _FakePutter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, bytes]] = []

    def put_object(self, *, Bucket, Key, Body):
        self.calls.append((Bucket, Key, Body))
        return {}


def test_object_key_scheme():
    assert (
        state_emit.object_key("owner/name", 42, "2026-07-30 12:00:00.123", _EMIT_ID)
        == f"greenlight_pr_state/owner/name/42/20260730T120000_123-{_EMIT_ID}.json.gz"
    )


def test_object_key_uses_shared_prefix_and_gz_suffix():
    key = state_emit.object_key("o/r", 1, _VERSION, _EMIT_ID)
    assert key.startswith(f"{constants.S3_KEY_PREFIX}/")
    assert key.endswith(".json.gz")


def test_utcnow_is_timezone_aware_utc():
    assert state_emit._utcnow().tzinfo is UTC


def test_emit_row_is_byte_stable_golden():
    cap = _Capture()

    key = state_emit.emit_row(
        repo="o/r",
        pr_number=5,
        head_sha="h",
        status="LAND",
        reason="clean",
        eval_hash=_HASH,
        message="LGTM",
        eval_job="ej",
        agent_job="aj",
        run_id=9,
        now=lambda: _FIXED,
        emit=cap,
        new_emit_id=lambda: _EMIT_ID,
    )

    assert key == cap.key == f"greenlight_pr_state/o/r/5/{_VERSION_COMPACT}-{_EMIT_ID}.json.gz"
    assert cap.row is not None
    assert gzip.decompress(cap.row).decode("utf-8") == (
        f'{{"repo":"o/r","pr_number":5,"head_sha":"h","status":"LAND","reason":"clean",'
        f'"eval_hash":"{_HASH}","message":"LGTM","eval_job":"ej","agent_job":"aj",'
        f'"version":"{_VERSION}","run_id":9,"emit_id":"{_EMIT_ID}"}}\n'
    )


def test_emit_ai_review_dispatched_builds_row_and_calls_upload(monkeypatch):
    monkeypatch.setattr(state_emit, "_utcnow", lambda: _FIXED)
    cap = _Capture()

    state_emit.emit_ai_review_dispatched(
        repo="pytorch/pytorch",
        pr_number=42,
        head_sha="deadbeef",
        eval_hash=_HASH,
        run_id=7,
        upload=cap,
    )

    row = cap.decoded()
    # The key is derived from the row's own (fixed) version and its per-emit emit_id.
    assert cap.key == state_emit.object_key("pytorch/pytorch", 42, _VERSION, str(row["emit_id"]))
    assert cap.key == f"greenlight_pr_state/pytorch/pytorch/42/{_VERSION_COMPACT}-{row['emit_id']}.json.gz"
    assert list(row.keys()) == _ROW_KEYS
    assert row["status"] == constants.STATUS_AI_REVIEW_DISPATCHED == "AI_REVIEW_DISPATCHED"
    assert row["repo"] == "pytorch/pytorch"
    assert row["pr_number"] == 42
    assert row["head_sha"] == "deadbeef"
    assert row["eval_hash"] == _HASH
    assert row["run_id"] == 7
    # Empty marker fields, matching the AI_REVIEW_STARTED marker convention.
    assert row["reason"] == ""
    assert row["message"] == ""
    assert row["eval_job"] == ""
    assert row["agent_job"] == ""
    assert row["version"] == _VERSION
    assert _EMIT_ID_RE.fullmatch(str(row["emit_id"]))


def test_emit_ai_review_dispatched_key_matches_row_version():
    # With the real clock, the object key must still be derived from the row's own version.
    cap = _Capture()

    state_emit.emit_ai_review_dispatched(
        repo="o/r", pr_number=3, head_sha="h", eval_hash="b" * 64, run_id=1, upload=cap
    )

    row = cap.decoded()
    version = str(row["version"])
    assert _VERSION_RE.fullmatch(version)
    assert cap.key == state_emit.object_key("o/r", 3, version, str(row["emit_id"]))


def test_two_dispatched_emits_get_distinct_emit_ids():
    ids: list[str] = []

    def upload(row_gzip: bytes, key: str) -> None:
        ids.append(str(json.loads(gzip.decompress(row_gzip).decode("utf-8"))["emit_id"]))

    for _ in range(2):
        state_emit.emit_ai_review_dispatched(
            repo="o/r", pr_number=1, head_sha="h", eval_hash=_HASH, run_id=1, upload=upload
        )

    assert ids[0] != ids[1]
    assert all(_EMIT_ID_RE.fullmatch(value) for value in ids)


def test_emit_reverted_builds_row_with_empty_eval_hash(monkeypatch):
    monkeypatch.setattr(state_emit, "_utcnow", lambda: _FIXED)
    cap = _Capture()

    state_emit.emit_reverted(repo="pytorch/pytorch", pr_number=42, head_sha="deadbeef", run_id=4, upload=cap)

    row = cap.decoded()
    assert cap.key == state_emit.object_key("pytorch/pytorch", 42, _VERSION, str(row["emit_id"]))
    assert list(row.keys()) == _ROW_KEYS
    assert row["status"] == constants.STATUS_REVERTED == "REVERTED"
    assert row["repo"] == "pytorch/pytorch"
    assert row["pr_number"] == 42
    assert row["head_sha"] == "deadbeef"
    assert row["run_id"] == 4
    # No fingerprint is computed for an excluded PR, and an empty hash can never match one a
    # land-time verifier recomputes.
    assert row["eval_hash"] == ""
    assert row["reason"] == ""
    assert row["message"] == ""
    assert row["eval_job"] == ""
    assert row["agent_job"] == ""


def test_emit_reverted_defaults_to_boto3_upload(monkeypatch):
    cap = _Capture()
    monkeypatch.setattr(state_emit, "_default_upload", cap)

    state_emit.emit_reverted(repo="o/r", pr_number=1, head_sha="h", run_id=2)

    assert cap.key is not None
    assert cap.key.startswith("greenlight_pr_state/o/r/1/")
    assert cap.decoded()["status"] == constants.STATUS_REVERTED


def test_emit_ai_review_dispatched_defaults_to_boto3_upload(monkeypatch):
    # With no upload seam, the default boto3 uploader is used.
    cap = _Capture()
    monkeypatch.setattr(state_emit, "_default_upload", cap)

    state_emit.emit_ai_review_dispatched(repo="o/r", pr_number=1, head_sha="h", eval_hash=_HASH, run_id=5)

    assert cap.key is not None
    assert cap.key.startswith("greenlight_pr_state/o/r/1/")
    assert cap.decoded()["status"] == constants.STATUS_AI_REVIEW_DISPATCHED


def test_default_upload_puts_object_to_gha_artifacts_bucket(monkeypatch):
    putter = _FakePutter()
    monkeypatch.setattr(state_emit, "_s3_client", lambda: putter)

    state_emit._default_upload(b"gzip-bytes", "greenlight_pr_state/o/r/1/x.json.gz")

    assert putter.calls == [(constants.S3_BUCKET, "greenlight_pr_state/o/r/1/x.json.gz", b"gzip-bytes")]
    assert putter.calls[0][0] == "gha-artifacts"


def test_default_emit_id_is_uuid4_hex_and_distinct_per_call():
    # The single-sourced default emit_id generator is uuid4().hex: 32 lowercase hex chars, fresh
    # every call. verdict.run and emit_ai_review_dispatched both reuse this one generator.
    first = state_emit.default_emit_id()
    assert _EMIT_ID_RE.fullmatch(first)
    assert state_emit.default_emit_id() != first


def test_s3_client_sets_explicit_timeouts_and_bounded_retries(monkeypatch):
    # A hung S3 PUT on the scan's main thread must fail fast rather than inherit botocore's 60s
    # connect/read defaults, so the client is built with an explicit bounded Config.
    captured: dict[str, Any] = {}

    def fake_client(service_name, *, config):
        captured["service_name"] = service_name
        captured["config"] = config
        return object()

    monkeypatch.setattr("boto3.client", fake_client)

    state_emit._s3_client()

    assert captured["service_name"] == "s3"
    cfg = captured["config"]
    assert cfg.connect_timeout == 5
    assert cfg.read_timeout == 5
    assert cfg.retries == {"max_attempts": 3, "mode": "standard"}


def test_two_emits_same_version_get_distinct_object_keys():
    # emit_id uniquifies the S3 object key: two emits for the same (repo, pr_number) at the same
    # millisecond version must not collide and silently overwrite each other in S3.
    keys: list[str] = []

    def upload(row_gzip: bytes, key: str) -> None:
        keys.append(key)

    for _ in range(2):
        state_emit.emit_row(
            repo="o/r",
            pr_number=1,
            head_sha="h",
            status="LAND",
            reason="clean",
            eval_hash=_HASH,
            message="m",
            eval_job="",
            agent_job="",
            run_id=1,
            now=lambda: _FIXED,
            emit=upload,
            new_emit_id=state_emit.default_emit_id,
        )

    assert keys[0] != keys[1]
    assert all(key.startswith(f"{constants.S3_KEY_PREFIX}/o/r/1/{_VERSION_COMPACT}-") for key in keys)
    assert all(key.endswith(".json.gz") for key in keys)
