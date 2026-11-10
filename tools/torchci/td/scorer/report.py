"""The refit's report: report.json, the Markdown summary and the gate's numbers the
model file records. Stdlib only, like the `check` path of __main__.py."""

import json
from pathlib import Path
from typing import Any, Optional

from torchci.td.scorer import gate


REPORT_FILE, SUMMARY_FILE = "report.json", "summary.md"


def gate_record(out: dict[str, Any]) -> dict[str, Any]:
    """The gate's numbers as the model file records them (informational)."""
    keep = ("rate", "lo", "hi", "n", "cost_share")
    recall = {
        k: {c: {f: out["vs_td"][k][c][f] for f in keep} for c in ("td", "model")}
        for k in ("pr", "main", "pooled")
    }
    cal = out["calibration"]
    budget = out["budget"]
    return {
        "window": out["window"],
        "base": budget["base"],
        "recall_vs_td": recall,
        "bootstrap_td": budget["bootstrap"],
        "bootstrap_live": out["bootstrap_live"],
        "calibration": cal and {k: cal[k] for k in ("ratio", "brier", "positives")},
        "reasons": out["reasons"],
    }


def _pct(r: Optional[dict[str, Any]]) -> str:
    if not r or r.get("rate") is None:
        return "-"
    return f"{r['rate']:.1%} [{r['lo']:.1%}, {r['hi']:.1%}] ({r['caught']}/{r['n']})"


def _share(x: Optional[float]) -> str:
    return "-" if x is None else f"{x:.1%}"


def summary(out: dict[str, Any]) -> str:
    """The run's Markdown summary."""
    verdict = "passed" if out.get("passed") and "error" not in out else "failed"
    lines = [f"# TD scorer refit: {verdict}", "", f"Window: {out.get('window')}", ""]
    lines += [f"- {r}" for r in out.get("reasons", [])]
    if "error" in out:
        lines += [f"- {gate.FAIL}error: {out['error']}"]
    budget = out.get("budget") or {}
    if budget.get("shown") is not None:
        found = budget["base"] is not None
        lo, hi = budget["range"]
        lines += [
            "",
            f"Time budget base: {budget['shown']:.0%} (ranked {lo:.0%} to {hi:.0%} of"
            " test time by risk)"
            + ("" if found else f", no base up to {budget['max_base']:.0%} passed"),
        ]
    sections: list[tuple[str, Any, tuple[str, ...]]] = [
        ("Twin vs TD (last 28 days)", out.get("vs_td"), ("td", "model"))
    ]
    if out.get("vs_live"):
        live = out["vs_live"]
        sections.append(
            (
                f"Twin vs live (since {live['since']}, both at {live['share']:.0%})",
                live["twin"],
                ("model",),
            )
        )
        sections.append(("", live["live"], ("model",)))
    for title, metrics, cuts in sections:
        if not metrics:
            continue
        if title:
            lines += [
                "",
                f"## {title}",
                "",
                "| cut | PR failures | fresh main failures"
                " | pooled | share of tests | share of test time |",
                "|---|---|---|---|---|---|",
            ]
        for cut in cuts:
            name = {"td": "TD", "model": "model"}[cut] if title else "live model"
            pooled = metrics["pooled"]
            if cut not in pooled:
                continue
            tests = _share(pooled["test_share"]) if cut == "td" else "-"
            lines.append(
                f"| {name} | {_pct(metrics['pr'][cut])} | {_pct(metrics['main'][cut])}"
                f" | {_pct(pooled[cut])} | {tests}"
                f" | {_share(pooled[cut]['cost_share'])} |"
            )
    lines += ["", calibrated_line(out)]
    for title, key in (
        ("Calibration (twin before the last 56 days)", "calibration"),
        ("Drift (live)", "live_calibration"),
        (
            "TD-off PR units (information only: they exist only when the job had a"
            " PR-specific failure, so the ratio is not comparable to 1)",
            "pr_calibration",
        ),
    ):
        cal = out.get(key)
        if cal:
            lines += [
                "",
                f"## {title}",
                "",
                f"mean p / observed {cal['ratio']:.2f}, "
                f"Brier {cal['brier']:.3g}, base rate {cal['base_rate']:.3g}, "
                f"{cal['positives']} positives in {cal['rows']} rows",
            ]
    return "\n".join(lines) + "\n"


def calibrated_line(out: dict[str, Any]) -> str:
    """Whether the written model (else the twin) is Platt-calibrated, and why not."""
    from torchci.td.scorer.train import CALIB_DAYS, MIN_POSITIVES

    days = "/".join(map(str, CALIB_DAYS))
    calibrated = out.get("model_calibrated", (out.get("twin") or {}).get("calibrated"))
    if calibrated is None:
        return "Platt calibration: unknown (no model trained)"
    if calibrated:
        return f"Platt calibration: yes (landed changes of the last {days} days)"
    return (
        f"Platt calibration: no (identity): fewer than {MIN_POSITIVES} positives on"
        f" landed changes in every {days}-day slice before the cutoff or before it"
    )


def write_report(out_dir: Path, out: dict[str, Any]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / REPORT_FILE).write_text(json.dumps(out, indent=1, default=str) + "\n")
    (out_dir / SUMMARY_FILE).write_text(summary(out))
