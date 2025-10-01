from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple


@dataclass(frozen=True)
class Gap:
    lo: int
    hi: int

    @property
    def length(self) -> int:
        return self.hi - self.lo + 1

    @property
    def heap_key(self) -> Tuple[int, int, int]:
        """Key for max-heap behavior with deterministic tie-breaks.

        - Primary: negative length (so larger gaps come first)
        - Secondary: lower `lo` wins to stabilize ordering
        - Tertiary: `hi` for completeness (not strictly needed)
        """
        return -self.length, self.lo, self.hi


class GapBisectionPlanner:
    """
    Plans which positions to cover (schedule) given an input coverage map and a limit.

    Input:
      - covered: list of booleans where True indicates already covered (e.g., pending)
                 and False indicates an uncovered candidate position
      - limit: optional total limit for covered positions per run; the planner
               uses allowed = max(0, limit - sum(covered)). None = unlimited

    Output:
      - list[bool] of same length, where True marks positions to newly cover

    Algorithm:
      - If unlimited: cover all uncovered (False) positions
      - Else: find contiguous gaps of uncovered positions separated by covered, and
              iteratively pick the middle of the largest gap, splitting it, until
              `allowed` is exhausted.
    """

    @staticmethod
    def plan(covered: List[bool], limit: Optional[int]) -> List[bool]:
        n = len(covered)
        result = [False] * n
        if n == 0:
            return result

        # Unlimited → select all uncovered positions
        if limit is None:
            for i, cov in enumerate(covered):
                result[i] = not cov
            return result

        # Compute budget available for NEW positions this run
        current = sum(1 for c in covered if c)
        allowed = max(0, limit - current)
        if allowed == 0:
            return result

        # Build list of candidate indices (currently uncovered)
        cand = [i for i, c in enumerate(covered) if not c]
        if not cand:
            return result

        # Max-heap by gap length; store negatives for Python's min-heap
        import heapq

        heap: List[Tuple[Tuple[int, int, int], Gap]] = []

        # Build contiguous gaps over `cand` indices
        start = prev = cand[0]
        for idx in cand[1:]:
            if idx == prev + 1:
                prev = idx
                continue
            # gaps.append(Gap(start, prev))
            gap = Gap(start, prev)
            heapq.heappush(heap, (gap.heap_key, gap))
            start = prev = idx
        gap = Gap(start, prev)
        heapq.heappush(heap, (gap.heap_key, gap))

        # Iteratively pick midpoints of largest gaps until budget exhausted
        while allowed > 0 and heap:
            _, g = heapq.heappop(heap)
            if g.lo > g.hi:
                continue
            mid = (g.lo + g.hi) // 2
            if not covered[mid] and not result[mid]:
                result[mid] = True
                allowed -= 1
            # Push back the two sub-spans excluding mid
            left = Gap(g.lo, mid - 1)
            right = Gap(mid + 1, g.hi)
            if left.lo <= left.hi:
                heapq.heappush(heap, (left.heap_key, left))
            if right.lo <= right.hi:
                heapq.heappush(heap, (right.heap_key, right))

        return result
