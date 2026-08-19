"""Log-readability pre-filter.

~16% of raw job logs at ossci-raw-job-status/log/{job_id} are stubs (<1KB) or
missing; dispatching the advisor on them wastes runs and yields junk verdicts.
HEAD-check the object size and skip anything below MIN_LOG_BYTES or absent.

Uses a single stdlib `urllib.request` HEAD to the PUBLIC S3 URL — the bucket is
public-read and the Lambda has egress, so no `aws`/`curl` binary, IAM, or creds
are needed (both were absent in the Lambda runtime). Content-Length is trusted
ONLY on a 2xx response; a non-2xx (403/404/…) or any error means unreadable
(conservative: don't dispatch on an unverifiable log).
"""

from __future__ import annotations

import logging
import urllib.error
import urllib.request
from typing import Optional

from .config import MIN_LOG_BYTES, S3_LOG_BUCKET


log = logging.getLogger(__name__)

_HEAD_TIMEOUT_SECONDS = 15


def has_readable_log(job_id: int, *, min_bytes: int = MIN_LOG_BYTES) -> bool:
    """True iff the raw log object exists (2xx) and is at least `min_bytes`."""
    size = _log_content_length(job_id)
    if size is None:
        return False
    return size >= min_bytes


def _log_content_length(job_id: int) -> Optional[int]:
    url = f"https://{S3_LOG_BUCKET}.s3.amazonaws.com/log/{job_id}"
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=_HEAD_TIMEOUT_SECONDS) as resp:
            # urlopen raises HTTPError for >=400, so reaching here is 2xx/3xx;
            # require an explicit 2xx before trusting Content-Length.
            status = getattr(resp, "status", None)
            if status is None or not (200 <= status < 300):
                return None
            content_length = resp.headers.get("Content-Length")
            if content_length is None:
                return None
            return int(content_length)
    except urllib.error.HTTPError as e:
        # Missing / forbidden object (404/403/…) → unreadable.
        log.debug("[coverage] log HEAD %s → HTTP %s", job_id, e.code)
        return None
    except (urllib.error.URLError, ValueError, OSError) as e:
        log.warning("[coverage] log HEAD %s failed: %s", job_id, e)
        return None
