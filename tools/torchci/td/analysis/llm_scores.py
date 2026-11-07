"""LLM step (the Qwen3 heuristic of torchci.td.llm): Qwen3-Embedding-0.6B scores per (unit, test file), with
torchci.td.llm's corpus, embedding cache and scoring, against the corpus of the month's
pytorch snapshot. Runs in the venv of td/llm's requirements (torch, sentence-transformers).

Main units use their commit's diff from the read-only clone. PR units use the diff of
their PR that td/llm's evaluation harness cached (its PR base to a head of that PR, preferring the
unit's own head); a PR without one gets no LLM score.
"""

import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from torchci.td.analysis import config, gitdata
from torchci.td.analysis.labels import unix
from torchci.td.analysis.schema import load, save, step_dir, write_atomic, write_manifest
from torchci.td.llm import cache as emb_cache, diff, pytorch_repo, scoring
from torchci.td.llm.models import DEFAULT_MODEL


logger = logging.getLogger(__name__)

CORPUS = "skeleton"
PROCS, THREADS = 10, 16


def cached_pr_diffs(llm_cache: Path) -> dict[int, dict[str, dict[str, Any]]]:
    """PR -> head sha -> {chunks, paths, seen}, from the harness's diff cache and E2 snapshot;
    `seen` is the earliest failure the harness recorded at that head (unix seconds)."""
    e2_heads: dict[str, int] = {}
    seen: dict[str, int] = {}
    for line in (llm_cache / "e2_events.jsonl").read_text().splitlines():
        e = json.loads(line)
        rev = f"{e['base_sha']}...{e['head_sha']}"
        e2_heads[rev] = int(e["pr_number"])
        seen[rev] = min(seen.get(rev, 1 << 62), unix(e["failed_at"]))
    out: dict[int, dict[str, dict[str, Any]]] = defaultdict(dict)
    for name in ("diffs.v2.jsonl", "diffs.jsonl"):
        path = llm_cache / name
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            pr = e2_heads.get(rec["rev"])
            if pr is not None and "chunks" in rec:
                out[pr].setdefault(rec["rev"].split("...")[1], {"chunks": rec["chunks"], "paths": rec.get("paths", []), "seen": seen[rec["rev"]]})
    return out


def unit_diffs(units: pd.DataFrame, repo: Path, llm_cache: Path) -> dict[str, dict[str, Any]]:
    prs = cached_pr_diffs(llm_cache)
    out = {}
    for u in units.itertuples():
        if u.kind == "main":
            text = gitdata.diff_text(repo, u.sha)
            out[u.unit_id] = {"chunks": diff.query_chunks(text), "paths": diff.changed_paths(text)}
        else:
            # The unit's own head, else the PR's latest cached head seen before the unit:
            # a later head's diff would carry the PR's future.
            heads = prs.get(int(u.pr_number), {})
            earlier = [d for d in heads.values() if d["seen"] <= int(u.time)]
            pick = heads.get(u.sha) or (max(earlier, key=lambda d: d["seen"]) if earlier else None)
            if pick:
                out[u.unit_id] = pick
    return out


def run(cache: Path, repo: Path) -> None:
    llm_cache = cache.parent / "llm_cache"
    units = load(cache, "labels", "units")
    diffs = unit_diffs(units, repo, llm_cache)
    logger.info("diffs for %d of %d units", len(diffs), len(units))
    months = sorted({datetime.fromtimestamp(int(t), timezone.utc).strftime("%Y-%m") for t in units["time"]})
    snaps = {m: pytorch_repo.snapshot(repo, cache / "corpus", m) for m in months}
    spec = emb_cache.spec_for(DEFAULT_MODEL, True)
    q_texts = sorted({c for d in diffs.values() for c in d["chunks"]})
    queries = emb_cache.embed(llm_cache, spec, "query", q_texts, True, PROCS, THREADS)
    q_row = {t: i for i, t in enumerate(q_texts)}
    d_texts = sorted({u.text for s in snaps.values() for u in s.units[CORPUS]})
    docs = emb_cache.embed(llm_cache, spec, "doc", d_texts, True, PROCS, THREADS)
    d_row = {t: i for i, t in enumerate(d_texts)}
    matrices = {
        m: (docs[[d_row[u.text] for u in s.units[CORPUS]]].astype(np.float16).astype(np.float32), [u.test for u in s.units[CORPUS]])
        for m, s in snaps.items()
    }
    rows = []
    for u in units.itertuples():
        d = diffs.get(u.unit_id)
        if not d or not d["chunks"]:
            continue
        matrix, tests = matrices[datetime.fromtimestamp(int(u.time), timezone.utc).strftime("%Y-%m")]
        q = queries[[q_row[c] for c in d["chunks"]]].reshape(-1, matrix.shape[1])
        raw = scoring.file_scores(q, matrix, tests, scoring.AGGREGATION)
        tq = scoring.transform(raw, scoring.TRANSFORM)
        for t, v in raw.items():
            rows.append((u.unit_id, t, np.float32(v), np.float32(tq.get(t, 0.0))))
    llm = pd.DataFrame(rows, columns=["unit_id", "test", "llm_raw", "llm_tq"])
    pr_paths = {u.unit_id: diffs[u.unit_id]["paths"] for u in units.itertuples() if u.kind != "main" and u.unit_id in diffs}
    write_atomic(step_dir(cache, "llm") / "pr_paths.json", json.dumps(pr_paths))
    save(cache, "llm", "scores", llm)
    write_manifest(cache, "llm", {"scores": llm}, units_with_diff=len(diffs), model=DEFAULT_MODEL, corpus=CORPUS)
