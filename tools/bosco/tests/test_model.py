from __future__ import annotations

import asyncio
from collections.abc import Container, Iterable, MutableMapping, Sequence
import http.server
import json
import logging
import threading
import types
from typing import Optional, Type

import pytest

import bosco.github
import bosco.model


@pytest.mark.parametrize(
    ('is_draft', 'state', 'labels', 'expected'),
    [
        (False, bosco.github.PR.State.OPEN, ['label'], bosco.model.PR.State.OPEN),
        (True, bosco.github.PR.State.OPEN, ['label'], bosco.model.PR.State.DRAFT),
        (False, bosco.github.PR.State.CLOSED, ['label'], bosco.model.PR.State.CLOSED),
        (False, bosco.github.PR.State.CLOSED, ['Merged'], bosco.model.PR.State.MERGED),
    ],
)
def test_state_from_response(
    is_draft: bool,
    state: bosco.github.PR.State,
    labels: Container[str],
    expected: bosco.model.PR.State,
) -> None:
    assert bosco.model.PR.State._from_response(is_draft, state, labels) == expected


@pytest.mark.parametrize(
    ('reviews', 'expected'),
    [
        ([], False),
        (
            [
                bosco.model.PR.Review(
                    author='jacobo', state=bosco.model.PR.Review.State.COMMENTED
                )
            ],
            False,
        ),
        (
            [
                bosco.model.PR.Review(
                    author='jacobo', state=bosco.model.PR.Review.State.COMMENTED
                ),
                bosco.model.PR.Review(
                    author='jacobo', state=bosco.model.PR.Review.State.APPROVED
                ),
            ],
            True,
        ),
    ],
)
def test_approved(reviews: Iterable[bosco.model.PR.Review], expected: bool) -> None:
    pr = bosco.model.PR(
        pr=bosco.github.PR(_BOSCO, 777),
        author='me',
        state=bosco.model.PR.State.OPEN,
        labels=['label'],
        reviews=reviews,
        branch='pr777',
    )
    assert pr.approved == expected


class FakeGitHub(http.server.HTTPServer):
    """Implements a fake GitHub server."""

    _token: str
    _thread: threading.Thread
    _prs: MutableMapping[bosco.github.PR, bosco.model.PR]

    def __init__(self, /) -> None:
        super().__init__(('', 0), FakeHandler)
        self._token = str(id(object()))
        self._thread = threading.Thread(target=self.serve_forever)
        self._prs = {}

    def __enter__(self, /) -> FakeGitHub:
        self._thread.start()
        return self

    def __exit__(
        self,
        /,
        exc_type: Optional[Type[BaseException]],
        exc_value: Optional[BaseException],
        traceback: Optional[types.TracebackType],
    ) -> None:
        self.shutdown()
        self._thread.join()

    def create_client(self, /) -> bosco.github.Client:
        """Returns a client that communicates with this instance."""
        endpoint = f'http://{self.server_name}:{self.server_port}'
        return bosco.github.Client(endpoint=endpoint, token=self._token)

    def add_pr(self, pr: bosco.model.PR) -> None:
        """Registers a PR with the system."""
        self._prs[pr.pr] = pr


class FakeHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self, /) -> None:
        length = int(self.headers['Content-Length'])
        body_text = self.rfile.read(length)
        body = json.loads(body_text)
        # We only have a single graphql call for now.
        assert body['query'] == bosco.model.PR._QUERY
        self.send_response(200)
        self.end_headers()
        assert isinstance(self.server, FakeGitHub)
        pr = self.server._prs[bosco.github.PR(_BOSCO, 777)]
        response = {
            'author': {'login': pr.author},
            'headRefName': pr.branch,
            'isDraft': pr.state is bosco.model.PR.State.DRAFT,
            'state': str(pr.state).upper(),
            'labels': {'nodes': [{'name': label} for label in pr.labels]},
            'reviews': {
                'nodes': [
                    {
                        'author': {'login': review.author},
                        'state': str(review.state).upper(),
                    }
                    for review in pr.reviews
                ]
            },
        }
        response_body = json.dumps({'data': {'repository': {'pullRequest': response}}})
        self.wfile.write(response_body.encode())


@pytest.mark.parametrize(
    ('level', 'expected'),
    [
        (logging.INFO, []),
        (logging.DEBUG, [(logging.DEBUG, 'Posting to ')]),
    ],
)
def test_query(
    level: int, expected: Sequence[tuple[int, str]], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(level, logger=bosco.github.logger.name)

    expected_pr = bosco.model.PR(
        bosco.github.PR(_BOSCO, 777),
        author='jacobo',
        state=bosco.model.PR.State.OPEN,
        labels=['topic: not user facing'],
        reviews=[
            bosco.model.PR.Review(
                author='george', state=bosco.model.PR.Review.State.COMMENTED
            )
        ],
        branch='pr777',
    )

    with FakeGitHub() as fake_github:
        fake_github.add_pr(expected_pr)

        client = fake_github.create_client()
        pr = asyncio.run(bosco.model.PR.query(client, bosco.github.PR(_BOSCO, 777)))

        assert pr == expected_pr

    for got, want in zip(caplog.records, expected, strict=True):
        assert got.levelno == want[0]
        assert want[1] in got.message


_BOSCO = bosco.github.Repository('bosco-corp', 'bosco')
