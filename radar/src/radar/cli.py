"""Command-line entry point for the radar service."""

from __future__ import annotations

import argparse
import dataclasses
import logging
import sys
from typing import TYPE_CHECKING

from radar.config import Config
from radar.core import run_once
from radar.guards import SingleInstanceError, iteration_timeout, single_instance_lock
from radar.log import configure_logging
from radar.runner import run_forever

if TYPE_CHECKING:
    from collections.abc import Sequence

EXIT_OK = 0
EXIT_FAILURE = 1
# 2 is reserved by argparse for CLI usage errors
EXIT_ALREADY_RUNNING = 3


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="radar",
        description="Run one radar iteration (default) or a resilient daemon with --loop.",
    )
    parser.add_argument("--loop", action="store_true", help="run continuously as a daemon")
    parser.add_argument("--interval", type=float, default=None, help="seconds between iterations")
    parser.add_argument("--log-level", default=None, help="logging level name")
    parser.add_argument("--lock-path", default=None, help="single-instance lock file path")
    return parser


def _config_from_args(args: argparse.Namespace) -> Config:
    config = Config.from_env()
    if args.interval is not None:
        config = dataclasses.replace(config, interval_seconds=args.interval)
    if args.log_level is not None:
        config = dataclasses.replace(config, log_level=args.log_level.upper())
    if args.lock_path is not None:
        config = dataclasses.replace(config, lock_path=args.lock_path)
    return config


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    config = _config_from_args(args)
    configure_logging(config.log_level)
    logger = logging.getLogger("radar.cli")
    try:
        with single_instance_lock(config.lock_path):
            if args.loop:
                run_forever(config)
            else:
                with iteration_timeout(config.max_runtime_seconds):
                    run_once(config)
    except SingleInstanceError:
        logger.error("another radar instance is running; skipping")
        return EXIT_ALREADY_RUNNING
    except Exception:
        logger.exception("radar iteration failed")
        return EXIT_FAILURE
    return EXIT_OK
