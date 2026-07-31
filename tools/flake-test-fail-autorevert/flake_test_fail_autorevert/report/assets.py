import logging
import os
import tempfile
import urllib.request
from typing import Optional


logger = logging.getLogger(__name__)

CHARTJS_VERSION = "4.5.1"
CHARTJS_URL = (
    f"https://cdn.jsdelivr.net/npm/chart.js@{CHARTJS_VERSION}/dist/chart.umd.min.js"
)
FETCH_TIMEOUT_SECONDS = 20

# The real minified UMD bundle is ~208 KB and ends by assigning the global. A
# truncated/torn write keeps the top banner but loses the tail, so require both a
# plausible length and the end-of-file global assignment before trusting content.
MIN_CHARTJS_BYTES = 100000
CHARTJS_END_MARKER = "window.Chart"

_ASSETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
CACHE_PATH = os.path.join(_ASSETS_DIR, "chart.umd.min.js")


def _warn(message: str) -> None:
    logger.warning("%s", message)


def _looks_like_chartjs(source: str) -> bool:
    return "Chart.js v4" in source or ("Chart" in source and "function" in source)


def _is_complete(source: str) -> bool:
    return (
        len(source.encode("utf-8")) >= MIN_CHARTJS_BYTES
        and CHARTJS_END_MARKER in source
    )


def _read_cache() -> Optional[str]:
    if not os.path.exists(CACHE_PATH):
        return None
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            source = f.read()
    except (OSError, UnicodeError) as exc:
        _warn(
            f"could not read cached Chart.js at {CACHE_PATH} "
            f"({type(exc).__name__}: {exc}); ignoring cache."
        )
        return None
    if not _looks_like_chartjs(source):
        _warn(f"cached Chart.js at {CACHE_PATH} does not look valid; ignoring cache.")
        return None
    if not _is_complete(source):
        _warn(
            f"cached Chart.js at {CACHE_PATH} looks truncated "
            f"({len(source.encode('utf-8'))} bytes, missing end marker "
            f"'{CHARTJS_END_MARKER}'); ignoring cache and re-fetching."
        )
        return None
    return source


def _write_cache(source: str) -> None:
    try:
        os.makedirs(_ASSETS_DIR, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=_ASSETS_DIR, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(source)
            os.replace(tmp_path, CACHE_PATH)
        except OSError:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            raise
    except OSError as exc:
        _warn(
            f"could not cache Chart.js at {CACHE_PATH} "
            f"({type(exc).__name__}: {exc}); charts still embedded this run."
        )


def _fetch() -> str:
    with urllib.request.urlopen(CHARTJS_URL, timeout=FETCH_TIMEOUT_SECONDS) as resp:
        return resp.read().decode("utf-8")


def get_chartjs(no_charts: bool) -> Optional[str]:
    if no_charts:
        return None

    cached = _read_cache()
    if cached is not None:
        return cached

    try:
        source = _fetch()
    except Exception as exc:
        _warn(
            f"could not fetch Chart.js from {CHARTJS_URL} "
            f"({type(exc).__name__}: {exc}); rendering tables-only. "
            "Re-run with network access to cache it."
        )
        logger.warning("Chart.js fetch failed", exc_info=True)
        return None

    if not _looks_like_chartjs(source) or not _is_complete(source):
        _warn(
            f"fetched content from {CHARTJS_URL} did not look like a complete "
            "Chart.js bundle; rendering tables-only."
        )
        return None

    _write_cache(source)
    return source
