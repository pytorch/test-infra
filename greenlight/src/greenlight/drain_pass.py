"""One pass over a repo's open PRs, and its part of the stored scan memory (``scan_memory``, ``backing_memory``).

``drain_pass_form`` and ``drain_pass_from_form`` are a pass's stored form: plain lists and numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping


@dataclass(slots=True)
class DrainPass:
    """One pass over a repo's open PRs: the ``off`` drain's (``drain``, which says why it is safe), or a
    ``gate`` repo's approval-backing sweep (``approval_backing``).

    ``recorded`` holds the PRs that had a ledger row when the pass started. ``checked`` holds the PRs
    the pass read successfully; a PR is pending while it is open and not there, so a later update to
    a checked PR does not make it pending again, while one opened or reopened during the pass is.
    ``attempted`` maps each PR the pass tried to read, successfully or not, to the sequence number of
    its last attempt (``attempts`` is the last one given), which ``pending`` orders failed PRs by.
    ``blocker`` says why a drain pass cannot complete the drain even if it finds nothing (review runs
    older than the off switch were unfinished, or could not be read, when it started), or is None.
    ``dismissed`` and ``failures`` are a drain pass's totals so far.
    """

    number: int
    blocker: str | None = None
    recorded: frozenset[int] = frozenset()
    checked: set[int] = field(default_factory=set)
    attempted: dict[int, int] = field(default_factory=dict)
    attempts: int = 0
    dismissed: int = 0
    failures: int = 0

    def pending(self, open_prs: Iterable[int]) -> list[int]:
        """The open PRs not checked yet, in reading order.

        Never attempted first, those in ``recorded`` before the rest, each by number; then the ones
        attempted already, the oldest attempt first, so a PR whose read keeps failing goes behind
        every PR still awaiting its first read.
        """
        return sorted(
            (number for number in open_prs if number not in self.checked),
            key=lambda number: (
                number in self.attempted,
                self.attempted.get(number, 0),
                number not in self.recorded,
                number,
            ),
        )

    def attempt(self, number: int) -> None:
        """Record a read attempt on ``number``, successful or not, as the pass's latest."""
        self.attempts += 1
        self.attempted[number] = self.attempts


def drain_pass_form(current: DrainPass | None) -> dict[str, Any] | None:
    if current is None:
        return None
    return {
        "number": current.number,
        "blocker": current.blocker,
        "recorded": sorted(current.recorded),
        "checked": sorted(current.checked),
        "attempted": sorted(current.attempted.items()),
        "attempts": current.attempts,
        "dismissed": current.dismissed,
        "failures": current.failures,
    }


def drain_pass_from_form(form: Mapping[str, Any] | None) -> DrainPass | None:
    if form is None:
        return None
    return DrainPass(
        int(form["number"]),
        form["blocker"],
        recorded=frozenset(int(number) for number in form["recorded"]),
        checked={int(number) for number in form["checked"]},
        attempted={int(number): int(attempt) for number, attempt in form["attempted"]},
        attempts=int(form["attempts"]),
        dismissed=int(form["dismissed"]),
        failures=int(form["failures"]),
    )
