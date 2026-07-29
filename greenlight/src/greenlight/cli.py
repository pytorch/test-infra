"""Command-line entry point for the greenlight service."""

from __future__ import annotations

import argparse
import dataclasses
import logging
import sys
from typing import TYPE_CHECKING

from greenlight import act, plan
from greenlight.config import Config
from greenlight.exit_codes import EXIT_ALREADY_RUNNING, EXIT_FAILURE, EXIT_OK
from greenlight.guards import LockError, SingleInstanceError, single_instance_lock
from greenlight.log import configure_logging
from greenlight.runner import execute_once, run_forever

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

logger = logging.getLogger(__name__)

PHASES: dict[str, Callable[[Config], None]] = {"plan": plan.run, "act": act.run}


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--loop", action="store_true", help="run continuously as a daemon")
    common.add_argument("--interval", type=float, default=None, help="seconds between iterations")
    common.add_argument("--log-level", default=None, help="logging level name")
    common.add_argument("--lock-path", default=None, help="single-instance lock file path")

    parser = argparse.ArgumentParser(
        prog="greenlight",
        description="Run a greenlight phase once (default) or as a resilient daemon with --loop.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "plan",
        parents=[common],
        help="select, gate, and score PRs; decide which need review",
        description="Select, gate, and score open PRs and decide which need a code review.",
    )
    subparsers.add_parser(
        "act",
        parents=[common],
        help="turn review decisions into PR approvals/revocations",
        description="Turn review decisions into PR approvals or revocations.",
    )
    return parser


def _config_from_args(args: argparse.Namespace) -> Config:
    config = Config.from_env()
    if args.interval is not None:
        config = dataclasses.replace(config, interval_seconds=args.interval)
    if args.log_level is not None:
        config = dataclasses.replace(config, log_level=args.log_level)
    if args.lock_path is not None:
        config = dataclasses.replace(config, lock_path=args.lock_path)
    return config


def _phase_lock_path(base: str | None, phase: str) -> str | None:
    if not base:
        return None
    return f"{base}.{phase}"


def _dispatch(config: Config, run: Callable[[Config], None], *, loop: bool, lock_path: str | None) -> int:
    try:
        with single_instance_lock(lock_path):
            if loop:
                run_forever(config, run=run)
            else:
                execute_once(config, run)
    except SingleInstanceError:
        logger.error("another greenlight instance is running; skipping")
        return EXIT_ALREADY_RUNNING
    except LockError:
        logger.exception("cannot acquire single-instance lock at %s", lock_path)
        return EXIT_FAILURE
    except Exception:
        logger.exception("greenlight phase failed")
        return EXIT_FAILURE
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        config = _config_from_args(args)
        configure_logging(config.log_level)
    except ValueError as exc:
        parser.error(str(exc))
    lock_path = _phase_lock_path(config.lock_path, args.command)
    if lock_path is not None:
        logger.info("using single-instance lock path %s", lock_path)
    run = PHASES[args.command]
    return _dispatch(config, run, loop=args.loop, lock_path=lock_path)
