from __future__ import annotations

from collections.abc import Iterable
import dataclasses
import logging
from typing import Any, Optional

from bosco import github


def no_op(*args: Any, **kwargs: Any) -> None:
    pass


@dataclasses.dataclass
class Branch:
    name: str

    def is_sapling_for(self, pr_id: int, /) -> bool:
        return self.name == f'pr{pr_id}'

    def is_ghstack_for(self, user: str, /) -> bool:
        tokens = self.name.split('/')
        if len(tokens) != 4:
            return False
        gh, owner, num, type = tokens
        if gh != 'gh' or owner != 'owner' or type != 'head':
            return False
        if len(num) < 1:
            return False
        if num[0] == '0':
            return False
        return all('0' <= c <= '9' for c in num)

    async def exists(self, /, gh: github.GH, repository: github.Repository) -> bool:
        result = await gh.api(
            f'/repos/pytorch/pytorch/git/refs/heads/{self.name}', check=False
        )
        logger.debug(result)
        return result.completed_process.returncode == 0

    async def delete(self, /, gh: github.GH, repository: github.Repository) -> None:
        await gh.api(
            f'/repos/pytorch/pytorch/git/refs/heads/{self.name}', check=True,
            method='DELETE',
        )
        


@dataclasses.dataclass
class PR(github.PR):
    author: str
    state: github.PR.State
    labels: Iterable[str]
    reviews: Iterable[github.Review]
    branch: Branch
    checks: Optional[github.Checks] = None

    @property
    def approved(self, /) -> bool:
        return any(
            review.state == github.Review.State.APPROVED for review in self.reviews
        )

    @staticmethod
    async def query(gh: github.GH, pr: github.PR) -> PR:
        result = await gh.pr.view(
            pr, json=['author', 'headRefName', 'isDraft', 'labels', 'reviews', 'state']
        )
        author = result.pop('author').pop('login')
        branch = Branch(result.pop('headRefName'))
        state = PR.State(result.pop('state').lower())
        is_draft = result.pop('isDraft')

        labels = []
        for label in result.pop('labels'):
            labels.append(label.pop('name'))
            # We don't use these fields.
            github.Color.parse(label.pop('color'))
            label.pop('description')
            label.pop('id')
            assert len(label) == 0

        if 'Merged' in labels:
            assert state == PR.State.CLOSED
            state = PR.State.MERGED

        reviews = []
        for review in result.pop('reviews'):
            reviews.append(
                github.Review(
                    review.pop('author').pop('login'),
                    github.Review.State(review.pop('state').lower()),
                )
            )
            # We don't use these fields.
            review.pop('authorAssociation')
            review.pop('body')
            review.pop('id')
            review.pop('includesCreatedEdit')
            review.pop('reactionGroups')
            review.pop('submittedAt')
            assert len(review) == 0, review

        assert len(result) == 0, result

        if state is PR.State.CLOSED or state is PR.State.MERGED:
            assert not is_draft
        else:
            assert state is PR.State.OPEN
            state = PR.State.DRAFT if is_draft else state

        return PR(
            repository=pr.repository,
            id=pr.id,
            author=author,
            state=state,
            labels=labels,
            reviews=reviews,
            branch=branch,
        )

    async def query_checks(self, /, gh: github.GH) -> github.Checks:
        checks = await gh.pr.checks(self)

        def count(status: github.Status) -> int:
            return sum(1 for check in checks if check.status is status)

        ret = github.Checks(
            passed=count(github.Status.PASS),
            skipped=count(github.Status.SKIPPING),
            pending=count(github.Status.PENDING),
            failed=count(github.Status.FAIL),
        )
        return ret


logger = logging.getLogger(__name__)
