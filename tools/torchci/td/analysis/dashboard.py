"""Report step: results.json as one self-contained HTML page (Plotly inlined, no remote
fetches). It shows aggregates only: no per-PR, per-commit or per-author rows."""

import html
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import plotly.graph_objects as go
import plotly.io as pio
from plotly.offline import get_plotlyjs
from torchci.td.analysis import config
from torchci.td.analysis.dashboard_text import POP_NAMES
from torchci.td.analysis.schema import read_manifest, RESULTS_FILE


# The reference palette's first three categorical slots (light, dark): they stay apart
# for colour-blind readers when shown together.
COLORS = {
    "before": ("#eb6834", "#d95926"),
    "after": ("#2a78d6", "#3987e5"),
    "adaptive": ("#1baf7a", "#199e70"),
}
INK = ("#0b0b0b", "#f0efec")
MUTED = ("#52514e", "#c3c2b7")
GRID = ("#e4e3df", "#3a3a37")
SURFACE = ("#fcfcfb", "#1a1a19")
KS = list(config.CUTOFFS)
FULL_TIME = {
    "td25": "After with a time budget, TD's test time",
    "td20": "After with a time budget, TD-at-20% time",
}
FULL, LIGHT, CHEAP, PLANNED = (
    "adaptive_time@td25",
    "adaptive_time@td20",
    "cheap_time@td25",
    "adaptive@20",
)


def esc(value: Any) -> str:
    return html.escape(str(value))


def pct(x: Any, digits: int = 1) -> str:
    return "-" if x is None else f"{100 * x:.{digits}f}%"


def layout(
    fig: go.Figure, title: str, xtitle: str, ytitle: str, height: int = 460
) -> go.Figure:
    fig.update_layout(
        title={"text": esc(title), "font": {"size": 15}},
        height=height,
        margin={"l": 64, "r": 20, "t": 50, "b": 40},
        paper_bgcolor=SURFACE[0],
        plot_bgcolor=SURFACE[0],
        font={"color": INK[0], "family": "system-ui, sans-serif"},
        hovermode="closest",
        legend={"orientation": "h", "y": -0.22},
    )
    fig.update_xaxes(title=xtitle, gridcolor=GRID[0], zeroline=False)
    fig.update_yaxes(title=ytitle, gridcolor=GRID[0], zeroline=False)
    return fig


def line(
    fig: go.Figure,
    xs: list[float],
    recs: list[dict[str, Any]],
    name: str,
    color: str,
    xfmt: str,
    dash: Any = None,
    errors: bool = True,
) -> None:
    fig.add_trace(
        go.Scatter(
            x=xs,
            y=[r["rate"] for r in recs],
            name=name,
            mode="lines+markers" if errors else "lines",
            line={"color": color, "width": 2, "dash": dash},
            marker={"size": 7},
            customdata=[[r["caught"], r["n"]] for r in recs],
            error_y={
                "type": "data",
                "symmetric": False,
                "array": [r["hi"] - r["rate"] for r in recs],
                "arrayminus": [r["rate"] - r["lo"] for r in recs],
                "thickness": 1,
                "width": 3,
                "visible": errors,
            },
            hovertemplate=f"x %{{x:{xfmt}}}<br>recall %{{y:.1%}} (%{{customdata[0]}} of %{{customdata[1]}})<extra>{esc(name)}</extra>",
        )
    )


def point(
    fig: go.Figure, x: float, rec: dict[str, Any], name: str, xfmt: str, symbol: str
) -> None:
    fig.add_trace(
        go.Scatter(
            x=[x],
            y=[rec["rate"]],
            name=name,
            mode="markers",
            customdata=[[rec["caught"], rec["n"]]],
            marker={
                "size": 13,
                "symbol": symbol,
                "color": COLORS["adaptive"][0],
                "line": {"width": 2, "color": COLORS["adaptive"][0]},
            },
            hovertemplate=f"x %{{x:{xfmt}}}<br>recall %{{y:.1%}} (%{{customdata[0]}} of %{{customdata[1]}})<extra>{esc(name)}</extra>",
        )
    )


def recall_time_fig(rec: dict[str, Any], pop: str) -> go.Figure:
    fig = go.Figure()
    line(
        fig,
        [rec[f"before@{k}"]["time_share"] for k in KS],
        [rec[f"before@{k}"] for k in KS],
        "TD today",
        COLORS["before"][0],
        ".0%",
    )
    line(
        fig,
        [rec[f"cheap@{k}"]["time_share"] for k in KS],
        [rec[f"cheap@{k}"] for k in KS],
        "Cheapest files first (no model)",
        MUTED[0],
        ".0%",
        "dash",
        False,
    )
    line(
        fig,
        [rec[f"time@{k}"]["time_share"] for k in KS],
        [rec[f"time@{k}"] for k in KS],
        "Ensemble, per second of test time",
        COLORS["after"][0],
        ".0%",
    )
    for t in config.BUDGET_TARGETS:
        r = rec[f"adaptive@{t}"]
        point(
            fig,
            r["time_share"],
            r,
            f"After as planned (mean {t}% of files)",
            ".0%",
            "circle-open",
        )
    for n, label in FULL_TIME.items():
        r = rec[f"adaptive_time@{n}"]
        point(fig, r["time_share"], r, label, ".0%", "diamond")
    fig.update_xaxes(tickformat=".0%")
    fig.update_yaxes(tickformat=".0%", range=[0, 1.05])
    return layout(
        fig,
        f"{POP_NAMES[pop][0]} (n = {rec['before@25']['n']:,})",
        "Test time run",
        "Recall",
    )


def recall_count_fig(rec: dict[str, Any], pop: str) -> go.Figure:
    fig = go.Figure()
    line(
        fig,
        KS,
        [rec[f"before@{k}"] for k in KS],
        "TD today",
        COLORS["before"][0],
        ".0f",
    )
    line(
        fig,
        KS,
        [rec[f"after@{k}"] for k in KS],
        "Ensemble ranking",
        COLORS["after"][0],
        ".0f",
    )
    for t in config.BUDGET_TARGETS:
        r = rec[f"adaptive@{t}"]
        point(
            fig,
            100 * r["test_share"],
            r,
            f"After as planned (target mean {t}%)",
            ".0f",
            "circle-open",
        )
    fig.update_yaxes(tickformat=".0%", range=[0, 1.05])
    return layout(
        fig,
        f"{POP_NAMES[pop][0]} (n = {rec['before@25']['n']:,})",
        "Test files run (%)",
        "Recall",
    )


def reds_fig(r: dict[str, Any]) -> go.Figure:
    pol, cost = r["reds"]["policies"], r["cost"]["main"]
    fig = go.Figure()
    for prefix, name, color in (
        ("before", "TD at other cuts", COLORS["before"][0]),
        ("time", "Ensemble, per second of test time", COLORS["after"][0]),
        ("cheap", "Cheapest files first (no model)", MUTED[0]),
    ):
        xs = [cost[f"{prefix}@{k}"]["time_share"] for k in KS]
        for est, dash, width in (("central", None, 2), ("high", "dot", 1)):
            fig.add_trace(
                go.Scatter(
                    x=xs,
                    y=[pol[f"{prefix}@{k}"][f"net_{est}_per_quarter"] for k in KS],
                    name=f"{name} ({est})",
                    mode="lines+markers" if est == "central" else "lines",
                    line={"color": color, "width": width, "dash": dash},
                    marker={"size": 6},
                    hovertemplate=f"test time %{{x:.0%}}<br>%{{y:+.1f}} reds per quarter<extra>{esc(name)}, {est}</extra>",
                )
            )
    for n, label in FULL_TIME.items():
        p = f"adaptive_time@{n}"
        fig.add_trace(
            go.Scatter(
                x=[cost[p]["time_share"]],
                y=[pol[p]["net_central_per_quarter"]],
                name=f"{label} (central)",
                mode="markers",
                marker={
                    "size": 13,
                    "symbol": "diamond",
                    "color": COLORS["adaptive"][0],
                },
                hovertemplate="test time %{x:.0%}<br>%{y:+.1f} reds per quarter<extra></extra>",
            )
        )
    fig.add_hline(y=0, line={"color": MUTED[0], "width": 1})
    fig.update_xaxes(tickformat=".0%")
    return layout(
        fig,
        "Reds kept off main per quarter, against TD today at 25%",
        "Test time run (landed changes)",
        "Reds kept off main per quarter",
    )


def precision_fig(r: dict[str, Any]) -> go.Figure:
    prec, cost = r["precision"], r["cost"]["main"]
    fig = go.Figure()
    for prefix, name, color, dash in (
        ("before", "TD today", COLORS["before"][0], None),
        ("time", "Ensemble, per second of test time", COLORS["after"][0], None),
        ("cheap", "Cheapest files first (no model)", MUTED[0], "dash"),
    ):
        fig.add_trace(
            go.Scatter(
                x=[cost[f"{prefix}@{k}"]["time_share"] for k in KS],
                y=[prec[f"{prefix}@{k}"]["per_1000_hours"] for k in KS],
                name=name,
                mode="lines+markers",
                line={"color": color, "width": 2, "dash": dash},
                marker={"size": 7},
                customdata=[[prec[f"{prefix}@{k}"]["caught"]] for k in KS],
                hovertemplate=f"test time %{{x:.0%}}<br>%{{y:.2f}} per 1,000 test hours (%{{customdata[0]}} caught)<extra>{esc(name)}</extra>",
            )
        )
    fig.update_xaxes(tickformat=".0%")
    return layout(
        fig,
        "Precision: new main failures caught per 1,000 hours of test time run",
        "Test time run (landed changes)",
        "Failures caught per 1,000 test hours",
    )


def table(head: list[str], rows: list[list[Any]]) -> str:
    th = "".join(f"<th>{esc(h)}</th>" for h in head)
    body = "".join(
        "<tr>" + "".join(f"<td>{esc(c)}</td>" for c in r) + "</tr>" for r in rows
    )
    return f"<table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table>"


def run(cache: Path, out: Path) -> None:
    from torchci.td.analysis.dashboard_model_figs import (
        budget_fig,
        calibration_fig,
        importance_fig,
        risk_fig,
    )
    from torchci.td.analysis.dashboard_page import page

    manifest = read_manifest(cache, "evaluate")
    r = json.loads((cache / "evaluate" / RESULTS_FILE).read_text())
    if r["sanity"]["failed"]:
        raise RuntimeError(f"sanity checks failed: {r['sanity']['failed']}")
    figs = {f"time_{p}": recall_time_fig(r["recall"][p], p) for p in POP_NAMES}
    figs.update({f"count_{p}": recall_count_fig(r["recall"][p], p) for p in POP_NAMES})
    figs.update(
        reds=reds_fig(r),
        precision=precision_fig(r),
        calibration=calibration_fig(r["calibration"]),
        importance=importance_fig(r["importance"]),
        risk=risk_fig(r["risk"]),
        budget=budget_fig(r["risk"]),
    )
    divs = {
        k: pio.to_html(
            f,
            full_html=False,
            include_plotlyjs=False,
            include_mathjax=False,
            div_id=f"fig-{k}",
            default_width="100%",
            default_height=f"{f.layout.height}px",
            config={"displaylogo": False, "responsive": True},
        )
        for k, f in figs.items()
    }
    stamp = f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC, analysis code {manifest['code_commit'][:10]}"
    out.write_text(
        page(r, divs, stamp).replace(
            "<!--PLOTLY-->", f"<script>{get_plotlyjs()}</script>"
        )
    )
