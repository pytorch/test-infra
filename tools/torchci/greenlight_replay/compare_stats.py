"""What a base-versus-PR replay comparison counts, and how.

The policy-replay workflow replays one sample of historical pull requests
several times under the policy at a test-infra PR's merge base and several
times under the PR's own policy. This module is what those runs are once read
-- ``Run``s of validated ``Row``s -- and every number the comparison reports
about them, each defined once: ``compare`` reads the runs, and ``compare_render``
and ``compare_tables`` print the numbers.

The repeated runs are the point. The reviewer does not repeat itself on the same
input (the harness README's misreading 1), so one run per arm cannot tell a
policy effect from noise. Disagreement between the runs of one arm measures that
noise under that policy. A true flip -- each arm unanimous, the arms disagreeing
-- is the strongest evidence of an effect the sample can give; a flip of the
majorities where an arm split is weaker, and is counted apart.

Every share carries a Wilson score interval whose sample size counts pull
requests, never runs: the runs of one pull request are not independent. A rate
pooled over the rows or pairs of runs of many pull requests is sized by the pull
requests that contribute to it. Each one's own rate lies in [0, 1], so it varies
no more than one yes-or-no outcome with the same mean.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from statistics import NormalDist


LAND = "LAND"
NO_LAND = "NO_LAND"
FAILED = "failed"
INVALID_REASON = "invalid"
DIRECTIONS = ((LAND, NO_LAND), (NO_LAND, LAND))

# A pull request needs this many verdicts in an arm before it can be called
# stable or unstable there.
MIN_VERDICTS = 2

CONFIDENCE = 0.95
_Z = NormalDist().inv_cdf((1 + CONFIDENCE) / 2)


def wilson(rate: float, n: int) -> tuple[float, float]:
    """The Wilson score interval at ``CONFIDENCE`` for ``rate`` seen over ``n`` units."""
    z2 = _Z * _Z / n
    centre = (rate + z2 / 2) / (1 + z2)
    half = _Z * math.sqrt(rate * (1 - rate) / n + z2 / (4 * n)) / (1 + z2)
    # At a rate of 0 or 1, rounding can leave a bound a hair outside [0, 1].
    return max(0.0, centre - half), min(1.0, centre + half)


@dataclass(frozen=True)
class Proportion:
    """``part`` of ``whole``, and its interval.

    ``prs`` is set when ``whole`` counts rows or pairs of runs rather than pull
    requests: it is then the number of pull requests behind them, the sample size
    of the interval.
    """

    part: int
    whole: int
    prs: int | None = None

    @property
    def interval(self) -> tuple[float, float] | None:
        """The Wilson interval; none when no pull request is behind the share."""
        n = self.whole if self.prs is None else self.prs
        return wilson(self.part / self.whole, n) if self.whole and n else None


@dataclass(frozen=True)
class Row:
    """One run's outcome for one pull request, holding validated values only.

    ``verdict`` is ``LAND``, ``NO_LAND`` or ``FAILED``; ``reason`` is a
    well-formed reason code or ``INVALID_REASON``; ``repo`` and ``head_sha`` are
    blank unless they matched the export's own patterns.
    """

    verdict: str
    reason: str
    repo: str
    head_sha: str


@dataclass(frozen=True)
class Run:
    """One run directory: its exit status, its rows by PR number, what was wrong.

    ``exit_note`` says why there is no ``exit_code``, ``csv_note`` why there are
    no rows, and ``skipped`` counts rows dropped for an unreadable or repeated
    PR number.
    """

    label: str
    exit_code: int | None = None
    exit_note: str = ""
    csv_note: str = ""
    rows: Mapping[int, Row] = field(default_factory=dict)
    skipped: int = 0

    def count(self, verdict: str) -> int:
        return sum(1 for row in self.rows.values() if row.verdict == verdict)


@dataclass(frozen=True)
class PrArm:
    """One pull request under one arm: a row per run in run order, ``None`` if missing."""

    outcomes: tuple[Row | None, ...]

    def count(self, verdict: str) -> int:
        return sum(
            1 for row in self.outcomes if row is not None and row.verdict == verdict
        )

    @property
    def verdicts(self) -> int:
        return self.count(LAND) + self.count(NO_LAND)

    @property
    def assessable(self) -> bool:
        return self.verdicts >= MIN_VERDICTS

    @property
    def split(self) -> bool:
        return self.assessable and 0 < self.count(LAND) < self.verdicts

    @property
    def unanimous(self) -> bool:
        return self.assessable and not self.split

    @property
    def majority(self) -> str | None:
        """The verdict held by more than half of the verdicts; none on a tie."""
        land, no_land = self.count(LAND), self.count(NO_LAND)
        if land == no_land:
            return None
        return LAND if land > no_land else NO_LAND

    @property
    def reasons(self) -> list[str]:
        """Distinct reasons of every row, failures included, in order of first appearance."""
        return list(
            dict.fromkeys(row.reason for row in self.outcomes if row is not None)
        )


@dataclass(frozen=True)
class Pr:
    """One pull request of the realised sample, under both arms."""

    number: int
    repo: str
    consistent: bool
    base: PrArm
    change: PrArm

    @property
    def comparable(self) -> bool:
        return self.consistent and self.base.assessable and self.change.assessable

    @property
    def flipped(self) -> bool:
        """Comparable, each arm has a majority, and the two differ."""
        base, change = self.base.majority, self.change.majority
        return self.comparable and None not in (base, change) and base != change

    @property
    def true_flip(self) -> bool:
        return self.flipped and self.base.unanimous and self.change.unanimous

    @property
    def stable(self) -> bool:
        return (
            self.comparable
            and self.base.unanimous
            and self.change.unanimous
            and not self.flipped
        )

    @property
    def exclusion(self) -> str:
        """Why the comparison leaves this pull request out, or ``""``."""
        if not self.consistent:
            return "inconsistent input heads"
        short = [
            name
            for name, arm in (("base", self.base), ("this PR", self.change))
            if not arm.assessable
        ]
        if not short:
            return ""
        where = "both" if len(short) == 2 else short[0]
        return f"fewer than {MIN_VERDICTS} verdicts under {where}"


@dataclass(frozen=True)
class Arm:
    """One arm: its runs, and the outcomes of the consistent pull requests under it.

    Run-level numbers count every row, inconsistent pull requests included;
    PR-level numbers count ``prs``, the consistent ones only.
    """

    runs: tuple[Run, ...]
    universe: int
    prs: tuple[PrArm, ...]
    comparable: tuple[PrArm, ...]

    def total(self, verdict: str) -> int:
        return sum(run.count(verdict) for run in self.runs)

    @property
    def land_rate(self) -> Proportion:
        """LAND over the verdicts of every row, from the PRs with any verdict."""
        land, no_land = self.total(LAND), self.total(NO_LAND)
        prs = {
            number
            for run in self.runs
            for number, row in run.rows.items()
            if row.verdict != FAILED
        }
        return Proportion(land, land + no_land, len(prs))

    def missing_in(self, run: Run) -> int:
        return self.universe - len(run.rows)

    @property
    def missing(self) -> int:
        return sum(self.missing_in(run) for run in self.runs)

    @property
    def runs_with_rows(self) -> int:
        return sum(1 for run in self.runs if run.rows)

    def reasons(self, *, failed: bool) -> Counter[str]:
        """Reason counts over the arm's verdicts, or over its failures."""
        return Counter(
            row.reason
            for run in self.runs
            for row in run.rows.values()
            if (row.verdict == FAILED) == failed
        )

    def unanimous(self, verdict: str) -> int:
        return sum(1 for pr in self.prs if pr.unanimous and pr.majority == verdict)

    @property
    def split(self) -> int:
        return sum(1 for pr in self.prs if pr.split)

    @property
    def assessable(self) -> int:
        return sum(1 for pr in self.prs if pr.assessable)

    @property
    def insufficient(self) -> int:
        return len(self.prs) - self.assessable

    @property
    def unstable_rate(self) -> Proportion:
        return Proportion(self.split, self.assessable)

    @property
    def disagreement(self) -> Proportion:
        """Disagreeing pairs of runs over all pairs, from the PRs with any pair."""
        return Proportion(
            sum(pr.count(LAND) * pr.count(NO_LAND) for pr in self.prs),
            sum(math.comb(pr.verdicts, 2) for pr in self.prs),
            sum(1 for pr in self.prs if pr.verdicts >= 2),
        )

    @property
    def majority_land(self) -> Proportion:
        """Comparable PRs whose majority is LAND, among those with any majority."""
        return Proportion(
            sum(1 for pr in self.comparable if pr.majority == LAND),
            sum(1 for pr in self.comparable if pr.majority),
        )


@dataclass(frozen=True)
class Comparison:
    """Both arms, and every pull request seen in any run of either, by number."""

    base: Arm
    change: Arm
    prs: tuple[Pr, ...]

    @property
    def comparable(self) -> list[Pr]:
        return [pr for pr in self.prs if pr.comparable]

    def share(self, prs: Sequence[Pr]) -> Proportion:
        """``prs`` as a share of the comparable pull requests."""
        return Proportion(len(prs), len(self.comparable))

    @property
    def true_flips(self) -> list[Pr]:
        return [pr for pr in self.prs if pr.true_flip]

    @property
    def non_true_flips(self) -> list[Pr]:
        return [pr for pr in self.prs if pr.flipped and not pr.true_flip]

    @property
    def stable(self) -> list[Pr]:
        return [pr for pr in self.prs if pr.stable]

    @property
    def unstable_unflipped(self) -> list[Pr]:
        return [pr for pr in self.comparable if not (pr.stable or pr.flipped)]

    @property
    def newly_unstable(self) -> list[Pr]:
        return [pr for pr in self.comparable if pr.change.split and pr.base.unanimous]

    @property
    def newly_stable(self) -> list[Pr]:
        return [pr for pr in self.comparable if pr.base.split and pr.change.unanimous]

    @property
    def unstable_base(self) -> list[Pr]:
        return [pr for pr in self.prs if pr.consistent and pr.base.split]

    @property
    def unstable_change(self) -> list[Pr]:
        return [pr for pr in self.prs if pr.consistent and pr.change.split]

    @property
    def excluded(self) -> list[Pr]:
        return [pr for pr in self.prs if not pr.comparable]

    @property
    def repo(self) -> str:
        """The one repo every linkable pull request belongs to, or ``""``."""
        repos = {pr.repo for pr in self.prs if pr.repo}
        return repos.pop() if len(repos) == 1 else ""

    @staticmethod
    def directions(prs: Iterable[Pr]) -> dict[tuple[str, str], int]:
        """Flips counted from the base majority to this PR's majority."""
        counts = Counter((pr.base.majority, pr.change.majority) for pr in prs)
        return {direction: counts[direction] for direction in DIRECTIONS}


def compare(base_runs: Sequence[Run], change_runs: Sequence[Run]) -> Comparison:
    """Pair every pull request seen in any run of either arm across both arms.

    A pull request is consistent when its rows name at most one head SHA: two
    heads mean the runs did not review the same code, so its verdicts cannot be
    held against each other. Its repo is kept only when its rows agree on one.
    """
    runs = [*base_runs, *change_runs]
    prs = []
    for number in sorted({number for run in runs for number in run.rows}):
        rows = [run.rows[number] for run in runs if number in run.rows]
        heads = {row.head_sha for row in rows if row.head_sha}
        repos = {row.repo for row in rows if row.repo}
        prs.append(
            Pr(
                number=number,
                repo=repos.pop() if len(repos) == 1 else "",
                consistent=len(heads) <= 1,
                base=PrArm(tuple(run.rows.get(number) for run in base_runs)),
                change=PrArm(tuple(run.rows.get(number) for run in change_runs)),
            )
        )
    consistent = [pr for pr in prs if pr.consistent]
    comparable = [pr for pr in consistent if pr.comparable]
    return Comparison(
        base=Arm(
            runs=tuple(base_runs),
            universe=len(prs),
            prs=tuple(pr.base for pr in consistent),
            comparable=tuple(pr.base for pr in comparable),
        ),
        change=Arm(
            runs=tuple(change_runs),
            universe=len(prs),
            prs=tuple(pr.change for pr in consistent),
            comparable=tuple(pr.change for pr in comparable),
        ),
        prs=tuple(prs),
    )
