from __future__ import annotations

import argparse
import asyncio
from collections.abc import Sequence
import curses
import logging
import pathlib

from bosco import Bosco, github


def run(argv: Sequence[str]) -> None:
    parser = argparse.ArgumentParser(prog=argv[0])
    parser.add_argument(
        '--debug', type=bool, default=False, action=argparse.BooleanOptionalAction
    )
    parser.add_argument(
        '--log-file',
        type=pathlib.Path,
        default=pathlib.Path('bosco.log'),
    )

    commands = parser.add_subparsers()

    init_parser = commands.add_parser('init', help='')
    init_parser.add_argument('prs', nargs=argparse.REMAINDER)
    init_parser.set_defaults(func=init)

    init_parser = commands.add_parser('edit', help='')
    init_parser.add_argument('--add-label', type=str, required=True)
    init_parser.add_argument('prs', nargs=argparse.REMAINDER)
    init_parser.set_defaults(func=edit)

    watch_parser = commands.add_parser('watch', help='')
    watch_parser.add_argument('prs', nargs=argparse.REMAINDER)
    watch_parser.set_defaults(func=watch)

    watch_parser = commands.add_parser('checks', help='')
    watch_parser.add_argument('pr', type=int)
    watch_parser.set_defaults(func=checks)

    args = vars(parser.parse_args(argv[1:]))

    level = logging.DEBUG if args.pop('debug') else None
    log_file = args.pop('log_file')

    logging.basicConfig(
        filename=log_file,
        format='{levelname[0]}:{asctime}:{filename}:{lineno} {message}',
        style='{',
        level=level,
    )
    logger.info('Started Bosco.')

    bosco = Bosco(gh=github.GH())
    func = args.pop('func')
    func(bosco, **args)


def init(bosco: Bosco, prs: list[int]) -> None:
    asyncio.run(bosco.init(prs))


def edit(bosco: Bosco, prs: list[int], add_label: str) -> None:
    asyncio.run(_edit(bosco, prs, add_label))


def checks(bosco: Bosco, pr: int) -> None:
    checks = asyncio.run(
        bosco.gh.pr.checks(github.PR(github.Repository('pytorch', 'pytorch'), pr))
    )
    import pprint

    pprint.pp(checks)
    status = None
    if all(
        check.status in [github.Status.PASS, github.Status.SKIPPING] for check in checks
    ):
        status = github.Status.PASS
    elif any(check.status is github.Status.FAIL for check in checks):
        status = github.Status.FAIL
    elif all(
        check.status
        in [github.Status.PASS, github.Status.SKIPPING, github.Status.PENDING]
        for check in checks
    ):
        status = github.Status.PENDING
    print(status)


async def _edit(bosco: Bosco, prs: list[int], add_label: str) -> None:
    async with asyncio.TaskGroup() as tasks:
        for pr in prs:
            tasks.create_task(
                bosco.gh.pr.add_label(
                    github.PR(github.Repository('pytorch', 'pytorch'), pr), add_label
                )
            )


def watch(bosco: Bosco, prs: list[int]) -> None:
    curses.wrapper(_watch, bosco, prs)


def _watch(stdscr: curses.window, bosco: Bosco, prs: list[int]) -> None:
    asyncio.run(bosco.watch(stdscr, prs))


logger = logging.getLogger(__name__)
