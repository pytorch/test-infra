"""The sweep's read-only inputs: a check of its arguments, a local shard directory it
never writes, the record of an input file, and the cached main landings of its window
(main_failures.py)."""

import argparse
import hashlib
from datetime import date, datetime
from pathlib import Path
from typing import Optional

from torchci.td.scorer import main_failures, store


def bad_args(args: argparse.Namespace) -> Optional[str]:
    """Why the arguments are refused, or None: exactly one of --start-up and --model
    (the start-up table's source), and an --out that is no .npz (the vectors' name) and
    neither lies in --cache-dir nor names an input."""
    if (args.start_up is None) == (args.model is None):
        return "give exactly one of --start-up and --model"
    out = Path(args.out).resolve()
    if out.suffix == ".npz":
        return "--out names the JSON rows; the .npz is written next to it"
    cache = Path(args.cache_dir).resolve()
    inputs = (args.test_times, args.start_up, args.model, args.main_cache)
    for path in (out, out.with_suffix(".npz")):
        if path.is_relative_to(cache) or any(
            x is not None and path == Path(x).resolve() for x in inputs
        ):
            return f"--out would overwrite {path}, inside --cache-dir or an input"
    return None


class ReadOnlyDirStore(store.DirStore):
    """A local shard directory that is never created or written."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def put_if_absent(self, day: str, data: bytes) -> bool:
        raise RuntimeError(f"the sweep is read-only: refusing to write {day}")


def file_record(path: str) -> dict[str, str]:
    return {"path": path, "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()}


def main_landings(
    path: Path, start: date, stop: date
) -> tuple[list[main_failures.MainLanding], dict[str, int]]:
    """The cached main landings of [start, stop), fetched and saved when the file is
    absent; a cache of another range is refused."""
    if path.exists():
        landings, meta = main_failures.load_landings(path.read_text())
        if (meta["start"], meta["stop"]) != (start, stop):
            raise ValueError(
                f"{path} holds {meta['start']}..{meta['stop']}, not {start}..{stop}"
            )
        return landings, meta["counts"]
    landings, counts = main_failures.fetch_main_landings(
        datetime.combine(start, datetime.min.time()),
        datetime.combine(stop, datetime.min.time()),
    )
    main_failures.save_landings(path, landings, start, stop, counts)
    return landings, counts
