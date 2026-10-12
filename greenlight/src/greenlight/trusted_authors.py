"""Read greenlight's trusted-author list, which only the scan uses, from a pytorch/test-infra issue.

The body must open with a fenced code block that holds one ``@login`` per line::

    ```
    # blank lines and '#' comments are allowed
    @alice
    @bob
    ```

The first non-blank line is the opening fence: up to three leading spaces, exactly three
backticks, then either nothing or the info string ``text`` in any case, with spaces or tabs around
it allowed. Any other info string is refused, because GitHub draws some languages, such as
``mermaid`` or ``math``, as a picture in place of the lines. The block ends at the first later line
that is exactly three backticks, with up to three leading spaces and trailing spaces or tabs;
everything after it is ignored. Anything else -- text before the fence, a fence that never closes,
a line in the block that is not ``@login`` -- is an error, so greenlight never reads an entry that a
reader of the rendered issue cannot see. Logins come back lowercased.
"""

from __future__ import annotations

import logging
import re
import urllib.parse
from typing import TYPE_CHECKING, Protocol

from greenlight import constants

if TYPE_CHECKING:
    from collections.abc import Mapping

logger = logging.getLogger(__name__)

_OPENING_FENCE_RE = re.compile(r" {0,3}```[ \t]*(?:text[ \t]*)?", re.IGNORECASE)
_CLOSING_FENCE_RE = re.compile(r" {0,3}```[ \t]*")
_ENTRY_RE = re.compile(r"@([A-Za-z0-9][A-Za-z0-9-]{0,38})")
_API_REPOS_PATH = "/repos/"


class TrustedAuthorsError(ValueError):
    """The trusted-authors issue is not the configured issue, or its body is not a valid list."""


class _Issue(Protocol):
    @property
    def raw_data(self) -> Mapping[str, object]: ...


class _IssueRepo(Protocol):
    def get_issue(self, number: int) -> _Issue: ...


class IssueClient(Protocol):
    """Structural GitHub client for the trusted-authors issue read; the real ``github.Github`` satisfies it."""

    def get_repo(self, full_name_or_id: str) -> _IssueRepo: ...


def _line_error(number: int, line: str, problem: str) -> TrustedAuthorsError:
    return TrustedAuthorsError(f"trusted-authors issue line {number}: {line!r}: {problem}")


def parse_trusted_logins(body: str | None) -> frozenset[str]:
    """Return the lowercased logins listed in ``body``; raise ``TrustedAuthorsError`` if it is malformed."""
    if body is None or not body.strip():
        raise TrustedAuthorsError(f"trusted-authors issue body is empty: {body!r}")
    # Markdown ends lines only at \n, \r\n and \r. str.splitlines also splits on characters such as
    # U+2028, which would hand the parser lines that the rendered issue does not have.
    lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    start = next(index for index, line in enumerate(lines) if line.strip())
    if not _OPENING_FENCE_RE.fullmatch(lines[start]):
        raise _line_error(
            start + 1, lines[start], "the first non-blank line must open a ``` fence whose info string is empty or text"
        )
    logins: set[str] = set()
    for number, line in enumerate(lines[start + 1 :], start=start + 2):
        if _CLOSING_FENCE_RE.fullmatch(line):
            return frozenset(logins)
        entry = line.strip()
        if not entry or entry.startswith("#"):
            continue
        match = _ENTRY_RE.fullmatch(entry)
        if match is None:
            raise _line_error(number, line, "expected '@login', a '#' comment or a blank line")
        logins.add(match.group(1).lower())
    raise _line_error(start + 1, lines[start], "the opening fence is never closed")


def _answered_repo(data: Mapping[str, object]) -> str | None:
    """``owner/name`` from the response's ``repository_url`` (``https://api.github.com/repos/owner/name``)."""
    url = data.get("repository_url")
    if not isinstance(url, str):
        return None
    path = urllib.parse.urlsplit(url).path
    return path.removeprefix(_API_REPOS_PATH) if path.startswith(_API_REPOS_PATH) else None


def _require_configured_issue(data: Mapping[str, object], repo: str, number: int) -> None:
    answered_repo = _answered_repo(data)
    if answered_repo is None or constants.normalize_repo(answered_repo) != constants.normalize_repo(repo):
        raise TrustedAuthorsError(
            f"trusted-authors issue {repo}#{number} resolved to repository_url "
            f"{data.get('repository_url')!r}, which is not {repo}"
        )
    if data.get("number") != number:
        raise TrustedAuthorsError(f"trusted-authors issue {repo}#{number} resolved to number {data.get('number')!r}")
    if "pull_request" in data:
        raise TrustedAuthorsError(f"trusted-authors issue {repo}#{number} is a pull request, not an issue")


def fetch_trusted_logins(client: IssueClient) -> frozenset[str]:
    """Read, identity-check and parse the trusted-authors issue. Every failure raises; there is no fallback.

    The response must be the configured issue itself: GitHub answers a transferred issue with a 301
    that PyGithub follows silently, and serves pull requests from the same issues endpoint.
    """
    repo = constants.TRUSTED_AUTHORS_ISSUE_REPO
    number = constants.TRUSTED_AUTHORS_ISSUE_NUMBER
    # raw_data loads a lazy Issue and is the JSON GitHub answered with, after any redirect; a lazy
    # Issue's typed ``number`` is parsed from the requested URL instead.
    data = client.get_repo(repo).get_issue(number).raw_data
    _require_configured_issue(data, repo, number)
    body = data.get("body")
    if body is not None and not isinstance(body, str):
        raise TrustedAuthorsError(f"trusted-authors issue {repo}#{number} body is {type(body).__name__}, not text")
    logins = parse_trusted_logins(body)
    logger.info(
        "trusted-authors issue %s#%d (updated_at %s) lists %d login(s): %s",
        repo,
        number,
        data.get("updated_at"),
        len(logins),
        sorted(logins),
    )
    return logins
