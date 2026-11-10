"""Revert path risk: per path, the rate at which the landed changes touching it on
pytorch main were later reverted, shrunk towards its parent directory's rate. One
builder makes the table the model file serves (`risk.paths`) and the weekly tables the
training changes read, so each unit sees only the reverts made before its week."""

from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Sequence

from torchci.td.labels.schema import DAY
from torchci.td.scorer import gitdata, model_json


ALPHA = 20.0
LOOK_BACK_DAYS = 365
SETTLE_DAYS = 3
MIN_TOUCHES = 5
WEEK = 7 * DAY
# 1970-01-01 was a Thursday: the first Monday 00:00 UTC is 4 days later.
FIRST_MONDAY = 4 * DAY


@dataclass(frozen=True)
class Change:
    """A first-parent commit of main: when it landed, the table keys its files fall
    under, whether it is itself a revert, and when it was first reverted."""

    time: int
    nodes: frozenset[str]
    is_revert: bool
    reverted_at: Optional[int]


@dataclass(frozen=True)
class History:
    changes: tuple[Change, ...]

    @classmethod
    def of(cls, commits: Sequence[dict[str, Any]]) -> "History":
        """From gitdata.main_history's commits: each change's revert time is that of the
        earliest later commit that reverts it."""
        reverted: dict[str, int] = {}
        for c in commits:
            if c["reverts"] is not None:
                target = c["reverts"]
                reverted[target] = min(c["time"], reverted.get(target, c["time"]))
        return cls(
            tuple(
                Change(
                    int(c["time"]),
                    frozenset(n for f in c["files"] for n in model_json.path_nodes(f)),
                    c["reverts"] is not None,
                    reverted.get(c["sha"]),
                )
                for c in commits
            )
        )

    @classmethod
    def load(cls, repo: Path, start: int) -> "History":
        """The clone's main history the tables of units from `start` (unix seconds) on
        need: LOOK_BACK_DAYS before the Monday of start's week."""
        return cls.of(gitdata.main_history(repo, start - (LOOK_BACK_DAYS + 7) * DAY))


def parent(node: str) -> Optional[str]:
    """The directory key above a node, None for a top-level one."""
    i = node.rstrip("/").rfind("/")
    return None if i < 0 else node[: i + 1]


def kept(node: str, touches: int) -> bool:
    """Whether a node goes into a table: touched at least MIN_TOUCHES times, a valid key
    and no digit run (a file under a dropped key takes its parent's rate)."""
    return (
        touches >= MIN_TOUCHES
        and model_json.is_path_key(node)
        and not model_json.has_digit_run(node)
    )


def table(history: History, at: int) -> dict[str, Any]:
    """The `risk.paths` block as of `at` (unix seconds): the non-revert changes landed in
    [at - LOOK_BACK_DAYS, at - SETTLE_DAYS), an event when reverted before `at`. base is
    the event rate over them (0 without any); a node's rate is (events + ALPHA x its
    parent's rate) / (touches + ALPHA), a change counting once per node it touches."""
    lo, hi = at - LOOK_BACK_DAYS * DAY, at - SETTLE_DAYS * DAY
    touches: Counter = Counter()
    events: Counter = Counter()
    n = n_events = 0
    for c in history.changes:
        if c.is_revert or not lo <= c.time < hi:
            continue
        event = c.reverted_at is not None and c.reverted_at < at
        n += 1
        n_events += event
        for node in c.nodes:
            touches[node] += 1
            events[node] += event
    base = n_events / n if n else 0.0
    rate: dict[str, float] = {}
    for node in sorted(touches, key=lambda k: (k.rstrip("/").count("/"), k)):
        up = parent(node)
        prior = base if up is None else rate[up]
        rate[node] = (events[node] + ALPHA * prior) / (touches[node] + ALPHA)
    nodes = {k: rate[k] for k in sorted(rate) if kept(k, touches[k])}
    return {"base": base, "nodes": nodes}


def week_start(t: int) -> int:
    """The Monday 00:00 UTC on or before `t` (unix seconds)."""
    return t - (t - FIRST_MONDAY) % WEEK


def unit_values(
    history: History, changes: Sequence[tuple[int, Sequence[str]]]
) -> list[dict[str, float]]:
    """spec.PATH_FEATURES per (cutoff, changed files): from the table as of the Monday
    on or before the cutoff, each week's table built once."""
    tables: dict[int, dict[str, Any]] = {}
    out = []
    for cutoff, files in changes:
        week = week_start(int(cutoff))
        if week not in tables:
            tables[week] = table(history, week)
        out.append(model_json.path_values(tables[week], files))
    return out
