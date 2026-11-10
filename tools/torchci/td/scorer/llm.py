"""The LLM heuristic's score of each training unit, as pytorch's TD job serves it.

The diff of a unit goes through the retriever's own steps (`torchci.td.llm.retrieve`):
query chunks, the published bundle's model and corpus, file scores, the output transform
and the `<test>.py` mapping. The mapping then goes through what pytorch's
`tools/testing/target_determination/heuristics/llm.py` does with it: keys kept in the
test list, averaged per file, scaled so the largest score is 0.25 (`replay.llm_part`).
The test list is the one TD ranked for the unit (`context.unit_tests`: the month's whole
list plus a PR job's own tests), as the TD job scores all of TESTS.
"""

import json
import logging
import os
import subprocess
import time
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

import numpy as np
from torchci.td.labels.schema import MAIN, PR_TD_OFF
from torchci.td.llm import bundle, cache, diff, pytorch_repo, replay, scoring


logger = logging.getLogger(__name__)

BUNDLE_URL = (
    "https://target-determinator-assets.s3.amazonaws.com/indexes/latest/bundle.tar"
)
BUNDLE_FILE = "bundle.tar"
DOWNLOAD_TIMEOUT_SECONDS = 60
DOWNLOAD_BLOCK = 1024 * 1024
MAX_BUNDLE_BYTES = 16 * 1024**3
UNIT_BATCH = 500

Unit = Mapping[str, Any]


def _rev(unit: Unit, bases: Mapping[str, str]) -> Optional[str]:
    """The pytorch_repo.diff_text revision of a unit's change, None when there is none."""
    sha = unit.get("sha")
    if not isinstance(sha, str) or not diff.SHA_RE.match(sha):
        return None
    if unit["kind"] == MAIN:
        return f"{sha}^..{sha}"
    base = bases.get(unit["unit_id"])
    if unit["kind"] == PR_TD_OFF and isinstance(base, str) and diff.SHA_RE.match(base):
        return f"{base}..{sha}"
    return None


def unit_diffs(
    units: Iterable[Unit], repo: Path, bases: Mapping[str, str]
) -> dict[str, str]:
    """Unit id -> the retriever's diff of the unit's change, read from the clone.

    Main units: the commit against its parent. PR units: the head against
    `bases[unit_id]`, its merge base with the PR's base ref (`context.pr_bases`); a PR
    unit without one is left out, as are explored units. The caller fetches absent
    commits first. A diff git cannot produce is left out (counted and logged).
    """
    diffs: dict[str, str] = {}
    total = without = failed = 0
    for unit in units:
        total += 1
        rev = _rev(unit, bases)
        if rev is None:
            without += 1
            continue
        try:
            diffs[unit["unit_id"]] = pytorch_repo.diff_text(repo, rev)
        except (subprocess.SubprocessError, KeyError, diff.DiffError) as e:
            failed += 1
            logger.debug("no diff for %s (%s): %s", unit["unit_id"], rev, e)
    logger.info(
        "diffs for %d of %d units (%d without a revision, %d unreadable)",
        len(diffs),
        total,
        without,
        failed,
    )
    return diffs


class _QueryCache:
    """Query embeddings in td/llm's text-keyed cache, under the bundle model's group,
    so a later run embeds only texts no shard holds. Texts missing from the cache are
    embedded one unit at a time, one encode call per unit, as the retriever does."""

    def __init__(
        self, cache_dir: Path, index: bundle.Bundle, make_embedder: Callable[[], Any]
    ) -> None:
        self._dir = cache.group_dir(cache_dir, index.spec, "query")
        self._dim = int(index.embeddings.shape[1])
        self._make_embedder = make_embedder
        self._embedder: Any = None
        self._where: dict[str, tuple[Path, int, int]] = {}
        self._pending: dict[str, np.ndarray] = {}
        self.embedded = 0
        self.encode_seconds = 0.0
        for keys_file in sorted(self._dir.glob(f"*{cache.KEYS_SUFFIX}")):
            self._index_shard(keys_file)

    def _index_shard(self, keys_file: Path) -> None:
        npy = keys_file.with_name(keys_file.name[: -len(cache.KEYS_SUFFIX)] + ".npy")
        keys = json.loads(keys_file.read_text())
        for row, key in enumerate(keys):
            self._where[key] = (npy, row, len(keys))

    def rows(self, chunk_lists: Sequence[Sequence[str]]) -> dict[str, np.ndarray]:
        """Text sha256 -> embedding, for every chunk of the given units."""
        rows: dict[str, np.ndarray] = {}
        by_shard: dict[tuple[Path, int], list[tuple[str, int]]] = defaultdict(list)
        for chunks in chunk_lists:
            for key in map(cache.text_key, chunks):
                if key in self._pending:
                    rows[key] = self._pending[key]
                elif key in self._where and key not in rows:
                    npy, row, n = self._where[key]
                    by_shard[(npy, n)].append((key, row))
        for (npy, n), wanted in by_shard.items():
            shard = bundle.load_npy_checked(npy, cache.DTYPE, rows=n, dim=self._dim)
            rows.update((key, shard[row].copy()) for key, row in wanted)
        for chunks in chunk_lists:
            missing = list(
                dict.fromkeys(c for c in chunks if cache.text_key(c) not in rows)
            )
            if missing:
                self._encode(missing, rows)
        return rows

    def _encode(self, texts: list[str], rows: dict[str, np.ndarray]) -> None:
        if self._embedder is None:
            self._embedder = self._make_embedder()
            if self._embedder.dim != self._dim:
                raise bundle.BundleError(
                    f"embeddings have dimension {self._dim},"
                    f" the model {self._embedder.dim}"
                )
        start = time.monotonic()
        matrix = self._embedder.encode(texts, "query")
        self.encode_seconds += time.monotonic() - start
        self.embedded += len(texts)
        for text, row in zip(texts, matrix):
            key = cache.text_key(text)
            rows[key] = self._pending[key] = row
        if len(self._pending) >= cache.SHARD_TEXTS:
            self.flush()

    def flush(self) -> None:
        if not self._pending:
            return
        keys = list(self._pending)
        name = f"{os.getpid()}-{time.time_ns()}"
        cache.write_shard(self._dir, name, keys, np.stack(list(self._pending.values())))
        self._index_shard(self._dir / f"{name}{cache.KEYS_SUFFIX}")
        self._pending.clear()


def scores(
    units: Sequence[Unit],
    diffs: Mapping[str, str],
    month_tests_of: Callable[[Unit], Iterable[str]],
    bundle_path: Path,
    threads: Optional[int],
    cache_dir: Path,
    work_dir: Path,
) -> dict[str, dict[str, float]]:
    """Unit id -> {test: llm_n} for the tests of `month_tests_of(unit)` that llm.py
    scores above 0.0; any other test is 0.0. `month_tests_of` returns the tests TD
    ranked for the unit, `context.unit_tests(unit, months)`. A unit without query
    chunks maps to {}; a unit without a diff is left out."""
    from torchci.td.llm import models

    index = bundle.read(bundle_path, work_dir / "bundle")
    out: dict[str, dict[str, float]] = {}
    with cache.exclusive(cache_dir):
        queries = _QueryCache(
            cache_dir,
            index,
            lambda: models.Embedder(index.spec, index.model_dir, threads=threads),
        )
        todo = [u for u in units if u["unit_id"] in diffs]
        for i in range(0, len(todo), UNIT_BATCH):
            batch = todo[i : i + UNIT_BATCH]
            chunks = [diff.query_chunks(diffs[u["unit_id"]]) for u in batch]
            rows = queries.rows(chunks)
            for unit, unit_chunks in zip(batch, chunks):
                if not unit_chunks:
                    out[unit["unit_id"]] = {}
                    continue
                query = np.stack([rows[cache.text_key(c)] for c in unit_chunks])
                raw = scoring.file_scores(
                    query, index.embeddings, index.tests, scoring.AGGREGATION
                )
                mapping = scoring.to_mapping(scoring.transform(raw, scoring.TRANSFORM))
                out[unit["unit_id"]] = replay.llm_part(
                    mapping, set(month_tests_of(unit))
                )
            queries.flush()
            logger.info(
                "LLM scores for %d of %d units; %d texts embedded in %.0f s",
                min(i + UNIT_BATCH, len(todo)),
                len(todo),
                queries.embedded,
                queries.encode_seconds,
            )
    return out


def download_bundle(dest: Path) -> Path:
    """Download the published bundle anonymously into the directory dest, check its
    member hashes with bundle.verify, and return its path."""
    cache.ensure_dir(dest)
    path = Path(dest) / BUNDLE_FILE
    size = 0
    with urllib.request.urlopen(
        BUNDLE_URL, timeout=DOWNLOAD_TIMEOUT_SECONDS
    ) as response, bundle.atomic_file(path) as f:
        while block := response.read(DOWNLOAD_BLOCK):
            size += len(block)
            if size > MAX_BUNDLE_BYTES:
                raise bundle.BundleError(
                    f"{BUNDLE_URL} is over {MAX_BUNDLE_BYTES} bytes"
                )
            f.write(block)
    meta = bundle.verify(path)
    logger.info(
        "bundle of %s: %d bytes, model %s, %s rows",
        meta.get("created_at"),
        size,
        meta.get("model_key"),
        meta.get("rows"),
    )
    return path
