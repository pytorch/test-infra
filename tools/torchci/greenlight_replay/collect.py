"""Draw the sample once and record GitHub's answers about it, for CI's replay jobs.

The policy-replay workflow replays one sample under two policies, several times each,
in jobs that run at once. Were each job to frame the decisions against ClickHouse and
fetch every sampled pull request's diff, metadata and stack context itself, every read
would be made once per job against one workflow token's rate limit, and jobs that
started while the data moved would judge different samples. So the collect job does
both once: this entry point takes the harness's own flags, draws the sample with the
harness's own ``select_sample``, and builds each sampled pull request's reviewer inputs
under one policy as a sweep would, while :mod:`.gh_answers` records every GitHub answer
under ``--answers``. No reviewer runs.

CI runs it twice with one ``--answers``: under the base policy over the decisions
export, writing the sample with ``--output sample.csv``, then under the change policy
with ``--input sample.csv --presampled``, so a call both policies make reaches GitHub
once. Each replay job then runs the harness with ``--input sample.csv --presampled``
and ``GREENLIGHT_REPLAY_GITHUB_ANSWERS`` naming that directory.

A pull request whose inputs cannot be built is logged and counted: what was not
recorded fails again in each replay job, as a live fetch would have. When more than
half of the sample fails, a rate limit or an outage rather than a few awkward pull
requests, the exit status is 3, so CI stops before any replay job runs on that record.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, TYPE_CHECKING

from torchci.greenlight_decisions.__main__ import (
    EXIT_DEGRADED,
    EXIT_FAILED,
    EXIT_OK,
    LOG_FORMAT,
)
from torchci.greenlight_decisions.rows import write_csv
from torchci.greenlight_replay import gh_answers
from torchci.greenlight_replay.frame import (
    apply_frame,
    fetch_first_verdicts,
    fetch_landings,
    is_size_gate_decline,
    LAND,
    load_rows,
    rederive_first_landing,
    sample_rows,
)
from torchci.greenlight_replay.options import build_parser
from torchci.greenlight_replay.policy import materialize as materialize_policy, Policy
from torchci.greenlight_replay.sweep import (
    POLICY_DIRNAME,
    pr_number,
    row_inputs,
    RUN_FAILURE_ABORT_RATIO,
    RUNS_DIRNAME,
)


if TYPE_CHECKING:
    from clickhouse_connect.driver.client import Client


COLLECT_DIRNAME = "collect"

logger = logging.getLogger(__name__)


def connect() -> Client:
    """Open the ClickHouse client.

    The driver import is deferred so that importing this module -- to inspect the
    parser, or to exercise the orchestration -- does not require
    clickhouse_connect to be installed.
    """
    from torchci.clickhouse import get_clickhouse_client

    return get_clickhouse_client()


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser(__doc__)
    parser.add_argument(
        "--answers",
        required=True,
        help="directory to record GitHub's answers in; a call already recorded there "
        "is answered from it",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, stream=sys.stdout)
    gh_answers.record_into(Path(args.answers))

    sample = draw_sample(args)
    if sample is None:
        return EXIT_FAILED

    if args.output:
        try:
            write_csv(args.output, sample)
        except Exception as exc:
            logger.error("could not write %s: %s", args.output, exc, exc_info=True)
            return EXIT_FAILED

    policy_ref = args.policy_ref or str(args.policy_pr)
    workdir = Path(args.workdir).expanduser() / COLLECT_DIRNAME
    try:
        policy = materialize_policy(policy_ref, workdir / POLICY_DIRNAME)
    except Exception as exc:
        logger.error(
            "could not materialize the policy %s: %s", policy_ref, exc, exc_info=True
        )
        return EXIT_FAILED

    runs = workdir / RUNS_DIRNAME
    with ThreadPoolExecutor(max_workers=args.parallelism) as executor:
        collected = list(
            executor.map(lambda row: collect_one(args.repo, row, runs, policy), sample)
        )
    failed = [str(row.get("pr_number")) for row, ok in zip(sample, collected) if not ok]
    logger.info(
        "collected the inputs of %d of %d sampled pull requests under %s into %s",
        len(sample) - len(failed),
        len(sample),
        policy_ref,
        args.answers,
    )
    if failed:
        logger.warning(
            "%d of %d sampled pull requests could not be collected, and every replay "
            "job fails them too: %s",
            len(failed),
            len(sample),
            ", ".join(failed),
        )
    if len(failed) / len(sample) > RUN_FAILURE_ABORT_RATIO:
        logger.error(
            "more than half the sample could not be collected; a replay of this "
            "record would describe the failure, not the policy"
        )
        return EXIT_DEGRADED
    return EXIT_OK


def draw_sample(args: argparse.Namespace) -> list[dict[str, str]] | None:
    """``select_sample``, with the lines a run logs about it.

    None means there is nothing to replay and the caller exits 1: the sample could
    not be built, or the frame admitted no row.
    """
    try:
        sample, framed_total, funnel = select_sample(args)
    except Exception as exc:
        logger.error("could not build the sample: %s", exc, exc_info=True)
        return None
    logger.info("frame: %s", _format_counts(funnel, by_count=False))
    logger.info(
        "sampled %d of %d framed rows with seed %d",
        len(sample),
        framed_total,
        args.seed,
    )
    if not sample:
        logger.error("the frame admitted nothing to replay")
        return None
    return sample


def select_sample(
    args: argparse.Namespace,
) -> tuple[list[dict[str, str]], int, dict[str, int]]:
    """Load the corpus, frame it, re-derive multi-landing rows, and sample.

    A ``--presampled`` corpus already is that sample, so it comes back as it was read.
    """
    rows = load_rows(args.input)
    if args.presampled:
        return rows, len(rows), {"presampled": len(rows)}
    client = connect()
    landings = fetch_landings(client, args.repo)
    first_verdicts = fetch_first_verdicts(client, args.repo)
    framed, funnel = apply_frame(rows, landings, first_verdicts)
    sample = sample_rows(framed, frac=args.sample_frac, n=args.sample_n, seed=args.seed)
    requested = len(sample)
    # Re-deriving after sampling rather than before draws the identical sample --
    # the draw ranks rows by sha256(seed, repo, pr_number), which re-derivation does
    # not change -- while paying for only the rows that will be replayed. Each costs a
    # decision query and two compare calls, and a LookupError on a row nobody
    # sampled would otherwise fail the whole run, dry runs included.
    sample, declined = rederive_multi_landing(client, args.repo, sample, landings)
    if declined:
        # apply_frame settles the gate only for rows whose verdict is final, so a
        # multi-landing row reaches its canned decline only once re-derived.
        funnel["size_gate"] += declined
        logger.info(
            "%d of %d sampled rows were size-gate declines at their first landing",
            declined,
            requested,
        )
    return sample, len(framed), funnel


def rederive_multi_landing(
    client: Client,
    repo: str,
    rows: Sequence[dict[str, str]],
    landings: Mapping[int, Sequence[Any]],
) -> tuple[list[dict[str, str]], int]:
    """Restate the rows of pull requests whose code reached main more than once.

    Such a row's verdict is the one the export selected against the PR's final
    head, which here names a later landing than the one being replayed. The
    first landing is what the policy under test is asked about, so the decision
    columns are re-derived as of that instant -- the earliest event of kind
    ``land``, since a revert can sort ahead of it.
    """
    rederived: list[dict[str, str]] = []
    declined = 0
    for row in rows:
        lands = [
            event for event in landings.get(pr_number(row), ()) if event.kind == LAND
        ]
        if len(lands) > 1:
            restated = rederive_first_landing(
                client, repo, dict(row), min(event.ts for event in lands)
            )
            # The canned decline came from a byte comparison with no model in it,
            # so replaying it would measure the cap rather than the policy.
            if is_size_gate_decline(restated):
                declined += 1
                continue
            rederived.append(restated)
        else:
            rederived.append(dict(row))
    return rederived, declined


def collect_one(repo: str, row: Mapping[str, str], runs: Path, policy: Policy) -> bool:
    """Build one sampled pull request's reviewer inputs, recording what GitHub says.

    Never raises, since it runs on a thread pool; a failure is logged and reported as
    False.
    """
    label = str(row.get("pr_number"))
    try:
        row_inputs(repo, row, runs / str(pr_number(row)), policy)
    except Exception as exc:
        logger.error("could not collect PR %s: %s", label, exc, exc_info=True)
        return False
    return True


def _format_counts(counts: Mapping[str, int], *, by_count: bool = True) -> str:
    ordered: list[tuple[str, int]] = list(counts.items())
    if by_count:
        ordered.sort(key=lambda item: (-item[1], item[0]))
    return ", ".join(f"{name}={count}" for name, count in ordered) or "(none)"


if __name__ == "__main__":
    sys.exit(main())
