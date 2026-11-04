"""Replay of TD's logged rankings with a new LLM part, as pytorch's TD would aggregate it.

The replayed score is the logged score plus the new part, with nothing subtracted. That
holds only for rankings TD logged while no LLM part reached it: before the first v2 bundle
(the old retriever's artifact upload failed for months). A ranking logged after that holds
the then-shipped LLM part, which a replay would have to subtract first, so evaluate.py
replays only rankings logged before NO_LLM_PART_BEFORE: the day of the first v2 bundle, or
a day after the latest snapshot while none has shipped.
"""

import math
import re
from collections import defaultdict
from dataclasses import astuple, dataclass
from functools import lru_cache
from statistics import median
from typing import Any, Collection, Iterable, Mapping, Optional

from torchci.td.llm.events import RankRow, test_file_of
from torchci.td.llm.metrics import mcnemar_exact
from torchci.td.llm.scoring import TD_CUT_FRACTION


LLM_WEIGHT = 0.25
# TD cuts with integer percent arithmetic (`n * len // 100`), so the fraction is a percent.
CUT_PERCENT = round(TD_CUT_FRACTION * 100)
NO_LLM_PART_BEFORE = "2026-11-05"
LOGGED_CACHE = 1 << 16
# The key pattern pytorch's llm.py groups mapping entries by (an unescaped dot included).
LLM_KEY = re.compile("(.*).py")


def llm_part(mapping: Mapping[str, float], tests: Collection[str]) -> dict[str, float]:
    """What `llm.py` adds per test: entries averaged per test, kept when in TD's `TESTS`,
    scaled so the largest is LLM_WEIGHT. A score <= 0 makes `normalize_ratings` raise,
    which drops the heuristic, so the part is then empty."""
    grouped: dict[str, list[float]] = defaultdict(list)
    for key, value in mapping.items():
        match = LLM_KEY.match(key)
        if match:
            grouped[match.group(1)].append(value)
    scores = {t: sum(v) / len(v) for t, v in grouped.items() if t in tests}
    if not scores or min(scores.values()) <= 0:
        return {}
    top = max(scores.values())
    return {t: s / top * LLM_WEIGHT for t, s in scores.items()}


def cut_position(n: int) -> int:
    """The last 0-based position TD keeps (`get_top_per_tests`: index = 25 * n // 100 + 1)."""
    return CUT_PERCENT * n // 100


def ranked(all_scores: Mapping[str, float], part: Mapping[str, float]) -> list[str]:
    new = {k: v + part.get(test_file_of(k), 0.0) for k, v in all_scores.items()}
    return sorted(new, key=lambda k: (-new[k], k))


def position_of(order: list[str], test_file: str) -> Optional[int]:
    """The first key covering the file, as `get_priority_info_for_test` finds it."""
    return next((i for i, k in enumerate(order) if test_file_of(k) == test_file), None)


class FileTimes:
    """Per-file test seconds from test-infra's `test-times.json`
    (build environment -> test config -> file), with the file's median across every
    (environment, config) entry when the row's own key is missing."""

    def __init__(self, data: Mapping[str, Mapping[str, Mapping[str, float]]]) -> None:
        self.data = data
        per_file: dict[str, list[float]] = defaultdict(list)
        for configs in data.values():
            for files in configs.values():
                for test_file, seconds in files.items():
                    per_file[test_file].append(float(seconds))
        self.fallback = {f: median(v) for f, v in per_file.items()}

    def seconds(self, env: str, config: str, test_file: str) -> float:
        value = self.data.get(env, {}).get(config, {}).get(test_file)
        return float(value) if value is not None else self.fallback.get(test_file, 0.0)


def cut_seconds(order: list[str], row: RankRow, times: FileTimes) -> float:
    files = {test_file_of(k) for k in order[: cut_position(len(order)) + 1]}
    return sum(times.seconds(row.build_environment, row.test_config, f) for f in files)


@dataclass(frozen=True)
class RowReplay:
    job_id: int
    logged_caught: bool
    replayed_caught: bool
    logged_seconds: float
    replayed_seconds: float


def replay_row(
    row: RankRow, part: Mapping[str, float], times: FileTimes
) -> Optional[RowReplay]:
    """None when TD did not rank the job (`max_score` 0)."""
    if row.max_score == 0:
        return None
    cut, logged_seconds = _logged(row, times)
    new = ranked(row.all_scores, part)
    position = position_of(new, row.test_file)
    return RowReplay(
        job_id=row.job_id,
        logged_caught=row.position <= cut,
        replayed_caught=position is not None and position <= cut,
        logged_seconds=logged_seconds,
        replayed_seconds=cut_seconds(new, row, times),
    )


@lru_cache(maxsize=LOGGED_CACHE)
def _logged(row: RankRow, times: FileTimes) -> tuple[int, float]:
    """The row's cut position and the test seconds of its logged cut, which every
    transform and configuration of a run shares."""
    return cut_position(len(row.all_scores)), cut_seconds(
        ranked(row.all_scores, {}), row, times
    )


@dataclass(frozen=True)
class EventReplay:
    key: str
    rows: list[RowReplay]
    dropped: int

    @property
    def logged_caught(self) -> bool:
        return any(r.logged_caught for r in self.rows)

    @property
    def replayed_caught(self) -> bool:
        return any(r.replayed_caught for r in self.rows)

    def to_json(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "rows": [astuple(r) for r in self.rows],
            "dropped": self.dropped,
        }

    @staticmethod
    def from_json(item: Mapping[str, Any]) -> "EventReplay":
        rows = [RowReplay(*r) for r in item["rows"]]
        return EventReplay(item["key"], rows, item["dropped"])

    def seconds(self) -> tuple[float, float]:
        """Logged and replayed cut seconds, summed over the event's distinct jobs."""
        jobs = {r.job_id: r for r in self.rows}
        return (
            sum(r.logged_seconds for r in jobs.values()),
            sum(r.replayed_seconds for r in jobs.values()),
        )


def replay_event(
    key: str, rows: Iterable[RankRow], part: Mapping[str, float], times: FileTimes
) -> EventReplay:
    results = [replay_row(r, part, times) for r in rows]
    kept = [r for r in results if r is not None]
    return EventReplay(key=key, rows=kept, dropped=len(results) - len(kept))


@dataclass(frozen=True)
class ReplaySummary:
    events: int
    dropped_rows: int
    logged_caught: int
    replayed_caught: int
    gained: int
    lost: int
    mcnemar_p: float
    kept_rate: float
    median_time_change: float

    def to_json(self) -> dict[str, Any]:
        return dict(self.__dict__)


def summarize(events: Iterable[EventReplay]) -> ReplaySummary:
    """Events with no ranked row are left out (their rows count as dropped)."""
    events = list(events)
    ranked_events = [e for e in events if e.rows]
    rows = [r for e in ranked_events for r in e.rows]
    logged_rows = [r for r in rows if r.logged_caught]
    gained = sum(1 for e in ranked_events if e.replayed_caught and not e.logged_caught)
    lost = sum(1 for e in ranked_events if e.logged_caught and not e.replayed_caught)
    changes = [
        (new - old) / old
        for old, new in (e.seconds() for e in ranked_events)
        if old > 0
    ]
    return ReplaySummary(
        events=len(ranked_events),
        dropped_rows=sum(e.dropped for e in events),
        logged_caught=sum(1 for e in ranked_events if e.logged_caught),
        replayed_caught=sum(1 for e in ranked_events if e.replayed_caught),
        gained=gained,
        lost=lost,
        mcnemar_p=mcnemar_exact(gained, lost),
        kept_rate=(
            sum(1 for r in logged_rows if r.replayed_caught) / len(logged_rows)
            if logged_rows
            else math.nan
        ),
        median_time_change=median(changes) if changes else math.nan,
    )


def summaries_for(
    stored: Mapping[str, Mapping[str, list[dict[str, Any]]]],
    e1_keys: Collection[str],
    e2_keys: Collection[str],
) -> dict[str, tuple[ReplaySummary, ReplaySummary]]:
    """Per transform, the E1 and E2 summaries of the stored event replays in the keys."""
    return {
        name: tuple(  # type: ignore[misc]
            summarize(EventReplay.from_json(i) for i in parts[kind] if i["key"] in keys)
            for kind, keys in (("e1", e1_keys), ("e2", e2_keys))
        )
        for name, parts in stored.items()
    }
