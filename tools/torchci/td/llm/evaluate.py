"""Evaluation harness: `fetch` snapshots the events from HUD ClickHouse; `run` scores
configurations on that snapshot alone and writes the report. See README.md."""

import argparse
import dataclasses
import json
import logging
import random
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np
from torchci.td.llm import (
    cache,
    corpus,
    costs,
    events,
    metrics,
    pytorch_repo,
    replay,
    report,
    report_render,
    scoring,
)
from torchci.td.llm.bundle import atomic_file
from torchci.td.llm.models import MODELS


logger = logging.getLogger(__name__)

COST_DIFFS = 10
COST_THREADS = 16
SCORE_CACHE = 64
Scores = Callable[[str, str, str], dict[str, float]]


def month_of(timestamp: str) -> str:
    return timestamp[:7]


def e1_base(e: events.E1Event) -> str:
    return f"{e.landing_sha}~{e.stack_size}"


def e1_diffs(e: events.E1Event) -> tuple[str, str]:
    """Standalone (`landing~stack_size..landing`) and replay (`landing^..landing`)."""
    return f"{e1_base(e)}..{e.landing_sha}", f"{e.landing_sha}^..{e.landing_sha}"


def e2_diff(e: events.E2Event) -> str:
    return f"{e.base_sha}...{e.head_sha}"


def e2_id(e: events.E2Event) -> str:
    return f"{e.pr_number}:{e.test_file}"


def def_counts(units: list[corpus.Unit]) -> dict[str, float]:
    """The size-only baseline's scores: each file's number of `test*` defs."""
    counts: dict[str, float] = {}
    for u in units:
        counts[u.test] = counts.get(u.test, 0.0) + (u.kind == "function")
    return counts


@dataclass
class Prepared:
    e1: list[events.E1Event]
    e2: list[events.E2Event]
    diffs: dict[str, dict[str, Any]]
    meta: dict[str, Any]
    data: dict[str, Any]


def prepare(args: argparse.Namespace, snap: events.Snapshot) -> Prepared:
    """The events whose commits and diffs are available, their metadata and counts."""
    repo, cutoff = args.pytorch_git, replay.NO_LLM_PART_BEFORE
    e2 = snap.e2
    if args.sample_prs:
        prs = sorted({e.pr_number for e in e2})
        rng = random.Random(args.seed)
        keep = set(rng.sample(prs, min(args.sample_prs, len(prs))))
        e2 = [e for e in e2 if e.pr_number in keep]
    shas = {e.landing_sha for e in snap.e1}
    shas |= {s for e in e2 for s in (e.head_sha, e.base_sha) if s}
    absent, fetched = pytorch_repo.fetch_missing(repo, shas)
    bases = pytorch_repo.present(repo, [e1_base(e) for e in snap.e1])
    logged_rows = {e.landing_sha: len(e.rows) for e in snap.e1}
    e1 = [replayable(e, snap.meta) for e in snap.e1 if e1_base(e) in bases]
    e2 = [e for e in e2 if e.base_sha and not {e.base_sha, e.head_sha} & absent]
    revs = {r for e in e1 for r in e1_diffs(e)} | {e2_diff(e) for e in e2}
    diffs = pytorch_repo.load_diffs(repo, args.cache_dir, revs)
    e1 = [e for e in e1 if all(r in diffs for r in e1_diffs(e))]
    e2 = sorted(
        (e for e in e2 if e2_diff(e) in diffs), key=lambda e: (e2_diff(e), e2_id(e))
    )
    edited = {
        e2_id(e): f"test/{e.test_file}.py" in diffs[e2_diff(e)]["paths"] for e in e2
    }
    meta = {
        "e1": {
            e.landing_sha: {"date": e.landed_at[:10], "stack_size": e.stack_size}
            for e in e1
        },
        "e2": {
            e2_id(e): {
                "date": e.failed_at[:10],
                "pr": e.pr_number,
                "edited": edited[e2_id(e)],
                "td_cut": replay.cut_applied(e.row),
            }
            for e in e2
        },
    }
    data = {
        **{f"snapshot {k}": v for k, v in snap.meta.items()},
        "commits fetched into the clone": fetched,
        "commits not available": len(absent),
        "E1 events evaluated": len(e1),
        "E1 events with logged rankings": sum(1 for e in e1 if e.rows),
        "E1 events skipped (commit or diff unavailable)": len(snap.e1) - len(e1),
        "E2 events evaluated": len(e2),
        "E2 PRs evaluated": len({e.pr_number for e in e2}),
        "E2 events skipped (sample, base, commits or diff)": len(snap.e2) - len(e2),
        "E2 events whose PR edits the failing file": sum(edited.values()),
        "E2 events from jobs without TD's cut (every test ran)": sum(
            not m["td_cut"] for m in meta["e2"].values()
        ),
        "PR sample": f"{args.sample_prs} PRs, seed {args.seed}"
        if args.sample_prs
        else "all",
        f"E1 ranking rows left out of the replay (logged from {cutoff})": sum(
            logged_rows[e.landing_sha] - len(e.rows) for e in e1
        ),
        f"E2 events left out of the replay (logged from {cutoff})": sum(
            e.failed_at[:10] >= cutoff for e in e2
        ),
    }
    for (source, base), count in sorted(_by_source(snap.e2).items()):
        data[f"E2 events in the snapshot from {source} runs, base from {base}"] = count
    return Prepared(e1, e2, diffs, meta, data)


def replayable(e: events.E1Event, meta: dict[str, Any]) -> events.E1Event:
    """The event with only the ranking rows logged before replay.NO_LLM_PART_BEFORE. A row
    with no time of its own was logged before the snapshot was fetched."""
    fetched = meta.get("fetched_at", "")
    days = [(r.logged_at or fetched)[:10] for r in e.rows]
    rows = [r for r, d in zip(e.rows, days) if d and d < replay.NO_LLM_PART_BEFORE]
    return dataclasses.replace(e, rows=rows)


def _by_source(e2: list[events.E2Event]) -> dict[tuple[str, str], int]:
    counts: dict[tuple[str, str], int] = {}
    for e in e2:
        key = (e.pr_source, e.base_source or "nowhere (skipped)")
        counts[key] = counts.get(key, 0) + 1
    return counts


def config_results(
    prep: Prepared,
    snaps: dict[str, pytorch_repo.CorpusSnapshot],
    times: replay.FileTimes,
    unit_scores: Scores,
    agg: str,
    transforms: tuple[str, ...],
) -> dict[str, Any]:
    """Per-event standalone percentiles (among the snapshot's TESTS), and replays of the
    rankings logged before replay.NO_LLM_PART_BEFORE (E1 rows were filtered in prepare)."""
    out: dict[str, Any] = {"e1": {}, "e2": {}, "missing": 0}
    out["replay"] = {t: {"e1": [], "e2": []} for t in transforms}

    @lru_cache(maxsize=SCORE_CACHE)
    def part(rev: str, month: str, t: str) -> dict[str, float]:
        mapping = scoring.to_mapping(scoring.transform(unit_scores(rev, month, agg), t))
        return replay.llm_part(mapping, snaps[month].tests)

    for e in prep.e1:
        month, (standalone, replayed) = month_of(e.landed_at), e1_diffs(e)
        tests = snaps[month].tests
        scores = unit_scores(standalone, month, agg)
        out["e1"][e.landing_sha] = metrics.best_rank_pct(scores, e.test_files, tests)
        out["missing"] += sum(f not in tests for f in e.test_files)
        if not e.rows:
            continue
        for t in transforms:
            event = replay.replay_event(
                e.landing_sha, e.rows, part(replayed, month, t), times
            )
            out["replay"][t]["e1"].append(event.to_json())
    for e in prep.e2:
        month, rev, key = month_of(e.failed_at), e2_diff(e), e2_id(e)
        tests = snaps[month].tests
        out["e2"][key] = metrics.rank_pct(
            unit_scores(rev, month, agg), e.test_file, tests
        )
        out["missing"] += e.test_file not in tests
        if e.failed_at[:10] >= replay.NO_LLM_PART_BEFORE:
            continue
        for t in transforms:
            event = replay.replay_event(key, [e.row], part(rev, month, t), times)
            out["replay"][t]["e2"].append(event.to_json())
    return out


def save(path: Path, data: Any) -> None:
    with atomic_file(path, "w") as f:
        json.dump(data, f, sort_keys=True)


def corpus_name(args: argparse.Namespace) -> str:
    return report.CORPUS_NAMES[1] if args.with_functions else report.CORPUS_NAMES[0]


def score_model(
    args: argparse.Namespace,
    prep: Prepared,
    snaps: dict[str, pytorch_repo.CorpusSnapshot],
    times: replay.FileTimes,
    model: str,
    out_dir: Path,
) -> None:
    instruction, name = not args.no_instruction, corpus_name(args)
    spec = cache.spec_for(model, instruction)
    workers = (args.procs, args.threads)
    revs = sorted(
        {r for e in prep.e1 for r in e1_diffs(e)} | {e2_diff(e) for e in prep.e2}
    )
    q_texts = sorted({c for r in revs for c in prep.diffs[r]["chunks"]})
    queries = cache.embed(args.cache_dir, spec, "query", q_texts, instruction, *workers)
    q_row = {t: i for i, t in enumerate(q_texts)}
    d_texts = sorted({u.text for s in snaps.values() for u in s.units[name]})
    docs = cache.embed(args.cache_dir, spec, "doc", d_texts, instruction, *workers)
    d_row = {t: i for i, t in enumerate(d_texts)}
    units = {}
    for month, snap in snaps.items():
        rows = docs[[d_row[u.text] for u in snap.units[name]]]
        # Bundles store float16 embeddings, so the harness scores what the retriever loads.
        units[month] = (
            rows.astype(np.float16).astype(np.float32),
            [u.test for u in snap.units[name]],
        )

    @lru_cache(maxsize=SCORE_CACHE)
    def unit_scores(rev: str, month: str, agg: str) -> dict[str, float]:
        matrix, tests = units[month]
        q = (
            queries[[q_row[c] for c in prep.diffs[rev]["chunks"]]]
            if q_texts
            else queries
        )
        return scoring.file_scores(q.reshape(-1, matrix.shape[1]), matrix, tests, agg)

    for agg in scoring.AGGREGATIONS:
        cid = report.config_id(model, name, agg, instruction)
        result = config_results(
            prep, snaps, times, unit_scores, agg, scoring.TRANSFORMS
        )
        save(
            out_dir / "configs" / f"{cid.replace('/', '__')}.json",
            {"id": cid, **result},
        )
        logger.info("scored %s", cid)
    cost_file = cache.ensure_dir(args.cache_dir / "costs") / f"{model}__{name}.json"
    if not cost_file.exists():
        latest = snaps[max(snaps)]
        embeddings = docs[[d_row[u.text] for u in latest.units[name]]]
        population = sorted({e2_diff(e) for e in prep.e2})
        sample = random.Random(args.seed).sample(
            population, min(COST_DIFFS, len(population))
        )
        cost = costs.measure(
            args.cache_dir,
            MODELS[model],
            embeddings,
            latest.units[name],
            latest.commit,
            args.pytorch_git,
            sample,
            COST_THREADS,
        )
        save(cost_file, {**cost, "model": model, "corpus": name})


def write_report(args: argparse.Namespace, out_dir: Path) -> None:
    results = {}
    for path in sorted((out_dir / "configs").glob("*.json")):
        result = json.loads(path.read_text())
        results[result["id"]] = result
    all_costs: dict[str, dict[str, Any]] = {}
    for path in sorted((args.cache_dir / "costs").glob("*.json")):
        cost = json.loads(path.read_text())
        all_costs.setdefault(cost["corpus"], {})[cost["model"]] = cost
    meta = json.loads((out_dir / "events.json").read_text())
    data = json.loads((out_dir / "data.json").read_text())
    markdown, out = report_render.build(
        results, meta, all_costs, data, bool(args.sample_prs)
    )
    args.out.write_text(markdown)
    args.out.with_suffix(".json").write_text(json.dumps(out, indent=2, sort_keys=True))
    logger.info("wrote %s: %s", args.out, out["picked"])


def run(args: argparse.Namespace) -> None:
    if not (args.cache_dir / events.META_FILE).exists():
        raise SystemExit(f"no event snapshot in {args.cache_dir}: run `fetch` first")
    with cache.exclusive(args.cache_dir):
        snap = events.load(args.cache_dir)
        prep = prepare(args, snap)
        logger.info(
            "%d E1 and %d E2 events, %d diffs",
            len(prep.e1),
            len(prep.e2),
            len(prep.diffs),
        )
        months = {month_of(e.landed_at) for e in prep.e1}
        months |= {month_of(e.failed_at) for e in prep.e2}
        snaps = {
            m: pytorch_repo.snapshot(args.pytorch_git, args.cache_dir, m)
            for m in sorted(months)
        }
        times = replay.FileTimes(snap.test_times)
        tag = f"sample-{args.sample_prs}-seed-{args.seed}" if args.sample_prs else "all"
        out_dir = cache.ensure_dir(args.cache_dir / "results" / tag)
        cache.ensure_dir(out_dir / "configs")
        snapshots = {f"corpus snapshot {m}": s.commit for m, s in snaps.items()}
        save(out_dir / "events.json", prep.meta)
        save(out_dir / "data.json", {**prep.data, **snapshots})
        counts = {
            m: def_counts(s.units[report.CORPUS_NAMES[1]]) for m, s in snaps.items()
        }

        def size_only(rev: str, month: str, agg: str) -> dict[str, float]:
            return counts[month]

        result = config_results(
            prep, snaps, times, size_only, scoring.AGGREGATIONS[0], ()
        )
        save(
            out_dir / "configs" / f"{report.SIZE_ONLY}.json",
            {"id": report.SIZE_ONLY, **result},
        )
        for model in args.models:
            score_model(args, prep, snaps, times, model, out_dir)
        write_report(args, out_dir)


def fetch(args: argparse.Namespace) -> None:
    with cache.exclusive(args.cache_dir):
        meta = events.fetch(args.start, args.stop, args.cache_dir)
    print(json.dumps(meta, indent=2))


def day(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d")


def model_keys(value: str) -> list[str]:
    keys = [k for k in value.split(",") if k]
    unknown = sorted(set(keys) - set(MODELS))
    if unknown or not keys:
        raise argparse.ArgumentTypeError(
            f"unknown models {unknown}; known: {sorted(MODELS)}"
        )
    return keys


def main(argv: Optional[list[str]] = None) -> None:
    parser = argparse.ArgumentParser(prog="torchci.td.llm.evaluate")
    sub = parser.add_subparsers(dest="command", required=True)
    f = sub.add_parser(
        "fetch", help="snapshot the events (needs HUD ClickHouse access)"
    )
    f.add_argument("--start", type=day, required=True)
    f.add_argument("--stop", type=day, required=True)
    f.add_argument("--cache-dir", type=Path, required=True)
    r = sub.add_parser(
        "run", help="score configurations on the snapshot, write the report"
    )
    r.add_argument("--pytorch-git", type=Path, required=True)
    r.add_argument("--cache-dir", type=Path, required=True)
    r.add_argument("--models", type=model_keys, required=True)
    r.add_argument("--out", type=Path, required=True)
    r.add_argument("--procs", type=int, default=2)
    r.add_argument("--threads", type=int, default=16)
    r.add_argument("--sample-prs", type=int, default=0)
    r.add_argument("--seed", type=int, default=0)
    r.add_argument("--with-functions", action="store_true")
    r.add_argument("--no-instruction", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    (fetch if args.command == "fetch" else run)(args)


if __name__ == "__main__":
    main()
