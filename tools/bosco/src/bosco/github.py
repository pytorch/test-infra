from collections.abc import MutableMapping
import dataclasses
import enum
import json
import logging
import textwrap
from typing import Any
import urllib.request


class Client:
    """Represents a client to the GitHub API."""

    _endpoint: str
    _token: str

    def __init__(
        self, /, *, token: str, endpoint: str = 'https://api.github.com/graphql'
    ) -> None:
        self._endpoint = endpoint
        self._token = token

    async def graphql(
        self, /, template: str, **kwargs: Any
    ) -> MutableMapping[str, Any]:
        body = {
            'query': template,
            'variables': dict(**kwargs),
        }
        body_str = json.dumps(body, indent=4)

        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                'Posting to %s:%s    With arguments:\n%s',
                self._endpoint,
                textwrap.indent(textwrap.dedent(template), prefix='    '),
                textwrap.indent(json.dumps(body['variables'], indent=4), prefix='    '),
            )

        req = urllib.request.Request(
            self._endpoint,
            data=body_str.encode(),
            headers={
                'Authorization': f'bearer {self._token}',
            },
            method='POST',
        )
        rsp = urllib.request.urlopen(req)
        ret = json.loads(rsp.read())
        assert isinstance(ret, dict)
        return ret


@dataclasses.dataclass(frozen=True)
class Repository:
    """Represents a repository in GitHub."""

    # Which organization owns this pull request.
    organization: str
    # The name of the repository, unique only within an organization.
    name: str

    def __str__(self, /) -> str:
        """Formats the repository with under its organization's namespace."""
        return f'{self.organization}/{self.name}'


@dataclasses.dataclass(frozen=True)
class PR:
    """Represents a pull request in GitHub."""

    class State(enum.StrEnum):
        """Represents GitHub's pull request state enumeration."""

        # The pull request is open.
        OPEN = enum.auto()
        # The pull request is closed.
        CLOSED = enum.auto()
        # The pull request has been merged.
        MERGED = enum.auto()

    # Which repository this is a pull request against.
    repository: Repository
    # The number identifying this pull request in the repository.
    number: int

    @property
    def url(self, /) -> str:
        """Gets the URL to the pull request on GitHub."""
        return f'https://github.com/{self.repository}/pull/{self.number}'


logger = logging.getLogger(__name__)
