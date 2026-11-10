import argparse
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from torchci.td.labels import build


def day(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d")


def main(argv: Optional[list[str]] = None) -> None:
    parser = argparse.ArgumentParser(
        prog="torchci.td.labels",
        description="Build TD's label dataset for [start, stop) (needs HUD ClickHouse).",
    )
    parser.add_argument("--start", type=day, required=True)
    parser.add_argument("--stop", type=day, required=True)
    parser.add_argument("--pytorch", type=Path, required=True, help="pytorch clone")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.start >= args.stop:
        parser.error("--start must be before --stop")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    print(json.dumps(build(args.start, args.stop, args.pytorch, args.out), indent=2))


if __name__ == "__main__":
    main()
