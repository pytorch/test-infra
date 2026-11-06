"""The harness report: Markdown for people and JSON for tools, with no hosts or paths."""

import json
import math
from dataclasses import asdict
from typing import Any, Mapping

from torchci.td.llm.metrics import (
    CONFIRMATION_FIRST_DAY,
    GEMMA2_RELEASE_DAY,
    SELECTION_LAST_DAY,
    SLICES,
)
from torchci.td.llm.replay import NO_LLM_PART_BEFORE, ReplaySummary
from torchci.td.llm.report import (
    build_minutes,
    decide,
    gates,
    job_seconds,
    Metrics,
    metrics_for,
)


PILOT_LAST_DAY = "2026-11-04"
NOTES = [
    "The configuration is picked on the selection slice (events up to "
    f"{SELECTION_LAST_DAY}) and checked on the confirmation slice (events from "
    f"{CONFIRMATION_FIRST_DAY}). A pilot looked at events through {PILOT_LAST_DAY}, so "
    "the confirmation slice is not fully held out.",
    "The pilot measured today's setup (CodeLlama-7B, 128-token file and diff heads) once, "
    "as what fixing the upload alone would give: 17 of 44 breakages caught at 25% and an "
    "E2 per-PR recall of 0.39 (0.38 on files the PR does not edit), against 41 and 0.79 for "
    "Qwen3-Embedding-0.6B. Its E2 set differs from this report's, so it is not rerun.",
    "The TD baseline's shadow recall (20 of 38, pytorch/test-infra#9323) counts new trunk "
    "failures per landing from its own event query; the logged replay line here counts "
    "reverted landings from td_trunk_breakages with logged main-push rankings, so the two "
    "differ by event set, not by ranking.",
    f"EmbeddingGemma-2 was published on {GEMMA2_RELEASE_DAY}, so its training data may "
    "overlap earlier events; the post_gemma2 slice holds the events after it.",
    "The replay adds the new LLM part to TD's logged scores and subtracts nothing, which "
    f"holds for rankings logged before {NO_LLM_PART_BEFORE}, when no LLM part reached TD; "
    "later events are left out of the replay.",
    "The replay is information only: it shows what the LLM part does inside TD's current "
    "fixed-weight sum, and picks nothing. Where TD cut a job's tests, a test outside the "
    "cut never ran, so those E2 failures lie mostly inside the logged cut and the replay "
    "can show losses but hardly any gains. The E2 TD-off columns count the failures whose "
    "first failing job had no cut (macOS, XPU and ONNX jobs), where every test ran. They "
    "are still biased against the cut: inside-cut failures usually fail first on a TD-on "
    "job and count there. Jobs with TD off for other reasons (a ci-no-td label, "
    "force-no-td, tests-to-include) count as cut.",
]
STANDALONE_COLUMNS = (
    "config|E1 caught|E1 single-commit|E2 PR recall@25%|not edited (primary)"
    "|mean rank pct|failing files outside TESTS (whole run)"
)
REPLAY_COLUMNS = (
    "config|transform|E1 logged|E1 replayed|gained/lost|McNemar p"
    "|E1 single-commit logged/replayed|E2 kept|E2 TD-off logged/replayed (events)"
    "|E2 TD-off gained/lost|E1 time growth|E2 time growth|dropped rows"
)
COST_COLUMNS = (
    "model|parameters|bundle GB|peak RSS GB|per-PR s (p50)|est. job s|corpus tokens/s"
    "|est. build min|outside gates"
)


def _fmt(value: Any) -> str:
    if isinstance(value, float):
        return "n/a" if math.isnan(value) else f"{value:.3f}"
    return str(value)


def _table(columns: str, rows: list[list[Any]]) -> list[str]:
    headers = columns.split("|")
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    return out + ["| " + " | ".join(_fmt(v) for v in r) + " |" for r in rows]


def _standalone_row(config: str, r: dict[str, Any], missing: int) -> list[Any]:
    return [
        config,
        f"{r['e1_caught']}/{r['e1_events']}",
        f"{r['e1_single_caught']}/{r['e1_single_events']}",
        f"{_fmt(r['e2_recall'])} ({r['e2_prs']} PRs)",
        f"{_fmt(r['primary'])} ({r['primary_prs']} PRs)",
        r["e2_rank"],
        missing,
    ]


def _replay_rows(config: str, m: Metrics) -> list[list[Any]]:
    rows = []
    for t, (e1, e2) in sorted(m.replay.items()):
        single: ReplaySummary = m.replay_single[t]
        off: ReplaySummary = m.replay_td_off[t]
        rows.append(
            [
                config,
                t,
                f"{e1.logged_caught}/{e1.events}",
                e1.replayed_caught,
                f"{e1.gained}/{e1.lost}",
                e1.mcnemar_p,
                f"{single.logged_caught}/{single.replayed_caught} ({single.events})",
                e2.kept_rate,
                f"{off.logged_caught}/{off.replayed_caught} ({off.events})",
                f"{off.gained}/{off.lost}",
                e1.median_time_change,
                e2.median_time_change,
                e1.dropped_rows + e2.dropped_rows,
            ]
        )
    return rows


def _cost_row(name: str, c: Mapping[str, Any]) -> list[Any]:
    outside = ", ".join(k for k, ok in gates(c).items() if not ok) or "none"
    return [
        name,
        c["parameters"],
        c["bundle_bytes"] / 1e9,
        c["peak_rss_bytes"] / 1e9,
        c["per_pr_seconds"],
        job_seconds(c),
        c["tokens_per_second"],
        build_minutes(c),
        outside,
    ]


def build(
    results: Mapping[str, Mapping[str, Any]],
    events: Mapping[str, Any],
    costs: Mapping[str, Mapping[str, Mapping[str, Any]]],
    data: Mapping[str, Any],
    sampled: bool = False,
) -> tuple[str, dict[str, Any]]:
    """`results`: config id -> stored results; `costs`: corpus -> model -> cost;
    `data`: snapshot and run counts."""
    by_slice = {
        s: {i: metrics_for(r, events, s) for i, r in results.items()} for s in SLICES
    }
    d = decide(by_slice["selection"], by_slice["confirmation"], costs)
    widths = ", ".join(
        f"{c.candidate} vs {c.incumbent} {c.interval.width:.3f} ({c.interval.n} PRs)"
        for c in d.comparisons
    )
    picked = (
        f"Picked configuration: {d.frozen}." if d.frozen else "No configuration picked."
    )
    if sampled:
        picked += " Model comparison on a sample of PRs."
    md = ["# LLM TD heuristic: evaluation report", "", f"**{picked}**"]
    md += ["", "## Data", ""] + [f"- {k}: {_fmt(v)}" for k, v in sorted(data.items())]
    md += ["", "## Decisions", ""] + [f"    {line}" for line in d.lines]
    md += ["", f"Interval widths reached: {widths or 'none'}."]
    out: dict[str, Any] = {"standalone": {}, "replay": {}, "replay_td_off": {}}
    for s in SLICES:
        metrics = sorted(by_slice[s].items())
        out["standalone"][s] = {i: m.row() for i, m in metrics}
        out["replay"][s] = {
            i: {t: [e1.to_json(), e2.to_json()] for t, (e1, e2) in m.replay.items()}
            for i, m in metrics
        }
        out["replay_td_off"][s] = {
            i: {t: e2.to_json() for t, e2 in m.replay_td_off.items()}
            for i, m in metrics
        }
        rows = [
            _standalone_row(i, m.row(), results[i].get("missing", 0))
            for i, m in metrics
        ]
        md += ["", f"## Standalone ranking, {s} slice", ""] + _table(
            STANDALONE_COLUMNS, rows
        )
        rows = [row for i, m in metrics for row in _replay_rows(i, m)]
        md += ["", f"## Replay inside TD's aggregate, {s} slice", ""]
        md += _table(REPLAY_COLUMNS, rows)
    rows = [
        _cost_row(f"{m} ({k})", c)
        for k, cs in sorted(costs.items())
        for m, c in sorted(cs.items())
    ]
    md += ["", "## Cost per candidate (16 threads)", ""] + _table(COST_COLUMNS, rows)
    md += ["", "## Notes", ""] + [f"- {n}" for n in NOTES] + [""]
    out.update(
        picked=picked,
        decisions=d.lines,
        comparisons=[
            {**asdict(c), "width": c.interval.width, "beats": c.beats}
            for c in d.comparisons
        ],
        frozen=d.frozen,
        costs={
            k: {m: {**c, "gates": gates(c)} for m, c in cs.items()}
            for k, cs in costs.items()
        },
        data=dict(data),
        notes=NOTES,
    )
    # json.loads maps the NaN json.dumps writes for missing metrics to null.
    return "\n".join(md), json.loads(json.dumps(out), parse_constant=lambda _: None)
