"""Embed pytorch's test corpus and write the bundle the retriever reads.

Usage: python -P -m torchci.td.llm.index --pytorch <checkout> --out <bundle.tar>
"""

import argparse
import logging
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

from torchci.td.llm import bundle, corpus, diff, models


logger = logging.getLogger(__name__)

# Well below the glob's normal count, so only a broken or partial checkout or a moved
# test directory trips it: such a shrunken corpus must never replace a good bundle.
MIN_TEST_FILES = 1000
CORPUS_WITH_FUNCTIONS = False


class RefusedError(Exception):
    pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pytorch", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--model", choices=sorted(models.MODELS), default=models.DEFAULT_MODEL
    )
    parser.add_argument("--threads", type=int)
    parser.add_argument("--work-dir", type=Path)
    return parser


def build_index(args: argparse.Namespace, work_dir: Path) -> None:
    spec = models.MODELS[args.model]
    models.require_files(spec)

    start = time.monotonic()
    units = corpus.build(args.pytorch / "test", with_functions=CORPUS_WITH_FUNCTIONS)
    tests = [unit.test for unit in units]
    n_files = len(set(tests))
    logger.info(
        "Corpus: %d units from %d test files in %.1fs",
        len(units),
        n_files,
        time.monotonic() - start,
    )
    if n_files < MIN_TEST_FILES:
        raise RefusedError(
            f"only {n_files} test files under {args.pytorch / 'test'},"
            f" fewer than {MIN_TEST_FILES}"
        )
    commit = diff.git(args.pytorch, "rev-parse", "--verify", "HEAD").stdout.strip()

    start = time.monotonic()
    model_dir = models.download(spec, work_dir / "model")
    logger.info("Model %s ready in %.1fs", spec.key, time.monotonic() - start)

    texts = [unit.text for unit in units]
    start = time.monotonic()
    embedder = models.Embedder(spec, model_dir, threads=args.threads)
    embeddings = embedder.encode(texts, "doc")
    logger.info(
        "Embedded %d units (dim %d) in %.1fs",
        len(texts),
        embedder.dim,
        time.monotonic() - start,
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    staged = args.out.with_name(f".{args.out.name}.unchecked")
    try:
        bundle.write(staged, embeddings, tests, spec, model_dir, commit)
        start = time.monotonic()
        with tempfile.TemporaryDirectory(dir=work_dir, prefix="readback-") as tmp:
            bundle.read(staged, Path(tmp))
        logger.info("Read the bundle back in %.1fs", time.monotonic() - start)
        os.replace(staged, args.out)
    finally:
        staged.unlink(missing_ok=True)
    logger.info(
        "Wrote %s (%d bytes) for pytorch %s", args.out, args.out.stat().st_size, commit
    )


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO)
    try:
        if args.work_dir is not None:
            args.work_dir.mkdir(parents=True, exist_ok=True)
            build_index(args, args.work_dir)
        else:
            with tempfile.TemporaryDirectory(prefix="td-llm-index-") as tmp:
                build_index(args, Path(tmp))
    except RefusedError as e:
        print(f"Refusing to index: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        logger.error("LLM TD indexing failed: %s", e, exc_info=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
