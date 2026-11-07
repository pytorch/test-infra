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
from torchci.td.analysis.dashboard_text import POP_NAMES, SIGNAL_NAMES
from torchci.td.analysis.schema import read_manifest, RESULTS_FILE
from torchci.td.analysis.selection import AFTER_NAME


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
TD, FULL, LIGHT = "before@25", "adaptive_time@td25", "adaptive_time@td20"
# A grey with at least 3:1 contrast on both surfaces: layout shapes are not restyled in
# dark mode.
REFERENCE = "#7f7e79"


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
) -> None:
    fig.add_trace(
        go.Scatter(
            x=xs,
            y=[r["rate"] for r in recs],
            name=name,
            mode="lines+markers",
            line={"color": color, "width": 2},
            marker={"size": 7},
            customdata=[[r["caught"], r["n"]] for r in recs],
            error_y={
                "type": "data",
                "symmetric": False,
                "array": [r["hi"] - r["rate"] for r in recs],
                "arrayminus": [r["rate"] - r["lo"] for r in recs],
                "thickness": 1,
                "width": 3,
            },
            hovertemplate=f"test time %{{x:.0%}}<br>recall %{{y:.1%}} (%{{customdata[0]}} of %{{customdata[1]}})<extra>{esc(name)}</extra>",
        )
    )


def td_today(fig: go.Figure, x: float, y: float, text: str) -> None:
    """TD as it runs today: a marker on its line and a dotted line at its test time."""
    fig.add_vline(x=x, line={"color": REFERENCE, "dash": "dot", "width": 1})
    fig.add_trace(
        go.Scatter(
            x=[x],
            y=[y],
            name="TD today (25% of files)",
            mode="markers+text",
            text=["TD today"],
            textposition="top left",
            marker={
                "size": 15,
                "symbol": "star",
                "color": COLORS["before"][0],
                "line": {"width": 1, "color": INK[0]},
            },
            hovertemplate=f"TD today<br>{text}<extra></extra>",
        )
    )


def recall_time_fig(rec: dict[str, Any], pop: str) -> go.Figure:
    fig = go.Figure()
    line(
        fig,
        [rec[f"before@{k}"]["time_share"] for k in KS],
        [rec[f"before@{k}"] for k in KS],
        "TD at other cutoffs (5-100% of files)",
        COLORS["before"][0],
    )
    line(
        fig,
        [rec[f"adaptive_time@{k}"]["time_share"] for k in KS],
        [rec[f"adaptive_time@{k}"] for k in KS],
        f"{AFTER_NAME} (5-100%)",
        COLORS["adaptive"][0],
    )
    td = rec[TD]
    td_today(
        fig,
        td["time_share"],
        td["rate"],
        f"{td['time_share']:.0%} of test time, recall {td['rate']:.1%}",
    )
    fig.update_xaxes(tickformat=".0%", range=[0, 1.02])
    fig.update_yaxes(tickformat=".0%", range=[0, 1.05])
    return layout(
        fig,
        f"{POP_NAMES[pop][0]} (n = {td['n']:,})",
        "Test time run",
        "Recall",
    )


def precision_fig(r: dict[str, Any]) -> go.Figure:
    prec, cost = r["precision"], r["cost"]["main"]
    fig = go.Figure()
    for prefix, name, color in (
        ("before", "TD at other cutoffs", COLORS["before"][0]),
        ("adaptive_time", AFTER_NAME, COLORS["adaptive"][0]),
    ):
        fig.add_trace(
            go.Scatter(
                x=[cost[f"{prefix}@{k}"]["time_share"] for k in KS],
                y=[prec[f"{prefix}@{k}"]["per_1000_hours"] for k in KS],
                name=name,
                mode="lines+markers",
                line={"color": color, "width": 2},
                marker={"size": 7},
                customdata=[[prec[f"{prefix}@{k}"]["caught"]] for k in KS],
                hovertemplate=f"test time %{{x:.0%}}<br>%{{y:.2f}} per 1,000 test hours (%{{customdata[0]}} caught)<extra>{esc(name)}</extra>",
            )
        )
    x, y = cost[TD]["time_share"], prec[TD]["per_1000_hours"]
    td_today(fig, x, y, f"{x:.0%} of test time, {y:.2f} per 1,000 test hours")
    fig.update_xaxes(tickformat=".0%")
    return layout(
        fig,
        "Precision: all new main failures (flaky included) caught per 1,000 test hours",
        "Test time run (landed changes)",
        "Failures caught per 1,000 test hours",
    )


def importance_fig(imp: list[dict[str, Any]]) -> go.Figure:
    rows = imp[::-1]
    fig = go.Figure(
        go.Bar(
            x=[r["mean"] for r in rows],
            y=[SIGNAL_NAMES.get(r["feature"], r["feature"]) for r in rows],
            orientation="h",
            marker={"color": COLORS["after"][0]},
            error_x={
                "type": "data",
                "symmetric": False,
                "array": [r["hi"] - r["mean"] for r in rows],
                "arrayminus": [r["mean"] - r["lo"] for r in rows],
                "thickness": 1,
            },
            customdata=[[r["lo"], r["hi"], r["nonzero_share"]] for r in rows],
            hovertemplate="%{x:.2%} (95%: %{customdata[0]:.2%} to %{customdata[1]:.2%}); signal non-zero on %{customdata[2]:.1%} of rows<extra></extra>",
        )
    )
    fig.update_xaxes(tickformat=".1%")
    return layout(
        fig,
        "What each signal adds to the ensemble's ranking",
        "Failing tests lost from the 25% cut, signal shuffled",
        "",
        height=480,
    )


def table(head: list[str], rows: list[list[Any]]) -> str:
    th = "".join(f"<th>{esc(h)}</th>" for h in head)
    body = "".join(
        "<tr>" + "".join(f"<td>{esc(c)}</td>" for c in r) + "</tr>" for r in rows
    )
    return f"<table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table>"


def run(cache: Path, out: Path) -> None:
    from torchci.td.analysis.dashboard_page import page

    manifest = read_manifest(cache, "evaluate")
    r = json.loads((cache / "evaluate" / RESULTS_FILE).read_text())
    if r["sanity"]["failed"]:
        raise RuntimeError(f"sanity checks failed: {r['sanity']['failed']}")
    figs = {f"time_{p}": recall_time_fig(r["recall"][p], p) for p in POP_NAMES}
    figs.update(
        precision=precision_fig(r),
        importance=importance_fig(r["importance"]),
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
