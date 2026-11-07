"""The rankings step: TD's logged test lists for the main pushes of the landed changes
the evaluation scores."""

from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from torchci.td.analysis.labels import unix
from torchci.td.analysis.schema import load, save, write_manifest
from torchci.td.llm import events


def run(cache: Path) -> None:
    """For every landed change with a new failure (silver) or a reverted breakage (gold),
    the test lists of the configs that failed at its main push, from TD's logged main-push
    rows (the HUD Target Determinator page's shadow recall reads the same rows). The
    evaluation cuts each config's own list, as TD does per job."""
    silver, gold_df = load(cache, "labels", "silver"), load(cache, "labels", "gold")
    files: dict[str, set[str]] = {}
    when: dict[str, int] = {}
    for r in silver.itertuples():
        files.setdefault(r.push_sha, set()).add(r.file)
        when[r.push_sha] = int(r.pushed_at)
    for r in gold_df.itertuples():
        files.setdefault(r.landing_sha, set()).update(r.test_files)
        when[r.landing_sha] = unix(r.landed_at)
    evs = [
        events.E1Event(
            landing_sha=s,
            landed_at=datetime.fromtimestamp(when[s], timezone.utc).strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            stack_size=1,
            outcome="",
            test_files=sorted(f),
            test_configs=[],
        )
        for s, f in files.items()
    ]
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = events.parse_e1_rankings(events.fetch_e1_rankings(evs, now))
    out = [
        {
            "push_sha": sha,
            "workflow": r.workflow,
            "build_environment": r.build_environment,
            "test_config": r.test_config,
            "file": r.test_file,
            "candidates": sorted({events.test_file_of(k) for k in r.all_scores}),
        }
        for sha, rs in rows.items()
        for r in rs
        if r.max_score > 0
    ]
    df = pd.DataFrame(
        out,
        columns=[
            "push_sha",
            "workflow",
            "build_environment",
            "test_config",
            "file",
            "candidates",
        ],
    )
    save(cache, "rankings", "main_ranks", df)
    write_manifest(
        cache,
        "rankings",
        {"main_ranks": df},
        pushes=len(files),
        pushes_with_rows=int(df["push_sha"].nunique()),
    )
