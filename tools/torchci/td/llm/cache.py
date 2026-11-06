"""The harness's text-keyed embedding cache and its embedding worker processes.

Embeddings live under `<cache>/emb/<model key>/<group>/`, where the group hashes what
changes an embedding besides the text (revision, kind, prompt, token limit). Each shard
is `<name>.npy` plus `<name>.keys.json` (the sha256 of each row's text), written when the
shard completes, so a rerun embeds only the texts no shard holds.
"""

import argparse
import contextlib
import dataclasses
import fcntl
import hashlib
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterator, Optional, Sequence

import numpy as np
from torchci.td.llm.bundle import atomic_file, load_npy_checked
from torchci.td.llm.models import MODELS, ModelSpec


logger = logging.getLogger(__name__)

SHARD_TEXTS = 256
BATCH_SIZE = 16
KINDS = ("query", "doc")
DTYPE = np.dtype("<f4")
KEYS_SUFFIX = ".keys.json"


def ensure_dir(path: Path) -> Path:
    """The directory, created if needed, readable by its owner only."""
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


@contextlib.contextmanager
def exclusive(cache_dir: Path) -> Iterator[None]:
    """Hold the cache directory's lock; refuse to start while another process holds it."""
    ensure_dir(cache_dir)
    with open(cache_dir / "lock", "a") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(
                f"{cache_dir} is in use by another harness run"
            ) from None
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def spec_for(key: str, instruction: bool) -> ModelSpec:
    spec = MODELS[key]
    return spec if instruction else dataclasses.replace(spec, query_prompt="")


def text_key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def group_dir(cache_dir: Path, spec: ModelSpec, kind: str) -> Path:
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind}")
    prompt = spec.query_prompt if kind == "query" else spec.doc_prompt
    params = [spec.revision, kind, prompt, spec.max_tokens]
    group = hashlib.sha256(json.dumps(params).encode()).hexdigest()[:16]
    path = ensure_dir(cache_dir / "emb" / spec.key / group)
    if not (path / "params.json").exists():
        with atomic_file(path / "params.json", "w") as f:
            json.dump(params, f)
    return path


def load(cache_dir: Path, spec: ModelSpec, kind: str) -> dict[str, np.ndarray]:
    """Text sha256 -> embedding row, for every complete shard of the group."""
    rows: dict[str, np.ndarray] = {}
    for keys_file in sorted(group_dir(cache_dir, spec, kind).glob(f"*{KEYS_SUFFIX}")):
        keys = json.loads(keys_file.read_text())
        npy = keys_file.with_name(keys_file.name[: -len(KEYS_SUFFIX)] + ".npy")
        rows.update(zip(keys, load_npy_checked(npy, DTYPE, rows=len(keys))))
    return rows


def write_shard(
    directory: Path, name: str, keys: Sequence[str], matrix: np.ndarray
) -> None:
    """The matrix first, then its keys: a shard counts once both are in place."""
    with atomic_file(directory / f"{name}.npy") as f:
        np.lib.format.write_array(
            f, np.ascontiguousarray(matrix, dtype=DTYPE), allow_pickle=False
        )
    with atomic_file(directory / f"{name}{KEYS_SUFFIX}", "w") as f:
        json.dump(list(keys), f)


def run_workers(commands: list[list[str]], logs: Optional[list[Path]] = None) -> None:
    """Run worker subprocesses in parallel and fail if any exits non-zero."""
    procs = []
    for i, command in enumerate(commands):
        out = open(logs[i], "ab") if logs else None
        stderr = subprocess.STDOUT if out else None
        procs.append((subprocess.Popen(command, stdout=out, stderr=stderr), out))
    failed = []
    for i, (proc, out) in enumerate(procs):
        code = proc.wait()
        if out:
            out.close()
        if code != 0:
            failed.append(f"worker {i} exited {code}")
    if failed:
        raise RuntimeError("; ".join(failed))


def embed(
    cache_dir: Path,
    spec: ModelSpec,
    kind: str,
    texts: Sequence[str],
    instruction: bool,
    procs: int,
    threads: int,
) -> np.ndarray:
    """The embeddings of texts (rows in order), embedding the missing ones first."""
    from torchci.td.llm.models import download

    cached = load(cache_dir, spec, kind)
    missing = sorted({t for t in texts if text_key(t) not in cached}, key=len)
    if missing:
        download(MODELS[spec.key], cache_dir / "models" / spec.key)
        work = ensure_dir(cache_dir / "work")
        commands, logs = [], []
        for i in range(min(procs, len(missing))):
            path = work / f"{spec.key}-{kind}-{os.getpid()}-{i}.json"
            with atomic_file(path, "w") as f:
                json.dump(missing[i::procs], f)
            command = [sys.executable, "-m", "torchci.td.llm.cache", "embed"]
            command += ["--cache-dir", str(cache_dir), "--model", spec.key]
            command += ["--kind", kind, "--threads", str(threads), "--texts", str(path)]
            commands.append(command + ([] if instruction else ["--no-instruction"]))
            logs.append(work / f"{path.stem}.log")
        logger.info(
            "embedding %d %s texts with %s in %d workers",
            len(missing),
            kind,
            spec.key,
            len(commands),
        )
        run_workers(commands, logs)
        for command in commands:
            os.unlink(command[command.index("--texts") + 1])
        cached = load(cache_dir, spec, kind)
    absent = [t for t in texts if text_key(t) not in cached]
    if absent:
        raise RuntimeError(f"{len(absent)} texts still missing from the cache")
    if not texts:
        return np.zeros((0, 0), dtype=DTYPE)
    return np.stack([cached[text_key(t)] for t in texts])


def worker(args: argparse.Namespace) -> None:
    from torchci.td.llm.models import Embedder

    spec = spec_for(args.model, not args.no_instruction)
    texts = json.loads(Path(args.texts).read_text())
    directory = group_dir(args.cache_dir, spec, args.kind)
    embedder = Embedder(
        spec, args.cache_dir / "models" / spec.key, threads=args.threads
    )
    start = time.monotonic()
    for i in range(0, len(texts), SHARD_TEXTS):
        part = texts[i : i + SHARD_TEXTS]
        matrix = embedder.encode(part, args.kind, batch_size=BATCH_SIZE)
        name = f"{os.getpid()}-{time.time_ns()}"
        write_shard(directory, name, [text_key(t) for t in part], matrix)
        rate = (i + len(part)) / (time.monotonic() - start)
        print(f"{i + len(part)}/{len(texts)} texts, {rate:.1f}/s", flush=True)


def main(argv: Optional[list[str]] = None) -> None:
    parser = argparse.ArgumentParser(prog="torchci.td.llm.cache")
    sub = parser.add_subparsers(dest="command", required=True)
    embed_parser = sub.add_parser(
        "embed", help="embed a JSON list of texts into the cache"
    )
    embed_parser.add_argument("--cache-dir", type=Path, required=True)
    embed_parser.add_argument("--model", choices=sorted(MODELS), required=True)
    embed_parser.add_argument("--kind", choices=KINDS, required=True)
    embed_parser.add_argument("--threads", type=int, required=True)
    embed_parser.add_argument("--texts", type=Path, required=True)
    embed_parser.add_argument("--no-instruction", action="store_true")
    worker(parser.parse_args(argv))


if __name__ == "__main__":
    main()
