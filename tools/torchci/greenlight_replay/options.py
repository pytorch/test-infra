"""The replay sweep's command-line surface and the validation on it.

Separated from the entry point so that the flags, their defaults and the rules
that reject a bad combination can be read and tested without importing the
orchestration. ``build_parser`` is the single description of what the tool
accepts; nothing else parses argv.
"""

from __future__ import annotations

import argparse

from torchci.greenlight_decisions.query import DEFAULT_REPO
from torchci.greenlight_replay.policy import DEFAULT_POLICY_REPO
from torchci.greenlight_replay.runner import DEFAULT_CONTEXT_WINDOW


DEFAULT_PARALLELISM = 4
DEFAULT_SEED = 0
DEFAULT_TIMEOUT_MINUTES = 37

# Must stay under a top-level /tmp/greenlight-* directory. restrict-read.py's
# scratch allowlist is a plain string prefix -- realpath('/tmp') + '/greenlight-'
# -- so a run directory anywhere else has every read of the diff and the metadata
# denied, and the reviewer returns a verdict about a pull request it never saw.
DEFAULT_WORKDIR = "/tmp/greenlight-replay"


def fraction(text: str) -> float:
    value = float(text)
    if not 0.0 < value <= 1.0:
        raise argparse.ArgumentTypeError(f"must be in (0, 1]: {text!r}")
    return value


def positive_int(text: str) -> int:
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1: {text!r}")
    return value


def build_parser(description: str | None = None) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="greenlight_replay",
        description=description,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--input",
        required=True,
        help="CSV written by python3 -m torchci.greenlight_decisions",
    )
    policy = parser.add_mutually_exclusive_group(required=True)
    policy.add_argument(
        "--policy-pr",
        type=positive_int,
        help=f"{DEFAULT_POLICY_REPO} pull request carrying the policy under test",
    )
    policy.add_argument(
        "--policy-ref", help=f"git ref in {DEFAULT_POLICY_REPO} to take the policy from"
    )
    size = parser.add_mutually_exclusive_group(required=True)
    size.add_argument(
        "--sample-frac", type=fraction, help="fraction of the framed rows to replay"
    )
    size.add_argument(
        "--sample-n", type=positive_int, help="how many framed rows to replay"
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help="sampling seed; the same seed reproduces the same sample "
        "(default: %(default)s)",
    )
    parser.add_argument(
        "--parallelism",
        type=positive_int,
        default=DEFAULT_PARALLELISM,
        help="concurrent reviewer runs (default: %(default)s)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="CSV destination (default: greenlight_replay_<timestamp>.csv)",
    )
    parser.add_argument(
        "--workdir",
        default=DEFAULT_WORKDIR,
        help="scratch root for the checkouts, run directories and checkpoint; must "
        "stay under a /tmp/greenlight-* directory (default: %(default)s)",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="keep the existing checkpoint and skip the pull requests already in it",
    )
    parser.add_argument(
        "--timeout-minutes",
        type=positive_int,
        default=DEFAULT_TIMEOUT_MINUTES,
        help="wall clock allowed per reviewer run (default: %(default)s)",
    )
    parser.add_argument(
        "--repo",
        default=DEFAULT_REPO,
        help="owner/name the sampled pull requests belong to (default: %(default)s)",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="model id for the local CLI, overriding the one the policy's own "
        "Bedrock inference profile maps to (default: whatever it maps to)",
    )
    parser.add_argument(
        "--context-window",
        type=positive_int,
        default=DEFAULT_CONTEXT_WINDOW,
        help="context window the chosen model must report. The runner rejects a "
        "run whose window differs, so a --model that serves a different one needs "
        "this set to match (default: %(default)s)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="resolve the frame and the sample, print the bill, invoke no model",
    )
    return parser
