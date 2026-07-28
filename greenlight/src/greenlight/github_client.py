"""Thin wrapper around the GitHub API for listing open pull requests."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable
    from typing import Protocol

    from github import Github

    class _PRUser(Protocol):
        @property
        def login(self) -> str: ...

    class _PRIssue(Protocol):
        @property
        def number(self) -> int: ...
        @property
        def user(self) -> _PRUser | None: ...
        @property
        def title(self) -> str: ...
        @property
        def html_url(self) -> str: ...

    class _PRSearchClient(Protocol):
        def search_issues(self, query: str) -> Iterable[_PRIssue]: ...


@dataclass(frozen=True, slots=True)
class OpenPR:
    repo: str
    number: int
    author: str
    title: str
    url: str


def build_client(token: str) -> Github:
    from github import Auth, Github  # lazy: keeps this module importable without the dep

    return Github(auth=Auth.Token(token))


def list_open_prs_by_authors(client: _PRSearchClient, repo: str, authors: Iterable[str]) -> list[OpenPR]:
    prs: list[OpenPR] = []
    for author in authors:
        query = f"repo:{repo} is:open is:pr author:{author}"
        for issue in client.search_issues(query):
            user = issue.user
            prs.append(
                OpenPR(
                    repo=repo,
                    number=issue.number,
                    author=user.login if user is not None else author,
                    title=issue.title,
                    url=issue.html_url,
                )
            )
    return prs
