import gzip
import http.client
import json
import urllib.error
from typing import Any, Dict, List

import pytest

from flake_test_fail_autorevert import td_exclusions
from flake_test_fail_autorevert.td_exclusions import (
    _parse_exclusions,
    fetch_exclusions,
    flat_excluded_files,
    is_flat,
    normalize_test_file,
)


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    td_exclusions._CACHE.clear()
    yield
    td_exclusions._CACHE.clear()


def _gzip_json(obj: Any) -> bytes:
    return gzip.compress(json.dumps(obj).encode())


# --- normalize_test_file ---


def test_normalize_strips_py_suffix():
    assert normalize_test_file("dynamo/test_dynamic_shapes.py") == (
        "dynamo/test_dynamic_shapes"
    )


def test_normalize_strips_leading_test_dir():
    assert normalize_test_file("test/distributed/test_c10d_nccl.py") == (
        "distributed/test_c10d_nccl"
    )


def test_normalize_already_canonical():
    assert normalize_test_file("distributed/checkpoint/test_checkpoint") == (
        "distributed/checkpoint/test_checkpoint"
    )


def test_normalize_backslashes_and_whitespace():
    assert normalize_test_file("  distributed\\test_x.py  ") == "distributed/test_x"


# --- _parse_exclusions: per-config shape + defensive typing ---


def test_parse_keeps_per_config_keys_separately():
    body = _gzip_json(
        {
            "envA": {"cfg1": ["a/test_x"], "cfg2": ["b/test_y"]},
            "envB": {"cfg1": ["a/test_x", "c/test_z.py"]},
        }
    )
    assert _parse_exclusions(body) == {
        ("envA", "cfg1"): {"a/test_x"},
        ("envA", "cfg2"): {"b/test_y"},
        ("envB", "cfg1"): {"a/test_x", "c/test_z"},
    }


def test_parse_keeps_empty_config_as_empty_set():
    # An empty list means TD excluded no files for that config; the key must survive as an
    # empty set rather than be dropped. It implies nothing about matrix membership (which is
    # not derivable from this artifact).
    body = _gzip_json({"env": {"cfg": []}})
    assert _parse_exclusions(body) == {("env", "cfg"): set()}


def test_parse_skips_non_list_and_non_string_entries_no_char_explosion():
    # cfg1's value is a bare STRING, not a list: it must be skipped, NOT iterated into
    # single characters. cfg2 keeps only its string entries, normalized.
    body = _gzip_json(
        {
            "env1": {"cfg1": "a/test_x", "cfg2": ["a/test_y.py", 123, None, "b/test_z"]},
            "env2": "not-a-dict",
        }
    )
    result = _parse_exclusions(body)
    assert result == {("env1", "cfg2"): {"a/test_y", "b/test_z"}}
    assert ("env1", "cfg1") not in result  # string value dropped, no 'a','/','t',... keys


def test_parse_non_dict_top_level_returns_empty():
    assert _parse_exclusions(_gzip_json(["not", "a", "dict"])) == {}


# --- is_flat / flat_excluded_files ---


def test_is_flat_true_only_for_sole_sentinel_key():
    flat = {("NoBuildEnv", "NoTestConfig"): {"a/test_x"}}
    assert is_flat(flat) is True
    assert flat_excluded_files(flat) == {"a/test_x"}


def test_is_flat_false_for_per_config_and_mixed_and_empty():
    per_config = {("env", "cfg"): {"a/test_x"}}
    assert is_flat(per_config) is False
    assert flat_excluded_files(per_config) == set()
    # A sentinel key alongside a real key is treated as per-config, not flat.
    mixed = {("NoBuildEnv", "NoTestConfig"): {"x"}, ("env", "cfg"): {"y"}}
    assert is_flat(mixed) is False
    assert is_flat({}) is False


# --- fetch_exclusions (HTTP layer mocked) ---


def test_fetch_nonempty_gzipped(monkeypatch):
    body = _gzip_json({"NoBuildEnv": {"NoTestConfig": ["a/test_x", "b/test_y.py"]}})
    monkeypatch.setattr(td_exclusions, "_open_url", lambda url: body)
    assert fetch_exclusions(1, 1) == {("NoBuildEnv", "NoTestConfig"): {"a/test_x", "b/test_y"}}


def test_fetch_plain_json_not_gzipped(monkeypatch):
    body = json.dumps({"e": {"c": ["a/test_x"]}}).encode()
    monkeypatch.setattr(td_exclusions, "_open_url", lambda url: body)
    assert fetch_exclusions(3, 1) == {("e", "c"): {"a/test_x"}}


def test_fetch_empty_dict_returns_empty_map(monkeypatch):
    monkeypatch.setattr(td_exclusions, "_open_url", lambda url: _gzip_json({}))
    result = fetch_exclusions(4, 1)
    assert result == {}
    assert result is not None


def test_fetch_404_returns_none(monkeypatch):
    def _raise(url: str) -> bytes:
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)  # type: ignore[arg-type]

    monkeypatch.setattr(td_exclusions, "_open_url", _raise)
    assert fetch_exclusions(5, 1) is None


def test_fetch_bad_gzip_returns_none(monkeypatch):
    monkeypatch.setattr(td_exclusions, "_open_url", lambda url: b"\x1f\x8b\x08corrupt")
    assert fetch_exclusions(6, 1) is None


def test_fetch_bad_json_returns_none(monkeypatch):
    monkeypatch.setattr(td_exclusions, "_open_url", lambda url: b"not json at all")
    assert fetch_exclusions(7, 1) is None


def test_fetch_malformed_schema_typeerror_returns_none(monkeypatch):
    # A parse that raises TypeError/AttributeError (malformed schema) must be caught and
    # mapped to None (-> td_unknown), NEVER escalate to a whole-commit ERROR.
    monkeypatch.setattr(td_exclusions, "_open_url", lambda url: _gzip_json({"e": {"c": []}}))

    def _boom(_raw: bytes) -> Dict[Any, Any]:
        raise AttributeError("malformed")

    monkeypatch.setattr(td_exclusions, "_parse_exclusions", _boom)
    assert fetch_exclusions(13, 1) is None


def test_fetch_caches_success_per_run(monkeypatch):
    calls: List[str] = []

    def _once(url: str) -> bytes:
        calls.append(url)
        return _gzip_json({"e": {"c": ["a/test_x"]}})

    monkeypatch.setattr(td_exclusions, "_open_url", _once)
    first = fetch_exclusions(8, 1)
    second = fetch_exclusions(8, 1)
    assert first == second == {("e", "c"): {"a/test_x"}}
    assert len(calls) == 1


def test_fetch_caches_none_result(monkeypatch):
    calls: List[str] = []

    def _raise(url: str) -> bytes:
        calls.append(url)
        raise urllib.error.HTTPError(url, 404, "nf", {}, None)  # type: ignore[arg-type]

    monkeypatch.setattr(td_exclusions, "_open_url", _raise)
    assert fetch_exclusions(9, 1) is None
    assert fetch_exclusions(9, 1) is None
    assert len(calls) == 1


def test_fetch_retries_transient_then_succeeds(monkeypatch):
    monkeypatch.setattr(td_exclusions.time, "sleep", lambda s: None)
    attempts = {"n": 0}

    def _flaky(url: str) -> bytes:
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise urllib.error.URLError("dns flap")
        return _gzip_json({"e": {"c": ["a/test_x"]}})

    monkeypatch.setattr(td_exclusions, "_open_url", _flaky)
    assert fetch_exclusions(10, 1) == {("e", "c"): {"a/test_x"}}
    assert attempts["n"] == 3


def test_fetch_incomplete_read_is_retried(monkeypatch):
    # http.client.IncompleteRead (truncated S3 body) is not an OSError, so it must be listed
    # explicitly in the transient set and retried rather than surfacing as None immediately.
    monkeypatch.setattr(td_exclusions.time, "sleep", lambda s: None)
    attempts = {"n": 0}

    def _flaky(url: str) -> bytes:
        attempts["n"] += 1
        if attempts["n"] < 2:
            raise http.client.IncompleteRead(b"partial")
        return _gzip_json({"e": {"c": ["a/test_x"]}})

    monkeypatch.setattr(td_exclusions, "_open_url", _flaky)
    assert fetch_exclusions(14, 1) == {("e", "c"): {"a/test_x"}}
    assert attempts["n"] == 2


def test_fetch_http_5xx_is_retried(monkeypatch):
    monkeypatch.setattr(td_exclusions.time, "sleep", lambda s: None)
    attempts = {"n": 0}

    def _flaky(url: str) -> bytes:
        attempts["n"] += 1
        if attempts["n"] < 2:
            raise urllib.error.HTTPError(url, 503, "unavailable", {}, None)  # type: ignore[arg-type]
        return _gzip_json({"e": {"c": ["a/test_x"]}})

    monkeypatch.setattr(td_exclusions, "_open_url", _flaky)
    assert fetch_exclusions(11, 1) == {("e", "c"): {"a/test_x"}}
    assert attempts["n"] == 2


def test_fetch_gives_up_after_max_attempts(monkeypatch):
    monkeypatch.setattr(td_exclusions.time, "sleep", lambda s: None)
    attempts = {"n": 0}

    def _always_fail(url: str) -> bytes:
        attempts["n"] += 1
        raise urllib.error.URLError("down")

    monkeypatch.setattr(td_exclusions, "_open_url", _always_fail)
    assert fetch_exclusions(12, 1) is None
    assert attempts["n"] == td_exclusions.MAX_ATTEMPTS


def test_fetch_builds_expected_url(monkeypatch):
    seen: Dict[str, str] = {}

    def _capture(url: str) -> bytes:
        seen["url"] = url
        return _gzip_json({})

    monkeypatch.setattr(td_exclusions, "_open_url", _capture)
    fetch_exclusions(27320761463, 2)
    assert seen["url"] == (
        "https://ossci-raw-job-status.s3.amazonaws.com/additional_info/"
        "td_exclusions/27320761463/2"
    )
