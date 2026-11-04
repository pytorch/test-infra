"""Score pytorch test files against a PR's diff with the model and index of a bundle.

Writes the mapping pytorch's TD heuristic `llm.py` reads: `{"<test>.py": score}`.
Usage: python -P -m torchci.td.llm.retrieve --pytorch <checkout> --bundle <bundle.tar>
    --out <dir>/mappings/indexer-files-gitdiff-output.json
"""

import argparse
import datetime
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

from torchci.td.llm import bundle, diff, models, scoring


logger = logging.getLogger(__name__)

TOP_FILES_LOGGED = 10
MAX_BUNDLE_AGE_DAYS = 3
STALE_BUNDLE_WARNING = (
    "::warning title=LLM TD::the LLM TD bundle is more than"
    f" {MAX_BUNDLE_AGE_DAYS} days old"
)


def _given(value: str) -> Optional[str]:
    return value or None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pytorch", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    # The workflow passes event fields that are empty outside pull_request events.
    parser.add_argument("--pr-number", type=_given)
    parser.add_argument("--base-ref", type=_given)
    parser.add_argument("--base-sha", type=_given)
    parser.add_argument("--github-ref", type=_given)
    parser.add_argument("--threads", type=int)
    parser.add_argument("--work-dir", type=Path)
    return parser


def write_mapping(path: Path, mapping: dict[str, float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with bundle.atomic_file(path, "w") as f:
        json.dump(mapping, f, sort_keys=True, allow_nan=False)


def bundle_is_stale(meta: dict[str, Any], now: datetime.datetime) -> bool:
    try:
        created = datetime.datetime.fromisoformat(meta["created_at"])
    except (KeyError, TypeError, ValueError):
        # An undated bundle cannot be shown to be fresh.
        return True
    if created.tzinfo is None:
        created = created.replace(tzinfo=datetime.timezone.utc)
    return now - created > datetime.timedelta(days=MAX_BUNDLE_AGE_DAYS)


def retrieve(args: argparse.Namespace, work_dir: Path) -> None:
    timings: dict[str, float] = {}
    start = time.monotonic()
    index = bundle.read(args.bundle, work_dir / "bundle")
    timings["bundle"] = time.monotonic() - start
    if bundle_is_stale(index.meta, datetime.datetime.now(datetime.timezone.utc)):
        print(STALE_BUNDLE_WARNING)

    start = time.monotonic()
    pr_number = diff.pr_number_from(args.pr_number, args.github_ref)
    base = diff.resolve_base(
        args.pytorch,
        pr_number,
        args.base_ref,
        args.base_sha,
        os.environ.get("GITHUB_TOKEN") or None,
    )
    diff_text = diff.git_diff(args.pytorch, base)
    chunks = diff.query_chunks(diff_text)
    timings["diff"] = time.monotonic() - start
    changed_files = len(diff.changed_paths(diff_text))
    print(
        f"PR {pr_number}, base {base}: {changed_files} changed paths, "
        f"{len(chunks)} query chunks"
    )
    if not chunks:
        write_mapping(args.out, {})
        print(f"No query chunks: wrote an empty mapping to {args.out}")
        return

    start = time.monotonic()
    embedder = models.Embedder(index.spec, index.model_dir, threads=args.threads)
    if embedder.dim != index.embeddings.shape[1]:
        raise bundle.BundleError(
            f"embeddings have dimension {index.embeddings.shape[1]},"
            f" the model {embedder.dim}"
        )
    timings["model load"] = time.monotonic() - start
    start = time.monotonic()
    query = embedder.encode(chunks, "query")
    timings["encode"] = time.monotonic() - start

    start = time.monotonic()
    scores = scoring.file_scores(
        query, index.embeddings, index.tests, scoring.AGGREGATION
    )
    mapping = scoring.to_mapping(scoring.transform(scores, scoring.TRANSFORM))
    timings["score"] = time.monotonic() - start
    write_mapping(args.out, mapping)

    print(f"Wrote {len(mapping)} test files to {args.out}")
    best = sorted(mapping.items(), key=lambda item: (-item[1], item[0]))
    for name, score in best[:TOP_FILES_LOGGED]:
        print(f"  {score:.4f}  {name}")
    print("Timings: " + ", ".join(f"{k} {v:.1f}s" for k, v in timings.items()))


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        if args.work_dir is not None:
            args.work_dir.mkdir(parents=True, exist_ok=True)
            retrieve(args, args.work_dir)
        else:
            with tempfile.TemporaryDirectory(prefix="td-llm-") as tmp:
                retrieve(args, Path(tmp))
    except bundle.BundleError as e:
        print(f"LLM TD retrieval: unusable bundle: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        logger.error("LLM TD retrieval failed: %s", e, exc_info=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
