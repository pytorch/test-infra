from __future__ import annotations

import asyncio
from collections.abc import Sequence
import csv
import dataclasses
import enum
import io
import json
import logging
import math
import os
import pathlib
import shlex
import subprocess
import typing
from typing import Any, Iterable


class Error(Exception):
    pass


class GH:
    def __init__(self, /, path: pathlib.Path = pathlib.Path('gh')) -> None:
        self._path = path
        self.pr = _PR(self)

    async def __call__(
        self, /, *args: str, check: bool = True, **kwargs: Any
    ) -> subprocess.CompletedProcess[str]:
        argv: list[str | pathlib.Path] = [self._path]
        argv.extend(arg for arg in args)
        process = await asyncio.create_subprocess_exec(
            *argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        stdout, stderr = await process.communicate(None)
        assert process.returncode is not None
        ret = subprocess.CompletedProcess(
            args=argv,
            returncode=process.returncode,
            stdout=bytes.decode(stdout),
            stderr=bytes.decode(stderr),
        )
        if check:
            ret.check_returncode()
            if ret.stderr != '':
                raise Error(ret)
        return ret

    async def api(
        self, path: str, /, check: bool = True, method: str = 'GET'
    ) -> ApiResult:
        proc = await self('api', path, f'--method={method}', check=check)
        if proc.stderr != '':
            _log_completed_process(logging.WARNING, proc)
        return ApiResult(
            headers=[], body=proc.stdout, completed_process=proc
        )


@dataclasses.dataclass
class Checks:
    passed: int
    skipped: int
    pending: int
    failed: int

    @property
    def status(self, /) -> Status:
        if self.failed > 0:
            return Status.FAIL
        if self.pending > 0:
            return Status.PENDING
        return Status.PASS


@dataclasses.dataclass
class ApiResult:
    headers: Sequence[str]
    body: str
    completed_process: subprocess.CompletedProcess[str]


@dataclasses.dataclass
class PR:
    class State(enum.StrEnum):
        DRAFT = enum.auto()
        OPEN = enum.auto()
        CLOSED = enum.auto()
        MERGED = enum.auto()

    repository: Repository
    id: int

    @property
    def url(self, /) -> str:
        return f'https://github.com/{self.repository}/pull/{self.id}'


@dataclasses.dataclass
class Repository:
    organization: str
    name: str

    def __str__(self, /) -> str:
        return f'{self.organization}/{self.name}'


@dataclasses.dataclass
class Label:
    name: str
    color: Color


class Status(enum.StrEnum):
    PASS = enum.auto()
    SKIPPING = enum.auto()
    PENDING = enum.auto()
    FAIL = enum.auto()


@dataclasses.dataclass
class Color:
    r: int
    g: int
    b: int

    @staticmethod
    def parse(s: str) -> Color:
        assert len(s) == 6
        return Color(r=int(s[0:2], 16), g=int(s[2:4], 16), b=int(s[4:6], 16))

        def distance(self, other: Color) -> int:
            dists = (self.r - other.r, self.g - other.g, self.b - other.b)
            return math.sqrt(sum(d * d for d in dists))


@dataclasses.dataclass
class Check:
    name: str
    status: Status
    duration: str
    url: str


@dataclasses.dataclass
class Review:
    class State(enum.StrEnum):
        APPROVED = enum.auto()
        COMMENTED = enum.auto()

    author: str
    state: State


class _PR:
    def __init__(self, /, gh: GH) -> None:
        self._gh = gh
        self.limit: asyncio.Queue[object] = asyncio.Queue(maxsize=1)
        self.limit.put_nowait(object())

    async def checks(self, /, pr: PR) -> list[Check]:
        await self.limit.get()
        try:
            proc = await self('checks', pr, check=False)
        finally:
            await self.limit.put(object())
        if proc.stderr != '':
            _log_completed_process(logging.WARNING, proc)
            proc.check_returncode()

        checks = []
        for line in list(csv.reader(io.StringIO(proc.stdout), delimiter='\t')):
            assert len(line) == 4
            checks.append(
                Check(
                    name=line[0], status=Status(line[1]), duration=line[2], url=line[3]
                )
            )
            if proc.returncode == 0:
                for check in checks:
                    assert check.status in [Status.PASS, Status.SKIPPING], check
            else:
                assert proc.returncode == 1
                assert proc.stderr == ''
        return checks

    async def add_label(self, /, pr: PR, label: str) -> None:
        await self.edit(pr, add_labels=[label])

    async def edit(
        self,
        /,
        pr: PR,
        *,
        reviewers: Iterable[str] = [],
        add_labels: Iterable[str] = [],
        remove_labels: Iterable[str] = [],
    ) -> None:
        args: list[str] = []
        args.extend(f'--add-reviewer={reviewer}' for reviewer in reviewers)
        args.extend(f'--add-label={label}' for label in add_labels)
        args.extend(f'--remove-label={label}' for label in remove_labels)
        await self('edit', pr, *args)

    async def ready(self, /, pr: PR) -> None:
        await self('ready', pr)

    async def view(self, /, pr: PR, *, json: list[str]) -> dict[str, Any]:
        import json as json_module

        proc = await self('view', pr, '--json=' + ','.join(json))
        return typing.cast(dict[str, Any], json_module.loads(proc.stdout))

    async def __call__(
        self, subcommand: str, pr: PR, /, *args: str, check: bool = True, **kwargs: Any
    ) -> subprocess.CompletedProcess[str]:
        return await self._gh(
            'pr',
            subcommand,
            f'--repo={pr.repository}',
            str(pr.id),
            *args,
            check=check,
            **kwargs,
        )


def _log_completed_process(
    level: int, process: subprocess.CompletedProcess[str]
) -> None:
    args = (
        os.fspath(arg) if isinstance(arg, pathlib.Path) else arg for arg in process.args
    )
    format = 'Command exited with code %d: %s'
    if process.stderr != '':
        format += '\n<stderr>%s</stderr>'
    else:
        format += '%s'
    logger.log(level, format, process.returncode, shlex.join(args), process.stderr)


logger = logging.getLogger(__name__)
