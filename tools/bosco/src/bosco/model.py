from __future__ import annotations

from collections.abc import Container, Iterable, MutableMapping
import dataclasses
import enum
import textwrap
from typing import Any

import bosco.github


@dataclasses.dataclass
class PR:
    class State(enum.StrEnum):
        """The state of the PR as we are concerned about within Bosco.

        Note that this is distinct from the native GitHub notion of a
        PR's state in a few interesting ways.
        * we incorporate a draft state
        * we incorporate PyTorch's notion of merged into the state

        The bosco.github.State enumeration maps directly to the GitHub
        API values.
        """

        # The PR is open and in the draft state.
        DRAFT = enum.auto()
        # The PR is open and ready for review.
        OPEN = enum.auto()
        # The PR has been closed and not merged.
        CLOSED = enum.auto()
        # The PR has been merged.
        MERGED = enum.auto()

        @staticmethod
        def _from_response(
            is_draft: bool, github_state: bosco.github.PR.State, labels: Container[str]
        ) -> PR.State:
            """Creates a model state from the query response."""
            state = PR.State(str(github_state))
            assert state is not PR.State.DRAFT

            if 'Merged' in labels:
                assert state == PR.State.CLOSED
                state = PR.State.MERGED

            if state is PR.State.CLOSED or state is PR.State.MERGED:
                assert not is_draft
                return state
            else:
                assert state is PR.State.OPEN
                return PR.State.DRAFT if is_draft else state

    @dataclasses.dataclass
    class Review:
        """Represents a comment on a pull request."""

        class State(enum.StrEnum):
            """Whether or not the comment was approved."""

            # The comment approves of the PR.
            APPROVED = enum.auto()
            # No approval granted.
            COMMENTED = enum.auto()

        # The user who left the comment.
        author: str
        # The approval status of the comment.
        state: State

    # Identifies which PR this is referring to.
    pr: bosco.github.PR

    # Who created the PR.
    author: str
    # What state is the PR in, e.g. draft, merged, etc.
    state: State
    # What labels are set on the PR.
    labels: Iterable[str]
    # What reviews or comments have been added to the PR.
    reviews: Iterable[Review]
    # What branch is the PR merging from.
    branch: str

    @property
    def approved(self, /) -> bool:
        """Whether or not the PR has an approving comment."""
        return any(review.state == PR.Review.State.APPROVED for review in self.reviews)

    @classmethod
    async def query(cls, client: bosco.github.Client, pr: bosco.github.PR) -> PR:
        """Queries a model from GitHub."""
        rsp = await client.graphql(
            cls._QUERY,
            organization=pr.repository.organization,
            repository=pr.repository.name,
            number=pr.number,
        )
        # Note, we pop off data from the response as we read it to
        # ensure that we aren't asking for data that we don't need,
        # and aren't overlooking data that we wanted but forgot to
        # grab.
        data = _pop(rsp, 'data', 'repository', 'pullRequest')
        assert len(rsp) == 0, data
        author = _pop(data, 'author', 'login')
        branch = _pop(data, 'headRefName')
        is_draft = _pop(data, 'isDraft')
        state = bosco.github.PR.State(data.pop('state').lower())
        labels = [_pop(label, 'name') for label in _pop(data, 'labels', 'nodes')]

        reviews = []
        for review in _pop(data, 'reviews', 'nodes'):
            reviews.append(
                PR.Review(
                    _pop(review, 'author', 'login'),
                    PR.Review.State(_pop(review, 'state').lower()),
                )
            )
            assert len(review) == 0, review

        assert len(data) == 0, data

        return PR(
            pr=pr,
            author=author,
            branch=branch,
            labels=labels,
            reviews=reviews,
            state=PR.State._from_response(is_draft, state, labels),
        )

    _QUERY = textwrap.dedent(
        '''
        query($organization: String!, $repository: String!, $number: Int!) {
            repository(owner: $organization, name: $repository) {
                pullRequest(number: $number) {
                    author { login }
                    headRefName
                    isDraft
                    labels(first: 100) { nodes { name } }
                    reviews(first: 100) { nodes { author { login } state } }
                    state
                }
            }
        }
        '''
    )


def _pop(map: MutableMapping[str, Any], key: str, *keys: str) -> Any:
    """Pops fields off of a map, ensuring intermediates are empty.

    This requires at least one key, but additional keys imply that we
    have intermediate maps we are extracting from. The intermediate
    maps are temporaries and we ensure they are empty since nothing
    else will be able to access them after this returns.

    This also shows useful information if a key expected to be present
    is not.
    """
    node = map.pop(key)
    key_not_found = object()
    for key in keys:
        next = node.pop(key, key_not_found)
        assert next is not key_not_found, node
        assert len(node) == 0, node
        node = next
    return node
