"""PyTorch Target-Determination (TD) file-exclusion artifacts, read from S3.

TD is PER-CONFIG: for a workflow run it records, for each (build_env, test_config), the set
of test FILES it excluded from the pre-merge `pull` run, and publishes it to a public S3
object keyed by (workflow_run_id, run_attempt). The body is gzipped JSON
``{build_env: {test_config: [excluded_file, ...]}}`` where each entry is a path relative to
``test/`` WITHOUT the ``.py`` suffix (e.g. ``distributed/checkpoint/test_checkpoint``). The
same file can be excluded from one config and kept in another, so exclusions MUST be matched
against the specific (build_env, test_config) where the test failed — not unioned.

The artifact records ONLY what TD deselected: a (build_env, test_config) appears here only
when it excluded at least one file, so it CANNOT be read as a matrix-membership list — a
config absent from the dict may still have run with nothing excluded. Pull-matrix membership
comes from the run's real jobs (see queries.fetch_pull_configs), never this file.
Some (older) runs emit a single sentinel key ``{"NoBuildEnv": {"NoTestConfig": [...]}}``
instead of real per-config data. is_flat()/flat_excluded_files() detect that shape so the
classifier can fall back to file-level matching (the flat list applies to no attributable
config) rather than treating the whole artifact as per-config.
"""

import gzip
import http.client
import json
import logging
import socket
import time
import urllib.error
import urllib.request
import zlib
from typing import Dict, Optional, Set, Tuple

from .client import BASE_DELAY_SECONDS, MAX_ATTEMPTS


logger = logging.getLogger(__name__)

# Per-config exclusion map: (build_env, test_config) -> normalized excluded test files.
ExclusionMap = Dict[Tuple[str, str], Set[str]]

# Sentinel key older TD runs use when they record a single flat exclusion list with no real
# per-(build_env, test_config) attribution. Defined here so flat-ness is detected in exactly
# one place; callers use is_flat()/flat_excluded_files() rather than sniffing keys.
_FLAT_SENTINEL = ("NoBuildEnv", "NoTestConfig")

# Public, anonymous bucket; the corporate proxy reaches it, so no NO_PROXY handling.
TD_EXCLUSIONS_URL = (
    "https://ossci-raw-job-status.s3.amazonaws.com/additional_info/td_exclusions/"
    "{run_id}/{run_attempt}"
)

HTTP_TIMEOUT_SECONDS = 30

_GZIP_MAGIC = b"\x1f\x8b"

# Per-process memo keyed by (run_id, run_attempt). None = unresolvable (404, HTTP error
# after retries, or a parse failure); an empty dict = the artifact was an empty {}.
_CACHE: Dict[Tuple[int, int], Optional[ExclusionMap]] = {}


def normalize_test_file(path: str) -> str:
    """Canonical key for matching a signal's file against a TD-excluded entry.
    The signal carries ``dir/name.py``; the artifact carries ``dir/name`` relative to
    ``test/``. Strip a trailing ``.py`` and a leading ``test/`` and normalize separators so
    both forms collapse to one key."""
    key = path.replace("\\", "/").strip().strip("/")
    if key.endswith(".py"):
        key = key[: -len(".py")]
    if key.startswith("test/"):
        key = key[len("test/") :]
    return key


def is_flat(exclusions: ExclusionMap) -> bool:
    """True when the artifact carries ONLY the NoBuildEnv/NoTestConfig sentinel — a single
    flat exclusion list with no real per-(build_env, test_config) attribution. Callers use
    this to fall back to file-level matching instead of per-config matching."""
    return set(exclusions) == {_FLAT_SENTINEL}


def flat_excluded_files(exclusions: ExclusionMap) -> Set[str]:
    """The flat sentinel's excluded file set (empty when absent). Only meaningful together
    with is_flat(); keeps the sentinel key private to this module."""
    return exclusions.get(_FLAT_SENTINEL, set())


def _open_url(url: str) -> bytes:
    """GET the URL anonymously and return the raw (still-gzipped) response body.
    Isolated so tests can substitute the transport with no network."""
    with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT_SECONDS) as resp:
        return resp.read()


def _parse_exclusions(raw: bytes) -> ExclusionMap:
    """Decode the artifact body into a per-(build_env, test_config) map of excluded files.
    The object is stored gzipped (Content-Encoding: gzip) and urllib does not decompress
    it, so gunzip when the gzip magic is present. Every level is type-checked defensively:
    non-dict envs/configs and non-list file arrays are skipped, and a stray string (not a
    list) is NOT iterated character-by-character. A config present with an empty list is kept
    as an empty set (it excluded no files); this is faithful to the artifact but implies
    nothing about matrix membership, which is not derivable here."""
    if raw[:2] == _GZIP_MAGIC:
        raw = gzip.decompress(raw)
    data = json.loads(raw)
    exclusions: ExclusionMap = {}
    if not isinstance(data, dict):
        return exclusions
    for build_env, test_configs in data.items():
        if not isinstance(build_env, str) or not isinstance(test_configs, dict):
            continue
        for test_config, files in test_configs.items():
            if not isinstance(test_config, str) or not isinstance(files, list):
                continue
            exclusions[(build_env, test_config)] = {
                normalize_test_file(path) for path in files if isinstance(path, str)
            }
    return exclusions


def _get_with_retry(url: str) -> Optional[bytes]:
    """Fetch raw bytes with exponential backoff, mirroring client.run_query.
    A 404 means the run has no TD artifact and fails fast (returns None); other HTTP
    errors and transport faults (DNS/proxy flaps) are transient and retried."""
    last_exc: Optional[BaseException] = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return _open_url(url)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            last_exc = exc
        except (
            urllib.error.URLError,
            http.client.IncompleteRead,
            socket.timeout,
            OSError,
        ) as exc:
            # IncompleteRead (truncated S3 body) is transient like a DNS/proxy flap and is
            # NOT an OSError, so it is listed explicitly to be retried rather than raised.
            last_exc = exc
        if attempt == MAX_ATTEMPTS:
            break
        delay = BASE_DELAY_SECONDS * (2 ** (attempt - 1))
        logger.warning(
            "td_exclusions GET failed (attempt %d/%d), retrying in %.0fs: %s: %s",
            attempt,
            MAX_ATTEMPTS,
            delay,
            type(last_exc).__name__,
            last_exc,
        )
        time.sleep(delay)
    logger.warning("td_exclusions GET gave up for %s: %s", url, last_exc, exc_info=True)
    return None


def fetch_exclusions(run_id: int, run_attempt: int) -> Optional[ExclusionMap]:
    """Per-(build_env, test_config) TD-excluded file map for (run_id, run_attempt).
    None on 404 / HTTP error after retries / parse error; an empty dict for an empty ({})
    artifact. Each (run_id, run_attempt) is fetched at most once per process. A parse
    failure — including a malformed schema surfacing as TypeError/AttributeError — is
    logged and mapped to None (the caller treats it as td_unknown); it NEVER propagates to
    escalate a whole commit to ERROR."""
    key = (run_id, run_attempt)
    if key in _CACHE:
        return _CACHE[key]
    raw = _get_with_retry(TD_EXCLUSIONS_URL.format(run_id=run_id, run_attempt=run_attempt))
    result: Optional[ExclusionMap]
    if raw is None:
        result = None
    else:
        try:
            result = _parse_exclusions(raw)
        except (
            ValueError,
            TypeError,
            AttributeError,
            OSError,
            EOFError,
            zlib.error,
        ) as exc:
            logger.warning(
                "td_exclusions parse failed for %s/%s: %s",
                run_id,
                run_attempt,
                exc,
                exc_info=True,
            )
            result = None
    _CACHE[key] = result
    return result
