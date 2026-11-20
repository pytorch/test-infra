"""Day shard storage: the shard file format and the stores that hold one file per day.

A shard file is gzipped JSON lines: a `meta` record, a `files` record listing the day's
test files, then `run` and `unit` records whose test files are indices into it, which
makes a shard about 5x smaller than with names. Scores keep SIG_DIGITS significant digits.
"""

import gzip
import json
import logging
import time
from dataclasses import asdict
from datetime import date
from pathlib import Path
from typing import Any, Optional, Protocol

from torchci.td.scorer.logs import RAW_BUCKET
from torchci.td.scorer.shards import (
    build_day_shard,
    DayShard,
    MAX_MISSING_LOGS,
    Run,
    Unit,
)


logger = logging.getLogger(__name__)

SHARD_FORMAT = "v2"
# The refit job's 285 minutes (td-scorer.yml) leave the rest for fitting, the reports
# and the upload, within the 300 minutes its S3 credentials last.
BACKFILL_SECONDS = 3 * 60 * 60
# The bound is in the key: a marker made under another bound is not read.
GAP_SUFFIX = f"-gap-{MAX_MISSING_LOGS:g}"
S3_PREFIX = f"td_scorer/rows/{SHARD_FORMAT}/"
SIG_DIGITS = 9
FILE_LISTS = ("ran", "excluded", "failed", "neither", "main_broken")


def _round(score: float) -> float:
    return float(f"{score:.{SIG_DIGITS}g}")


def dump_shard(shard: DayShard) -> bytes:
    names: set[str] = set()
    for u in shard.units:
        for key in FILE_LISTS:
            names.update(getattr(u, key))
    for r in shard.runs:
        for per_file in r.scores.values():
            names.update(per_file)
        names.update(r.aggregated)
    files = sorted(names)
    index = {f: i for i, f in enumerate(files)}
    lines: list[dict[str, Any]] = [
        {"kind": "meta", "day": shard.day, "format": SHARD_FORMAT, **shard.meta},
        {"kind": "files", "files": files},
    ]
    for r in shard.runs:
        record = asdict(r)
        record["scores"] = {
            h: [[index[f], _round(s)] for f, s in sorted(v.items())]
            for h, v in r.scores.items()
        }
        record["aggregated"] = [
            [index[f], _round(s)] for f, s in sorted(r.aggregated.items())
        ]
        lines.append({"kind": "run", **record})
    for u in sorted(shard.units, key=lambda u: (u.build_env, u.test_config, u.run_id)):
        record = asdict(u)
        for key in FILE_LISTS:
            record[key] = sorted(index[f] for f in record[key])
        lines.append({"kind": "unit", **record})
    text = "".join(
        json.dumps(x, sort_keys=True, separators=(",", ":")) + "\n" for x in lines
    )
    return gzip.compress(text.encode(), mtime=0)


def load_shard(data: bytes) -> DayShard:
    shard: Optional[DayShard] = None
    files: list[str] = []
    for line in gzip.decompress(data).decode().splitlines():
        record = json.loads(line)
        kind = record.pop("kind")
        if kind == "meta":
            if record.pop("format") != SHARD_FORMAT:
                raise ValueError(f"shard format is not {SHARD_FORMAT}")
            shard = DayShard(day=record.pop("day"), meta=record)
        elif shard is None:
            raise ValueError("shard does not start with its meta record")
        elif kind == "files":
            files = record["files"]
        elif kind == "run":
            record["scores"] = {
                h: {files[i]: s for i, s in v} for h, v in record["scores"].items()
            }
            record["aggregated"] = {files[i]: s for i, s in record["aggregated"]}
            shard.runs.append(Run(**record))
        elif kind == "unit":
            for key in FILE_LISTS:
                record[key] = [files[i] for i in record[key]]
            shard.units.append(Unit(**record))
    if shard is None:
        raise ValueError("empty shard")
    return shard


class ShardStore(Protocol):
    def exists(self, day: str) -> bool: ...

    def get(self, day: str) -> Optional[bytes]: ...

    def put_if_absent(self, day: str, data: bytes) -> bool: ...


class DirStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.mkdir(parents=True, exist_ok=True)

    def _file(self, day: str) -> Path:
        return self.path / f"{day}.jsonl.gz"

    def exists(self, day: str) -> bool:
        return self._file(day).exists()

    def get(self, day: str) -> Optional[bytes]:
        return self._file(day).read_bytes() if self.exists(day) else None

    def put_if_absent(self, day: str, data: bytes) -> bool:
        try:
            with open(self._file(day), "xb") as f:
                f.write(data)
        except FileExistsError:
            return False
        return True


class S3Store:
    def __init__(self, bucket: str = RAW_BUCKET, prefix: str = S3_PREFIX) -> None:
        import boto3  # type: ignore[import]

        self.client = boto3.client("s3")
        self.bucket, self.prefix = bucket, prefix

    def _key(self, day: str) -> str:
        return f"{self.prefix}{day}.jsonl.gz"

    @staticmethod
    def _missing(error: Exception) -> bool:
        code = getattr(error, "response", {}).get("Error", {}).get("Code")
        return code in ("404", "NoSuchKey", "NotFound")

    def exists(self, day: str) -> bool:
        from botocore.exceptions import ClientError  # type: ignore[import]

        try:
            self.client.head_object(Bucket=self.bucket, Key=self._key(day))
        except ClientError as e:
            if self._missing(e):
                return False
            raise
        return True

    def get(self, day: str) -> Optional[bytes]:
        from botocore.exceptions import ClientError

        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=self._key(day))
        except ClientError as e:
            if self._missing(e):
                return None
            raise
        return obj["Body"].read()  # type: ignore[no-any-return]

    def put_if_absent(self, day: str, data: bytes) -> bool:
        if self.exists(day):
            return False
        self.client.put_object(
            Bucket=self.bucket,
            Key=self._key(day),
            Body=data,
            ContentType="application/gzip",
        )
        return True


class Shards:
    """Day shards for one refit: read from the store, else built once, newest first,
    until BACKFILL_SECONDS have passed; the days left unbuilt are listed in `missing`. A
    healthy built day before `final_before` (whose runs have all finished) is written to
    the store as soon as it is built; a later one, an unhealthy one, or any day when there
    is no store, is kept in memory only.

    Unhealthy days are left out. Those with a gap, listed in `gaps`, never fail a run:
    days whose TD logs are missing or unparsable, and permanent days (shards.py) before
    `mark_before`, which also get a marker in the store so that later runs skip them. The
    rest, listed in `unhealthy`, are retried by the next run: a fetch failed, building
    raised, or a recent day has no outcomes."""

    def __init__(
        self, store: Optional[ShardStore], final_before: date, mark_before: date
    ) -> None:
        self.store, self.final_before = store, final_before
        self.mark_before = mark_before
        self.memory: dict[str, bytes] = {}
        self.unhealthy: list[str] = []
        self.gaps: list[str] = []
        self.missing: list[str] = []

    def ensure(self, days: list[date]) -> None:
        started = time.monotonic()
        for day in sorted(days, reverse=True):
            key = day.isoformat()
            if key in self.memory or (self.store and self.store.exists(key)):
                continue
            if self.store and self.store.exists(key + GAP_SUFFIX):
                self.gaps.append(key)
                continue
            if time.monotonic() - started >= BACKFILL_SECONDS:
                self.missing.append(key)
                continue
            try:
                shard = build_day_shard(day)
            except Exception as e:
                logger.error("day %s failed to build: %s", key, e, exc_info=True)
                self.unhealthy.append(key)
                continue
            self._keep(day, shard)

    def _keep(self, day: date, shard: DayShard) -> None:
        key, data = day.isoformat(), dump_shard(shard)
        if shard.healthy and self.store is not None and day < self.final_before:
            self.store.put_if_absent(key, data)
            return
        self.memory[key] = data
        if shard.healthy:
            return
        logger.error("day %s is unhealthy, not stored: %s", key, shard.meta)
        permanent = shard.permanent and day < self.mark_before
        (self.gaps if shard.logs_gap or permanent else self.unhealthy).append(key)
        if permanent and self.store is not None:
            meta = {**shard.meta, "max_missing_logs": MAX_MISSING_LOGS}
            marker = dump_shard(DayShard(day=key, meta=meta))
            self.store.put_if_absent(key + GAP_SUFFIX, marker)

    def usable(self, days: list[date]) -> list[date]:
        """The days that have a healthy shard."""
        skip = set(self.unhealthy) | set(self.gaps) | set(self.missing)
        return [d for d in days if d.isoformat() not in skip]

    def get(self, day: date) -> DayShard:
        key = day.isoformat()
        data = self.memory.get(key)
        if data is None and self.store is not None:
            data = self.store.get(key)
        if data is None:
            raise KeyError(f"no shard for {key}")
        return load_shard(data)
