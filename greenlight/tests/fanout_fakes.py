"""Offline fakes for the scan Lambda's planner and worker: tokens, config files, the review seams."""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any

from greenlight import drain, quota, tick
from greenlight.constants import REPO_CONFIG_PATH, TARGET_REPO
from greenlight.repo_scan import RepoIdentity
from greenlight.state_store import InProcessStore, StoreError

if TYPE_CHECKING:
    from greenlight.repo_config import RepoEntry

NOW = datetime(2026, 11, 24, 12, 0, 0)
START = 1_000_000.0
SHADOW = "status_comment: greenlight\nsafety: gate\neligibility: merge_rules\nmode: shadow\n"
OFF = SHADOW.replace("shadow", "off")


def file_answer(text: str, etag: str = '"e1"') -> tuple[int, dict[str, str], str]:
    body = {"type": "file", "size": len(text), "content": base64.b64encode(text.encode()).decode()}
    return 200, {"etag": etag}, json.dumps(body)


ABSENT: tuple[int, dict[str, str], str] = (404, {}, '{"message": "Not Found"}')


def identity(repo: str, *, private: bool = False, archived: bool = False, branch: str = "main") -> RepoIdentity:
    return RepoIdentity(repo, private, branch, archived)


class Requester:
    def __init__(self, world: World) -> None:
        self.world = world

    def requestJsonAndCheck(self, verb: str, url: str) -> tuple[dict[str, Any], dict[str, Any]]:
        repo = url.removeprefix("/repos/")
        self.world.events.append(f"identity {repo}")
        self.world._fail(f"identity {repo}")
        return {}, self.world.identities.get(repo, identity(repo))._asdict()

    def requestJson(
        self, verb: str, url: str, headers: dict[str, str] | None = None
    ) -> tuple[int, dict[str, Any], str]:
        repo = url.removeprefix("/repos/").removesuffix(f"/contents/{REPO_CONFIG_PATH}")
        self.world.reads.append((repo, headers))
        self.world.monotonic[0] += self.world.read_seconds
        answer = self.world.files.get(repo, ABSENT)
        if isinstance(answer, BaseException):
            raise answer
        status, found, body = answer
        if headers and status == 200 and headers.get("If-None-Match") == found.get("etag"):
            return 304, {}, ""
        return status, found, body


class Client:
    def __init__(self, world: World, token: str, meter: quota.RequestMeter | None) -> None:
        self.token = token
        self.meter = meter
        self.requester = Requester(world)
        self.closed = 0
        world.clients.append(self)

    def close(self) -> None:
        self.closed += 1


@dataclass
class Prepared:
    repo: str
    max_dispatches: int | None
    optional_failed: list[int] = field(default_factory=list)


class Tokens:
    def __init__(self, world: World) -> None:
        self.world = world

    def _fail(self, step: str) -> None:
        self.world.events.append(step)
        failure = self.world.failures.get(step)
        if failure is not None:
            raise failure

    def repo_token(self, repo: str) -> str:
        self._fail(f"token {repo}")
        return f"token-{repo}"

    def dispatch_token(self) -> str:
        self._fail("dispatch token")
        return "dispatch"

    def installation(self, build_github: Any = None) -> dict[str, RepoIdentity]:
        self._fail("listing")
        if build_github is not None:
            build_github("listing")
        return {found.full_name.lower(): found for found in self.world.listing}

    def contents_tokens(self, repos: list[str]) -> dict[str, str]:
        self._fail("contents token")
        self.world.contents_scope.append(list(repos))
        return dict.fromkeys(repos, "contents")


class Store(InProcessStore):
    """An ``InProcessStore`` that counts config writes and fails the operations named in ``failing``."""

    def __init__(self) -> None:
        super().__init__()
        self.failing: set[str] = set()
        self.config_writes: list[str] = []

    def _check(self, operation: str) -> None:
        if operation in self.failing:
            raise StoreError(f"{operation} refused")

    def read_latch(self, now: float) -> float | None:
        self._check("read_latch")
        return super().read_latch(now)

    def extend_latch(self, until: float, now: float) -> None:
        self._check("extend_latch")
        super().extend_latch(until, now)

    def read_repo(self, repo: str) -> Any:
        self._check("read_repo")
        return super().read_repo(repo)

    def scan_repos(self) -> Any:
        self._check("scan_repos")
        return super().scan_repos()

    def write_config(self, repo: str, record: Any) -> None:
        self._check("write_config")
        self.config_writes.append(repo)
        super().write_config(repo, record)

    def acquire_lease(self, repo: str, owner: str, *, expires: float, now: float) -> bool:
        self._check("acquire_lease")
        return super().acquire_lease(repo, owner, expires=expires, now=now)

    def save_memory(self, repo: str, memory: bytes, **kwargs: Any) -> None:
        self._check("save_memory")
        super().save_memory(repo, memory, **kwargs)

    def release_lease(self, repo: str, owner: str) -> bool:
        self._check("release_lease")
        return super().release_lease(repo, owner)


@dataclass
class World:
    """Everything the fakes answer from, and what they saw."""

    listing: list[RepoIdentity] = field(default_factory=lambda: [identity(TARGET_REPO)])
    identities: dict[str, RepoIdentity] = field(default_factory=dict)
    files: dict[str, Any] = field(default_factory=dict)
    failures: dict[str, BaseException] = field(default_factory=dict)
    quota_reading: tuple[int, int] = (5000, 5000)
    drain_failed: tuple[int, ...] = ()
    clock: list[float] = field(default_factory=lambda: [START])
    monotonic: list[float] = field(default_factory=lambda: [0.0])
    read_seconds: float = 0.0
    events: list[str] = field(default_factory=list)
    reads: list[tuple[str, dict[str, str] | None]] = field(default_factory=list)
    clients: list[Client] = field(default_factory=list)
    contents_scope: list[list[str]] = field(default_factory=list)
    invoked: list[dict[str, Any]] = field(default_factory=list)
    prepare_kwargs: dict[str, dict[str, Any]] = field(default_factory=dict)
    store: Store = field(default_factory=Store)

    def now(self) -> float:
        return self.clock[0]

    def _fail(self, step: str) -> None:
        failure = self.failures.get(step)
        if failure is not None:
            raise failure

    def build(self, token: str, *, meter: quota.RequestMeter | None = None, **_kwargs: Any) -> Any:
        return Client(self, token, meter)

    def prepare(self, config: Any, *, entry: RepoEntry, max_dispatches: int | None, **kwargs: Any) -> Any:
        self.events.append(f"prepare {entry.repo} {entry.mode} max={max_dispatches}")
        self.prepare_kwargs[entry.repo] = {"config": config, **kwargs}
        self._fail(f"prepare {entry.repo}")
        return Prepared(entry.repo, max_dispatches)

    def finish(self, prepared: Prepared, *, optional: bool, marks_full_tick: bool = True) -> None:
        mark = "" if marks_full_tick else " no-mark"
        self.events.append(f"finish {prepared.repo} optional={optional} max={prepared.max_dispatches}{mark}")
        self._fail(f"finish {prepared.repo}")

    def drain(self, config: Any, *, repo: str, memory: Any, **_kwargs: Any) -> drain.DrainReport:
        self.events.append(f"drain {repo}")
        self._fail(f"drain {repo}")
        return drain.DrainReport(1, 0, 0, False, "x", self.drain_failed)

    def read_quota(self, _client: Any) -> tuple[int, int]:
        return self.quota_reading

    def invoke(self, event: Any) -> None:
        self.events.append(f"invoke {event['greenlight_worker']['repo']}")
        self._fail(f"invoke {event['greenlight_worker']['repo']}")
        self.invoked.append(event)

    def seams(self) -> tick.Seams:
        return tick.Seams(
            build_github=self.build,
            run_prepare=self.prepare,
            run_finish=self.finish,
            run_drain=self.drain,
            read_quota=self.read_quota,
            monotonic=lambda: self.monotonic[0],
            clock=self.now,
            now=lambda: NOW,
        )

    def tokens(self) -> Tokens:
        return Tokens(self)
