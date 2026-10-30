"""The reproducible sample of pull requests that both the export and the replay draw.

A pull request's rank is a hash of the seed and the two CSV cells that name it, so it
depends on nothing but that pull request -- not on where its row sits, nor on which other
rows exist -- and a sample keeps the lowest ranks, in input order. The export ranks its
decisions by the cells it will write for them, and ``greenlight_replay.frame.sample_rows``
ranks the rows it reads back, so for one seed the two order pull requests identically. A
replay drawing ``n`` rows from an export sampled here therefore draws exactly the rows it
would draw from the full export, as long as at least ``n`` of the sampled rows survive its
frame; with fewer, it draws a subset of those rows.
"""

from __future__ import annotations

import hashlib
import math
from typing import Any, Callable, Mapping, Sequence, TypeVar

from torchci.greenlight_decisions.rows import build_row, csv_safe


DEFAULT_SEED = 0

_Item = TypeVar("_Item")
_Decision = TypeVar("_Decision", bound=Mapping[str, Any])


def sample_key(seed: int, repo: str, pr_number: str) -> bytes:
    """A pull request's rank, fixed by the seed and its ``repo`` and ``pr_number`` cells.

    NUL-joined rather than concatenated so that no two different pull requests can spell
    the same payload, and hashed rather than seeded into a PRNG so that the rank depends on
    nothing but this pull request -- not on how many rows precede it, nor on which other
    pull requests the export or the replay's frame happens to hold today.
    """
    payload = "\x00".join((str(seed), repo, pr_number))
    return hashlib.sha256(payload.encode("utf-8")).digest()


def lowest_ranked(
    items: Sequence[_Item], size: int, rank: Callable[[_Item], bytes]
) -> list[_Item]:
    """The ``size`` items of lowest ``rank``, in input order."""
    ranked = sorted(range(len(items)), key=lambda index: rank(items[index]))
    drawn = set(ranked[:size])
    return [item for index, item in enumerate(items) if index in drawn]


def sample_size(total: int, frac: float | None, cap: int | None) -> int:
    """How many of ``total`` items a sample keeps: ``min(cap, ceil(frac * total))``.

    Either bound may be absent, and with neither the sample is all of them. ``frac`` rounds
    up, so a nonzero share of a non-empty input never sizes to nothing.
    """
    size = total if frac is None else math.ceil(total * frac)
    return size if cap is None else min(cap, size)


def sample_decisions(
    decisions: Sequence[_Decision],
    *,
    frac: float | None,
    cap: int | None,
    seed: int,
) -> list[_Decision]:
    """The ``sample_size`` decisions whose pull requests rank lowest, in input order.

    Each is ranked by the ``repo`` and ``pr_number`` cells of the row ``build_row`` makes
    of it, rendered by ``csv_safe`` as ``write_csv`` renders them. A repository name or a
    pull request number never opens with a formula character, so the guard leaves both
    cells alone and the replay reads back the very text ranked here.
    """
    size = sample_size(len(decisions), frac, cap)
    return lowest_ranked(
        decisions, size, lambda decision: _decision_key(decision, seed)
    )


def _decision_key(decision: Mapping[str, Any], seed: int) -> bytes:
    row = build_row(decision, None)
    return sample_key(seed, csv_safe(row["repo"]), csv_safe(row["pr_number"]))
