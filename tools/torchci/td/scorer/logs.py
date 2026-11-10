"""Fetch and parse the TD job's log: per-heuristic scores, raised heuristics, changed files
and TD's aggregated scores.

The TD job prints `Results from <Heuristic>` followed by one `  <TestRun> (<score>)` line
per non-zero score, `Error in <Heuristic>: ...` when one raises, and `Changed files: [...]`,
then `Aggregated Heuristics` followed by the same score lines for TD's summed scores, once
every heuristic has run. Other text in the log (a heuristic's own output, an error message)
can contain lines of the same shape, so only what comes before the first `Aggregated
Heuristics` is read, only the first block per heuristic, and the aggregated block ends at
its first line that is not a score line.
"""

import ast
import gzip
import logging
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Iterable, Optional, TypeVar

import requests
from torchci.td.llm.events import test_file_of


logger = logging.getLogger(__name__)

RAW_BUCKET = "ossci-raw-job-status"
RAW_BUCKET_URL = f"https://{RAW_BUCKET}.s3.amazonaws.com"
LOG_URL = RAW_BUCKET_URL + "/log/{job_id}"
HTTP_TIMEOUT = 60
HTTP_RETRIES = 4
FETCH_WORKERS = 32

TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ")
RESULTS = re.compile(r"^Results from (\S+)$")
SCORE = re.compile(r"^  (\S.*) \(([^()\s]+)\)$")
ERROR = re.compile(r"^Error in (\S+?): ")
CHANGED = re.compile(r"^Changed files: (\[.*\])$")
HEURISTIC_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
AGGREGATED = "Aggregated Heuristics"

T = TypeVar("T")
R = TypeVar("R")


@dataclass(frozen=True)
class TDLog:
    # heuristic -> test file -> score; a class-level TestRun counts as its file's max.
    scores: dict[str, dict[str, float]]
    # Heuristics that printed results; one absent here contributes nothing.
    heuristics: tuple[str, ...]
    raised: tuple[str, ...]
    changed_files: Optional[tuple[str, ...]]
    # test file -> TD's aggregated score, the ranking of TD's own cut.
    aggregated: dict[str, float]


def active(heuristics: Iterable[str], raised: Iterable[str]) -> set[str]:
    return set(heuristics) - set(raised)


def _score_line(line: str) -> Optional[tuple[str, float]]:
    """(test file, score) of a `  <TestRun> (<score>)` line; a non-finite score reads as
    no score."""
    match = SCORE.match(line)
    if not match:
        return None
    try:
        score = float(match.group(2))
    except ValueError:
        score = math.nan
    return test_file_of(match.group(1)), score


def _add_max(per_file: dict[str, float], name: str, score: float) -> None:
    if math.isfinite(score):
        per_file[name] = max(score, per_file.get(name, score))


def _changed_files(text: str) -> Optional[tuple[str, ...]]:
    try:
        value = ast.literal_eval(text)
    except (ValueError, SyntaxError):
        return None
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        return None
    return tuple(value)


def parse_td_log(text: str) -> Optional[TDLog]:
    """None for a log without `Aggregated Heuristics` or `Results from` before it (a
    partial or foreign log)."""
    scores: dict[str, dict[str, float]] = {}
    aggregated: dict[str, float] = {}
    raised: set[str] = set()
    changed: Optional[tuple[str, ...]] = None
    current: Optional[str] = None
    complete = False
    for raw in text.splitlines():
        line = TIMESTAMP.sub("", raw, count=1).rstrip()
        if complete:
            scored = _score_line(line)
            if scored is None:
                break
            _add_max(aggregated, *scored)
            continue
        if line == AGGREGATED:
            complete = True
            continue
        if current is not None:
            scored = _score_line(line)
            if scored is not None:
                _add_max(scores[current], *scored)
                continue
            current = None
        match = RESULTS.match(line)
        if match:
            name = match.group(1)
            if HEURISTIC_NAME.match(name) and name not in scores:
                scores[name] = {}
                current = name
            continue
        match = ERROR.match(line)
        if match:
            if HEURISTIC_NAME.match(match.group(1)):
                raised.add(match.group(1))
            continue
        match = CHANGED.match(line)
        if match and changed is None:
            changed = _changed_files(match.group(1))
    if not complete or not scores:
        return None
    return TDLog(
        scores={h: {f: s for f, s in v.items() if s != 0} for h, v in scores.items()},
        heuristics=tuple(sorted(scores)),
        raised=tuple(sorted(raised - set(scores))),
        changed_files=changed,
        aggregated={f: s for f, s in aggregated.items() if s != 0},
    )


_local = threading.local()


def _session() -> requests.Session:
    if not hasattr(_local, "session"):
        _local.session = requests.Session()
    return _local.session  # type: ignore[no-any-return]


def http_get(url: str, timeout: float = HTTP_TIMEOUT) -> Optional[bytes]:
    """The body, gunzipped when gzip; None on 404 (the bucket allows listing, so S3
    answers 404 for a missing key). Any other 4xx raises at once; 5xx, network and
    gzip errors are retried, then raise."""
    for attempt in range(HTTP_RETRIES):
        try:
            response = _session().get(url, timeout=timeout)
            if response.status_code == 404:
                return None
            if response.status_code < 500:
                response.raise_for_status()
            else:
                raise requests.RequestException(f"{response.status_code} from {url}")
            body = response.content
            return gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body
        except requests.HTTPError:
            raise
        except (requests.RequestException, OSError, EOFError) as e:
            if attempt == HTTP_RETRIES - 1:
                raise
            logger.warning("GET %s failed (%s), retrying", url, e)
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def fetch_td_log(job_id: int) -> Optional[TDLog]:
    return fetch_td_log_found(job_id)[0]


def fetch_td_log_found(job_id: int) -> tuple[Optional[TDLog], bool]:
    """The parsed log (None when absent or unparsable), and whether the object exists:
    False only on a 404."""
    body = http_get(LOG_URL.format(job_id=job_id))
    if body is None:
        return None, False
    return parse_td_log(body.decode("utf-8", errors="replace")), True


def map_threaded(
    func: Callable[[T], R], items: Iterable[T], workers: int = FETCH_WORKERS
) -> list[R]:
    """`func` over `items` on a bounded thread pool, results in input order; the first
    exception is raised."""
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(func, items))
