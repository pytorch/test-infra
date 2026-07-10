from __future__ import annotations

import asyncio
from collections.abc import Iterable, Sequence
import curses
import dataclasses
import enum
import logging
from typing import Optional

from bosco import github, model

PYTORCH = github.Repository('pytorch', 'pytorch')


@dataclasses.dataclass
class Column:
    class Align(enum.StrEnum):
        LEFT = enum.auto()
        CENTER = enum.auto()
        RIGHT = enum.auto()

    start: int
    max_width: Optional[int]
    align: Align


@dataclasses.dataclass
class UI:
    stdscr: curses.window
    table: Table
    gh: github.GH = github.GH()

    def __init__(self, stdscr: curses.window, prs: list[int]) -> None:
        self.stdscr = stdscr
        self.table = Table(stdscr, [github.PR(PYTORCH, id) for id in prs])

    async def run(self) -> None:
        for color in [
            curses.COLOR_GREEN,
            curses.COLOR_MAGENTA,
            curses.COLOR_RED,
            curses.COLOR_WHITE,
            curses.COLOR_YELLOW,
        ]:
            curses.init_pair(color, color, curses.COLOR_BLACK)

        self.table.render_header()
        for i in range(len(self.table.rows)):
            self.table.render_url(i)
        self.stdscr.refresh()

        async with asyncio.TaskGroup() as tasks:
            for i, pr in enumerate(self.table.rows):
                tasks.create_task(self._manage_pr(i, pr))

        while self.stdscr.getkey() != 'q':
            pass

    async def _manage_pr(self, row: int, github_pr: github.PR) -> None:
        assert github_pr is self.table.rows[row]
        assert curses.has_extended_color_support()
        pr = await model.PR.query(self.gh, github_pr)

        self.table.render_state(row, pr.state)
        self.table.render_reviews(row, pr.reviews)

        if pr.author != 'dagitses':
            self.table.render_message(
                row, 'author is not dagitses, not managing', curses.COLOR_RED
            )
            return

        if pr.state is github.PR.State.MERGED or pr.state is github.PR.State.CLOSED:
            if await pr.branch.exists(self.gh, pr.repository):
                if not pr.branch.is_sapling_for(pr.id):
                    self.table.render_message(row,
                                              'branch exists but it is not Sapling',
                                              curses.COLOR_RED)
                    return
                self.table.render_message(row, 'branch exists, deleting',
                                          curses.COLOR_RED)
                await pr.branch.delete(self.gh, pr.repository)
                self.table.render_message(row, 'deleted branch', curses.COLOR_GREEN)
                return

        if pr.state is github.PR.State.MERGED:
            assert 'Merged' in pr.labels
            self.table.render_message(row, 'PR is merged', curses.COLOR_MAGENTA)
            return

        if pr.state is github.PR.State.CLOSED:
            assert 'Merged' not in pr.labels
            self.table.render_message(row, 'PR is closed', curses.COLOR_RED)
            return

        pr.checks = await pr.query_checks(self.gh)
        self.table.render_checks(row, pr.checks)

        if pr.checks.status is github.Status.FAIL:
            self.table.render_message(
                row, 'CI failed, manual intervention required', curses.COLOR_RED
            )
            return

        if pr.checks.status is github.Status.PENDING:
            self.table.render_message(row, 'waiting for CI', curses.COLOR_YELLOW)
            return

        assert pr.checks.status is github.Status.PASS

        if pr.state is github.PR.State.DRAFT:
            self.table.render_message(
                row, 'setting ready for review', curses.COLOR_YELLOW
            )
            await self.gh.pr.ready(pr)
            labels_to_add = TEST_LABELS
            self.table.render_message(
                row,
                f'is ready for review, adding labels: {labels_to_add}',
                curses.COLOR_YELLOW,
            )
            await self.gh.pr.edit(pr, add_labels=labels_to_add)
            self.table.render_message(
                row,
                f'marked ready and added labels: {", ".join(labels_to_add)}',
                curses.COLOR_GREEN,
            )
            return

        assert pr.state is github.PR.State.OPEN

        if not TEST_LABELS <= set(pr.labels):
            self.table.render_message(row, 'missing labels', curses.COLOR_RED)
            return

        if not pr.approved:
            self.table.render_message(row, 'waiting for approval', curses.COLOR_YELLOW)
            return

        if 'merging' in pr.labels:
            self.table.render_message(row, 'merging', curses.COLOR_YELLOW)
            return
        else:
            self.table.render_message(
                row, 'waiting for instruction to merge', curses.COLOR_GREEN
            )
            return

        assert False

        # otherwise, we're not in one of our normal states
        self.table.render_message(row, 'unknown state', curses.COLOR_RED)


class ColumnsBuilder:
    columns: list[Column]

    def __init__(self, /) -> None:
        self.columns = []

    def add(self, /, max_width: Optional[int], align: Column.Align) -> Column:
        prev_col = None if len(self.columns) == 0 else self.columns[-1]
        prev_end = -1
        if prev_col is not None:
            assert prev_col.max_width is not None
            prev_end = prev_col.start + prev_col.max_width
        self.columns.append(Column(prev_end + 1, max_width, align))
        return self.columns[-1]


@dataclasses.dataclass
class Table:
    stdscr: curses.window
    rows: Sequence[github.PR]
    columns: dict[str, Column] = dataclasses.field(
        default_factory=lambda: {}, init=False
    )

    def __post_init__(self, /) -> None:
        columns = ColumnsBuilder()
        self.columns['PR'] = columns.add(
            max(len(pr.url) for pr in self.rows), align=Column.Align.LEFT
        )

        self.columns['State'] = columns.add(
            max(len(str(state)) for state in github.PR.State), align=Column.Align.LEFT
        )

        self.columns['❌'] = columns.add(3, align=Column.Align.RIGHT)
        self.columns['✓'] = columns.add(3, align=Column.Align.RIGHT)
        self.columns['◎'] = columns.add(3, align=Column.Align.RIGHT)

        self.columns['Status'] = columns.add(
            max(len(str(state)) for state in github.Status), align=Column.Align.LEFT
        )

        self.columns['💬'] = columns.add(3, align=Column.Align.RIGHT)
        self.columns['Approved'] = columns.add(len('Approved'), Column.Align.CENTER)
        self.columns['Note'] = columns.add(None, Column.Align.LEFT)

    def _render(
        self, /, row: int, left: int, right: Optional[int], value: str, color: int
    ) -> None:
        if right is not None:
            width = right - left
            assert len(value) <= width
            left += (width - len(value)) // 2
        self.stdscr.addstr(row, left, value, curses.color_pair(color))

    def _render_str(self, /, row: int, col: str, value: str, color: int) -> None:
        column = self.columns[col]
        left = column.start
        if column.align is Column.Align.CENTER:
            assert column.max_width is not None
            right = column.start + column.max_width
        elif column.align is Column.Align.RIGHT:
            assert column.max_width is not None
            left += column.max_width - len(value)
            right = None
        else:
            assert column.align is Column.Align.LEFT
            right = None
        self._render(row + 1, left, right, value, color)
        self.stdscr.refresh()

    def render_header(self, /) -> None:
        for name, column in self.columns.items():
            right = (
                None if column.max_width is None else column.start + column.max_width
            )
            self._render(row=0, left=column.start, right=right, value=name, color=0)

    def render_url(self, /, row: int) -> None:
        self._render_str(row, 'PR', self.rows[row].url, curses.COLOR_WHITE)

    def render_state(self, /, row: int, state: github.PR.State) -> None:
        color = {
            github.PR.State.DRAFT: curses.COLOR_YELLOW,
            github.PR.State.OPEN: curses.COLOR_GREEN,
            github.PR.State.CLOSED: curses.COLOR_RED,
            github.PR.State.MERGED: curses.COLOR_MAGENTA,
        }[state]
        self._render_str(row, github.PR.State.__name__, str(state), color)

    def render_checks(self, /, row: int, checks: github.Checks) -> None:
        color = {
            github.Status.PASS: curses.COLOR_GREEN,
            github.Status.PENDING: curses.COLOR_YELLOW,
            github.Status.FAIL: curses.COLOR_RED,
        }[checks.status]
        self._render_str(row, github.Status.__name__, str(checks.status), color)
        self._render_str(row, '❌', str(checks.failed), curses.COLOR_RED)
        self._render_str(row, '✓', str(checks.passed), curses.COLOR_GREEN)
        self._render_str(row, '◎', str(checks.pending), curses.COLOR_YELLOW)

    def render_reviews(self, /, row: int, reviews: Iterable[github.Review]) -> None:
        approved = any(
            review.state == github.Review.State.APPROVED for review in reviews
        )
        self._render_str(row, '💬', str(len(reviews)), curses.COLOR_WHITE)
        if approved:
            self._render_str(row, 'Approved', '✓', curses.COLOR_GREEN)

    def render_message(
        self, /, row: int, message: str, color: int, offset: int = 0
    ) -> None:
        self._render_str(row, 'Note', message, color)


TEST_LABELS = frozenset({'ciflow/trunk'})


logger = logging.getLogger(__name__)
