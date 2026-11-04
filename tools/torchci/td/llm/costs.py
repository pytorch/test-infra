"""The cost of a candidate model: one retrieval end to end per process, and the corpus
tokens per second the nightly indexer would embed."""

import argparse
import json
import random
import resource
import statistics
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np
from torchci.td.llm.bundle import atomic_file
from torchci.td.llm.cache import BATCH_SIZE, ensure_dir
from torchci.td.llm.corpus import Unit
from torchci.td.llm.models import MODELS, ModelSpec


TOKEN_SAMPLE = 256


def count_parameters(model_dir: Path) -> int:
    """Summed tensor sizes from the safetensors headers."""
    total = 0
    for path in model_dir.rglob("*.safetensors"):
        with open(path, "rb") as f:
            header = json.loads(f.read(struct.unpack("<Q", f.read(8))[0]))
        for name, info in header.items():
            if name != "__metadata__":
                total += int(np.prod(info["shape"]))
    return total


def doc_tokens(spec: ModelSpec, model_dir: Path, texts: Sequence[str]) -> int:
    """Tokens the model reads for the texts as documents, cut at its token limit."""
    from torchci.td.llm.models import token_counts

    counts = token_counts(model_dir, [spec.doc_prompt + t for t in texts])
    return sum(min(n, spec.max_tokens) for n in counts)


def _probe(command: list[str]) -> dict[str, Any]:
    out = subprocess.run(command, capture_output=True, text=True, check=True).stdout
    return json.loads(out.strip().splitlines()[-1])  # type: ignore[no-any-return]


def measure(
    cache_dir: Path,
    spec: ModelSpec,
    embeddings: np.ndarray,
    units: Sequence[Unit],
    commit: str,
    repo: Path,
    revs: Sequence[str],
    threads: int,
) -> dict[str, Any]:
    """Build the bundle the indexer would ship, time a retrieval of each diff in its own
    process (bundle read, model load, diff, encode, score), and measure corpus tokens per
    second."""
    from torchci.td.llm import bundle
    from torchci.td.llm.models import download

    if not revs:
        raise ValueError("no diffs to probe")
    model_dir = download(spec, cache_dir / "models" / spec.key)
    texts = [u.text for u in units]
    sample = random.Random(0).sample(texts, min(TOKEN_SAMPLE, len(texts)))
    base = [sys.executable, "-m", "torchci.td.llm.costs"]
    common = ["--cache-dir", str(cache_dir), "--threads", str(threads)]
    with tempfile.TemporaryDirectory(dir=ensure_dir(cache_dir / "work")) as tmp:
        path, sample_file = Path(tmp) / "bundle.tar", Path(tmp) / "sample.json"
        bundle.write(path, embeddings, [u.test for u in units], spec, model_dir, commit)
        bundle_args = ["--bundle", str(path), "--pytorch-git", str(repo)]
        probes = [
            _probe([*base, "probe", *common, *bundle_args, "--rev", r]) for r in revs
        ]
        with atomic_file(sample_file, "w") as f:
            json.dump(sample, f)
        speed = _probe(
            [*base, "tokens", *common, "--model", spec.key, "--texts", str(sample_file)]
        )
        bundle_bytes = path.stat().st_size
    return {
        "parameters": count_parameters(model_dir),
        "bundle_bytes": bundle_bytes,
        "peak_rss_bytes": max(p["peak_rss_bytes"] for p in probes),
        "per_pr_seconds": statistics.median(p["seconds"] for p in probes),
        "probe_diffs": len(probes),
        "tokens_per_second": speed["tokens_per_second"],
        "corpus_tokens": doc_tokens(spec, model_dir, texts),
        "corpus_units": len(texts),
    }


def probe(args: argparse.Namespace) -> None:
    from torchci.td.llm import bundle, diff, scoring
    from torchci.td.llm.models import Embedder
    from torchci.td.llm.pytorch_repo import diff_text

    start = time.monotonic()
    with tempfile.TemporaryDirectory(dir=ensure_dir(args.cache_dir / "work")) as tmp:
        b = bundle.read(args.bundle, Path(tmp) / "bundle")
        embedder = Embedder(b.spec, b.model_dir, threads=args.threads)
        query = embedder.encode(
            diff.query_chunks(diff_text(args.pytorch_git, args.rev)), "query"
        )
        scores = scoring.file_scores(query, b.embeddings, b.tests, scoring.AGGREGATION)
        scoring.to_mapping(scoring.transform(scores, scoring.TRANSFORM))
        seconds = time.monotonic() - start
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
    print(json.dumps({"seconds": seconds, "peak_rss_bytes": peak}))


def tokens(args: argparse.Namespace) -> None:
    from torchci.td.llm.models import Embedder

    spec = MODELS[args.model]
    model_dir = args.cache_dir / "models" / spec.key
    texts = json.loads(args.texts.read_text())
    count = doc_tokens(spec, model_dir, texts)
    embedder = Embedder(spec, model_dir, threads=args.threads)
    embedder.encode(texts[:BATCH_SIZE], "doc", batch_size=BATCH_SIZE)
    start = time.monotonic()
    embedder.encode(texts, "doc", batch_size=BATCH_SIZE)
    print(json.dumps({"tokens_per_second": count / (time.monotonic() - start)}))


def main(argv: Optional[list[str]] = None) -> None:
    parser = argparse.ArgumentParser(prog="torchci.td.llm.costs")
    sub = parser.add_subparsers(dest="command", required=True)
    probe_parser = sub.add_parser("probe", help="time one retrieval end to end")
    probe_parser.add_argument("--cache-dir", type=Path, required=True)
    probe_parser.add_argument("--threads", type=int, required=True)
    probe_parser.add_argument("--bundle", type=Path, required=True)
    probe_parser.add_argument("--pytorch-git", type=Path, required=True)
    probe_parser.add_argument("--rev", required=True)
    probe_parser.set_defaults(run=probe)
    tokens_parser = sub.add_parser("tokens", help="measure corpus tokens per second")
    tokens_parser.add_argument("--cache-dir", type=Path, required=True)
    tokens_parser.add_argument("--threads", type=int, required=True)
    tokens_parser.add_argument("--model", choices=sorted(MODELS), required=True)
    tokens_parser.add_argument("--texts", type=Path, required=True)
    tokens_parser.set_defaults(run=tokens)
    args = parser.parse_args(argv)
    args.run(args)


if __name__ == "__main__":
    main()
