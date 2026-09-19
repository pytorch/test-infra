"""The durable record of what a sweep has already paid for.

One JSON line per finished pull request, appended and fsynced before the next
one starts, because a full replay is hours of paid model time and a crash should
cost the run in flight and nothing already bought. Each line carries that pull
request's four cells, the input they were computed from, and the run metrics
behind them, so ``--resume`` rebuilds the finished part of the output without
re-running it and can still say what the whole sweep cost.

**Every row in the output comes through here, including the rows whose runs just
finished.** ``append_checkpoint`` is the only caller of ``replay_cells``, so
there is one place a ``RunResult`` becomes cells; a second path rendering a live
result straight into a row would be where the ``harness:`` convention and the
recovered-verdict rule quietly stopped applying to half the file.

**A line records the input its verdict was computed from, and ``--resume`` will
not reuse one that disagrees with the row in front of it.** A pull request number
is not an identity: re-export the corpus between the crash and the resume -- the
natural thing to do -- and the same number can name a newer verdict against a
different head. Reusing the stored cells there would print a verdict the reviewer
produced for one head beside a ``decision`` belonging to another, and the result
reads as a policy flip that never happened, in the one column pair this tool
exists to produce, with nothing else in the file able to contradict it.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any, Mapping, Sequence

from torchci.greenlight_replay.verdict_cells import as_text, NEW_COLUMNS, replay_cells


logger = logging.getLogger(__name__)

CHECKPOINT_PR_KEY = "pr_number"

# What the verdict was computed from, recorded so a resumed entry can prove it
# belongs to the row it is about to be merged into. These are the row cells the
# reviewer is actually driven by: the diff it reads is ``base_ref...head`` in
# ``repo``. The pull request number is not among them because it is the key the
# entry is stored under, so the lookup already enforces it.
#
# Stored verbatim rather than hashed. A digest would compare just as well and
# read as nothing at all, and the first question anyone asks of a re-run is which
# field moved.
CHECKPOINT_IDENTITY_FIELDS = ("repo", "base_ref", "decision_head_sha")

# Carried beside the cells, never into the CSV. A successful run spends nothing
# on diagnostics in its message, so without these a resumed sweep could not total
# what it spent -- the runs it skipped are the ones it already paid for.
RUN_METRIC_FIELDS = ("cost_usd", "duration_s", "num_turns")


def append_checkpoint(path: Path, row: Mapping[str, str], result: Any) -> None:
    """Record one finished pull request as a JSON line, durable on return.

    Takes the row rather than the number because the line has to say what the
    verdict was computed from, not only which pull request it was about. The
    cells are rendered here, on the way in, so the checkpoint holds the verdict
    in the form the CSV will carry it rather than a second encoding of the same
    run. The run metrics go beside them, as numbers, for a caller totalling a
    sweep that resumed.

    Appends and fsyncs rather than rewriting, so the cost of a crash is bounded
    by the one run in flight no matter how far into a replay it happens.
    Concurrency is the caller's: hold a lock across this call.
    """
    record = {
        CHECKPOINT_PR_KEY: int(row[CHECKPOINT_PR_KEY]),
        **replay_cells(result),
        **dict(zip(CHECKPOINT_IDENTITY_FIELDS, _row_identity(row))),
        **_metrics(lambda field: getattr(result, field, None)),
    }
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def load_checkpoint(path: Path) -> dict[int, dict]:
    """Read ``path`` back as ``{pr_number: entry}``.

    An entry holds the four new columns as strings, the input identity the
    verdict was computed from, and whichever run metrics were recorded as
    numbers. ``build_replay_row`` takes the columns and ``matching_entries``
    takes the identity; the metrics are for a caller adding up a sweep. A metric
    that is not a number is dropped rather than coerced -- a total is better
    short an entry it can name than wrong by one it guessed at.

    Read here without judgement: an entry is returned whether or not it still
    describes anything in the sample. Deciding that is ``matching_entries``.

    A missing file is an empty result -- the first run of a replay has no
    checkpoint. A line that will not parse is reported and skipped rather than
    failing the resume: a half-written final line is the ordinary shape of the
    crash this file exists to survive. Its number is logged because a bad line
    anywhere else is corruption, and only the reader can tell which it is.
    A pull request recorded twice keeps its later run.
    """
    records: dict[int, dict] = {}
    try:
        # Iterated rather than read through str.splitlines(): splitlines() breaks
        # on U+2028 and U+0085 among others, which LLM-authored prose can carry,
        # while text-mode iteration breaks only on the newlines json.dumps
        # escapes. Nothing in the loop opens a file, so the FileNotFoundError
        # caught below can only be this open.
        with open(path, encoding="utf-8") as handle:
            for lineno, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    pr_number = int(record[CHECKPOINT_PR_KEY])
                except (KeyError, TypeError, ValueError):
                    logger.warning(
                        "skipping unreadable checkpoint line %d of %s",
                        lineno,
                        path,
                        exc_info=True,
                    )
                    continue
                records[pr_number] = {
                    **{column: as_text(record.get(column)) for column in NEW_COLUMNS},
                    **{
                        field: as_text(record[field])
                        for field in CHECKPOINT_IDENTITY_FIELDS
                        if field in record
                    },
                    **_metrics(record.get),
                }
    except FileNotFoundError:
        return {}
    return records


def matching_entries(
    rows: Sequence[Mapping[str, str]],
    recorded: Mapping[int, Mapping[str, Any]],
) -> dict[int, dict]:
    """The recorded entries that may stand in for these rows, keyed by number.

    An entry qualifies only when the input it names is the input the row names.
    A pull request number is not enough: re-export the corpus between a crash and
    a resume and the same number can carry a newer verdict against a different
    head, at which point the stored cells describe a review of code this row is
    no longer about. Reusing them would print a verdict beside a ``decision`` it
    was never computed against -- a policy flip that never happened, and one
    nothing else in the output could contradict.

    So a disagreement drops the entry and is logged, which leaves the pull
    request pending and re-runs it. An entry recorded before the identity existed
    cannot prove anything either way and is treated the same: the money is
    already spent, and the wrong answer costs more than spending it again.

    Entries for pull requests outside ``rows`` are left alone rather than
    discarded -- they belong to a wider sweep over the same policy and stay on
    disk for it.
    """
    matched: dict[int, dict] = {}
    seen: set[int] = set()

    for row in rows:
        number = int(row[CHECKPOINT_PR_KEY])
        if number in seen:
            logger.warning(
                "pull request %s is in the sample more than once; the checkpoint "
                "holds one entry per number, so these rows cannot both be reused",
                number,
            )
        seen.add(number)

        entry = recorded.get(number)
        if entry is None:
            continue
        wanted = _row_identity(row)
        if _entry_identity(entry) == wanted:
            matched[number] = dict(entry)
            continue
        logger.warning(
            "PR %s: the checkpoint holds a verdict computed from %s, but this "
            "row is %s -- re-running rather than reusing it",
            number,
            _describe_identity(_entry_identity(entry)),
            _describe_identity(wanted),
        )

    outside = sorted(set(recorded) - seen)
    if outside:
        logger.info(
            "%d checkpointed pull requests are outside this sample and are kept "
            "on disk rather than reused: %s",
            len(outside),
            ", ".join(str(number) for number in outside),
        )
    return matched


def _row_identity(row: Mapping[str, str]) -> tuple[str, ...]:
    return tuple(as_text(row.get(field)) for field in CHECKPOINT_IDENTITY_FIELDS)


def _entry_identity(entry: Mapping[str, Any]) -> tuple[str, ...] | None:
    """The input a checkpoint entry names, or ``None`` if it named none.

    Absence is judged on the keys rather than on their values: an entry written
    before the identity existed has no keys, while one written for a row with a
    blank cell has the key and a blank, and only the first of those is unable to
    answer the question.
    """
    if any(field not in entry for field in CHECKPOINT_IDENTITY_FIELDS):
        return None
    return tuple(as_text(entry[field]) for field in CHECKPOINT_IDENTITY_FIELDS)


def _describe_identity(identity: tuple[str, ...] | None) -> str:
    if identity is None:
        return "an input it did not record"
    return " ".join(
        f"{field}={value or '(blank)'}"
        for field, value in zip(CHECKPOINT_IDENTITY_FIELDS, identity)
    )


def _metrics(read: Callable[[str], Any]) -> dict[str, Any]:
    """The run metrics ``read`` can supply as real numbers, in checkpoint form.

    ``bool`` is excluded explicitly: it passes ``isinstance(x, int)``, and a
    ``True`` summed into a cost total is a silent dollar.
    """
    return {
        field: value
        for field, value in ((name, read(name)) for name in RUN_METRIC_FIELDS)
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    }
