from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import (
    Callable,
    DefaultDict,
    Dict,
    Generic,
    Hashable,
    Iterable,
    Iterator,
    List,
    Optional,
    Tuple,
    TypeVar,
)

from .signal_extraction_types import JobRow


class SignalStatus(Enum):
    FAILURE = "failure"
    SUCCESS = "success"
    PENDING = "pending"


@dataclass(frozen=True)
class JobMeta:
    """
    Group-level aggregation over one or more JobRow records.
    """

    started_at: Optional[datetime] = None
    is_pending: bool = False
    is_cancelled: bool = False
    has_failures: bool = False
    all_completed_success: bool = False
    has_non_test_failures: bool = False

    @property
    def status(self) -> Optional[SignalStatus]:
        """
        - canceled -> treat as 'missing' (None)
        - any_failure -> FAILURE
        - all_completed_success -> SUCCESS
        - else -> PENDING
        """
        if self.is_cancelled:
            return None
        if self.has_failures:
            return SignalStatus.FAILURE
        if self.all_completed_success:
            return SignalStatus.SUCCESS
        return SignalStatus.PENDING


# -------------------------------------------------------------------
# Generic, typed index keyed by a single typed KeyT
# -------------------------------------------------------------------

KeyT = TypeVar("KeyT", bound=Hashable)
K2 = TypeVar("K2", bound=Hashable)  # for enumerate() alternate grouping
K3 = TypeVar("K3", bound=Hashable)  # for enumerate_keys()


class JobAggIndex(Generic[KeyT]):
    """
    Generic, strongly typed index over JobRow records using a single key type.

    Build via:
        idx = JobAggIndex.from_rows(
            rows,
            key_fn=lambda row: AttemptKey(
                sha=row.head_sha,
                workflow_name=row.workflow_name,
                job_base_name=base_name_fn(row.name),
                wf_run_id=row.wf_run_id,
                run_attempt=row.run_attempt,
            ),
        )
    """

    def __init__(
        self,
        *,
        groups: Dict[KeyT, List[JobRow]],
        ordered_pairs: List[Tuple[KeyT, JobRow]],
    ) -> None:
        # `groups` is a dict built in key-first-seen order; Python dict preserves insertion order.
        self._groups: Dict[KeyT, List[JobRow]] = groups
        # Global, original row order, paired with its group key.
        self._ordered: List[Tuple[KeyT, JobRow]] = ordered_pairs
        self._meta_cache: Dict[KeyT, JobMeta] = {}

    @classmethod
    def from_rows(
        cls,
        rows: Iterable[JobRow],
        *,
        key_fn: Callable[[JobRow], KeyT],
    ) -> JobAggIndex[KeyT]:
        """
        Group directly from JobRow—no intermediary structs.
        All order-sensitive structures are derived from the input iteration order.
        """
        grouped: Dict[KeyT, List[JobRow]] = {}
        ordered_pairs: List[Tuple[KeyT, JobRow]] = []

        for r in rows:
            k = key_fn(r)
            # Preserve first-seen key order
            if k not in grouped:
                grouped[k] = []
            grouped[k].append(r)  # preserves per-key row order
            ordered_pairs.append((k, r))  # preserves global row order

        return cls(groups=grouped, ordered_pairs=ordered_pairs)

    # ---- Query API ----

    def keys(self) -> Iterator[KeyT]:
        # Iterates in first-seen key order by construction
        return iter(self._groups.keys())

    def has(self, key: KeyT) -> bool:
        return key in self._groups

    def rows(self, key: KeyT) -> List[JobRow]:
        # Per-key rows appear in the same order as the input iterable
        return self._groups[key]

    def get_stats(self, key: KeyT, default: Optional[JobMeta] = None) -> JobMeta:
        if key in self._groups:
            return self.stats(key)
        if default is not None:
            return default
        # neutral meta
        return JobMeta()

    def stats(self, key: KeyT) -> JobMeta:
        if key in self._meta_cache:
            return self._meta_cache[key]
        if key not in self._groups:
            raise KeyError(key)
        jrows = self._groups[key]

        # Inline aggregations (only used here)
        started_at: Optional[datetime]
        times = [r.started_at for r in jrows if r.started_at is not None]
        started_at = min(times) if times else None

        is_pending = any(r.is_pending for r in jrows)
        is_cancelled = any(r.is_cancelled for r in jrows)
        has_failures = any(r.is_failure for r in jrows)
        all_completed_success = all(r.is_success for r in jrows)
        has_non_test_failures = any(
            (r.is_failure and not r.is_test_failure) for r in jrows
        )

        meta = JobMeta(
            started_at=started_at,
            is_pending=is_pending,
            is_cancelled=is_cancelled,
            has_failures=has_failures,
            all_completed_success=all_completed_success,
            has_non_test_failures=has_non_test_failures,
        )
        self._meta_cache[key] = meta
        return meta

    def enumerate_keys(
        self, key_fn: Callable[[JobRow], K2], value_fn: Callable[[JobRow], K3]
    ) -> DefaultDict[K2, List[K3]]:
        """
        Convenience wrapper around enumerate() to directly extract distinct mapped values.

        Each K2 bucket collects unique K3 values in the order of their **first appearance**
        in the original input. A given K3 appears at most once per bucket.

        Example: job ids grouped by (sha, workflow, base):
            groups = idx.enumerate_keys(
                key_fn=lambda r: (r.head_sha, r.workflow_name, base_name_fn(r.name)),
                value_fn=lambda r: r.job_id,
            )
            job_ids: list[JobId] = groups[(sha, wf_name, base_name)]

        """
        full = self.enumerate(key_fn)
        out: DefaultDict[K2, List[K3]] = defaultdict(list)
        for k2, rows in full.items():
            seen: set[K3] = set()
            for r in rows:
                v3 = value_fn(r)
                if v3 not in seen:
                    out[k2].append(v3)
                    seen.add(v3)
        return out

    # ---- Alternate grouping (generic enumeration) ----

    def enumerate(self, key_fn: Callable[[JobRow], K2]) -> DefaultDict[K2, List[KeyT]]:
        """
        Build an alternate grouping (K2 -> [KeyT]) on demand.

        Each K2 bucket collects unique KeyT values in the order of their
        **first appearance** in the original input. A given KeyT appears at most
        once per bucket.

        Example: attempts grouped by (sha, workflow, base):

            groups = idx.enumerate(
                lambda r: (r.head_sha, r.workflow_name, base_name_fn(r.name))
            )
            attempt_keys: list[AttemptKey] = groups[(sha, wf_name, base_name)]
        """
        out: DefaultDict[K2, List[KeyT]] = defaultdict(list)
        seen_per_bucket: Dict[K2, set[KeyT]] = {}

        for key, row in self._ordered:  # respects original global order
            k2 = key_fn(row)
            bucket_seen = seen_per_bucket.setdefault(k2, set())
            if key not in bucket_seen:
                out[k2].append(key)
                bucket_seen.add(key)

        return out

    # (Aggregation helpers removed; logic is inlined in stats())
