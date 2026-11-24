"""The contents API's answer for a repo's ``REPO_CONFIG_PATH``, judged the same way by every reader of it.

``contents_answer`` is the one judgement of an answer: a directory, any other kind of entry than a file, a
file over ``CONFIG_MAX_BYTES`` and a file that is not base64-encoded UTF-8 text cannot be a config. The
scan's config cache (``config_cache``) and the verdict's read (``repo_config.read_settings``) both use it.
"""

from __future__ import annotations

import base64
import binascii
import logging
from typing import Any, NamedTuple

from greenlight.constants import CONFIG_MAX_BYTES, REPO_CONFIG_PATH

logger = logging.getLogger(__name__)


def config_url(repo: str) -> str:
    """The contents API path of ``repo``'s config file, on its default branch."""
    return f"/repos/{repo}/contents/{REPO_CONFIG_PATH}"


def too_big(size: int) -> str:
    return f"the file is {size} bytes, over the {CONFIG_MAX_BYTES}-byte limit"


class ContentsAnswer(NamedTuple):
    """A contents API answer for the config file: its ``text`` (None when it cannot be a config, ``reason``
    saying why) and its ``size`` (None for a directory)."""

    text: str | None
    size: int | None
    reason: str | None


def contents_answer(data: Any) -> ContentsAnswer:
    """Judge a contents API answer; ``ValueError`` on an answer that is no contents response."""
    if isinstance(data, list):
        return ContentsAnswer(None, None, "it is a directory, not a file")
    if not isinstance(data, dict) or not isinstance(data.get("size"), int):
        raise ValueError("the contents API answered an unexpected shape")
    size: int = data["size"]
    if data.get("type") != "file":
        return ContentsAnswer(None, size, f"it is a {data.get('type')}, not a file")
    if size > CONFIG_MAX_BYTES:
        return ContentsAnswer(None, size, too_big(size))
    try:
        text = base64.b64decode(str(data.get("content", "")), validate=False).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        logger.error("the contents API answered a file that is not base64-encoded UTF-8", exc_info=True)
        return ContentsAnswer(None, size, "the file is not UTF-8 text")
    return ContentsAnswer(text, size, None)
