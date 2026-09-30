from __future__ import annotations

import pytest

from greenlight import constants, trusted_authors
from greenlight.trusted_authors import TrustedAuthorsError

_REPO = constants.TRUSTED_AUTHORS_ISSUE_REPO
_NUMBER = constants.TRUSTED_AUTHORS_ISSUE_NUMBER


def test_parse_trusted_logins_returns_the_lowercased_logins_of_the_leading_fenced_block():
    body = "```\n# maintainers\n@AlbanD\n\n@bob\n```\n@ignored-after-the-block\n"

    assert trusted_authors.parse_trusted_logins(body) == frozenset({"alband", "bob"})


@pytest.mark.parametrize(
    "body",
    [
        pytest.param("Trusted authors:\n```\n@alice\n```", id="text-before-the-fence"),
        pytest.param("```\n- @alice\n```", id="line-that-is-not-a-login"),
        pytest.param("```\n@alice\n", id="unclosed-fence"),
    ],
)
def test_parse_trusted_logins_rejects_a_malformed_body(body):
    with pytest.raises(TrustedAuthorsError):
        trusted_authors.parse_trusted_logins(body)


class _FakeIssue:
    def __init__(self, raw_data: dict[str, object]) -> None:
        self.raw_data = raw_data


class _FakeIssueClient:
    def __init__(self, raw_data: dict[str, object]) -> None:
        self._raw_data = raw_data
        self.requested: list[tuple[str, int]] = []
        self._repo = ""

    def get_repo(self, full_name_or_id: str) -> _FakeIssueClient:
        self._repo = full_name_or_id
        return self

    def get_issue(self, number: int) -> _FakeIssue:
        self.requested.append((self._repo, number))
        return _FakeIssue(self._raw_data)


def _issue(repository_url: str = f"https://api.github.com/repos/{_REPO}") -> dict[str, object]:
    return {"repository_url": repository_url, "number": _NUMBER, "body": "```\n@Bob\n@alice\n```\n"}


def test_fetch_trusted_logins_reads_the_configured_issue():
    client = _FakeIssueClient(_issue())

    assert trusted_authors.fetch_trusted_logins(client) == frozenset({"alice", "bob"})
    assert client.requested == [(_REPO, _NUMBER)]


def test_fetch_trusted_logins_refuses_an_issue_that_moved_to_another_repository():
    # GitHub answers a transferred issue with a redirect that PyGithub follows silently.
    client = _FakeIssueClient(_issue("https://api.github.com/repos/pytorch/pytorch"))

    with pytest.raises(TrustedAuthorsError, match="repository_url"):
        trusted_authors.fetch_trusted_logins(client)
