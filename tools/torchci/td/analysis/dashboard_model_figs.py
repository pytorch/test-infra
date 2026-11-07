"""The dashboard's charts of the two models: the ensemble's calibration and signal
importance, the risk model's precision / recall and the cutoffs it picks."""

from typing import Any

import plotly.graph_objects as go
from torchci.td.analysis import config
from torchci.td.analysis.dashboard import COLORS, layout, MUTED
from torchci.td.analysis.dashboard_text import SIGNAL_NAMES


def calibration_fig(cal: dict[str, Any]) -> go.Figure:
    fig = go.Figure()
    shown = {pop: [b for b in c["bins"] if b["obs"] > 0] for pop, c in cal.items()}
    lo = min(min(b["pred"] for b in bins) for bins in shown.values() if bins)
    fig.add_trace(
        go.Scatter(
            x=[lo, 1],
            y=[lo, 1],
            mode="lines",
            name="Perfect calibration",
            line={"color": MUTED[0], "dash": "dot", "width": 1},
            hoverinfo="skip",
        )
    )
    for (pop, bins), color in zip(
        shown.items(), (COLORS["after"][0], COLORS["before"][0])
    ):
        name = {"main": "Landed changes", "pr_off": "TD-off PR jobs (tests that ran)"}[
            pop
        ]
        fig.add_trace(
            go.Scatter(
                x=[b["pred"] for b in bins],
                y=[b["obs"] for b in bins],
                mode="lines+markers",
                name=name,
                line={"color": color, "width": 2},
                marker={"size": 9},
                customdata=[[b["pos"], b["n"]] for b in bins],
                hovertemplate=f"predicted %{{x:.3%}}<br>observed %{{y:.3%}} (%{{customdata[0]}} of %{{customdata[1]:,}})<extra>{name}</extra>",
            )
        )
    fig.update_xaxes(type="log")
    fig.update_yaxes(type="log")
    return layout(
        fig,
        "Ensemble calibration (tenths of its predictions with a failure)",
        "Predicted P(test fails)",
        "Observed share",
        height=440,
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


def risk_fig(risk: dict[str, Any]) -> go.Figure:
    fig = go.Figure(
        go.Scatter(
            x=[p["recall"] for p in risk["pr_curve"]],
            y=[p["precision"] for p in risk["pr_curve"]],
            mode="lines",
            name="Risk model",
            line={"color": COLORS["after"][0], "width": 2},
            hovertemplate="recall %{x:.0%}<br>precision %{y:.1%}<extra></extra>",
        )
    )
    fig.add_hline(
        y=risk["base_rate"], line={"color": MUTED[0], "dash": "dot", "width": 1}
    )
    fig.update_xaxes(tickformat=".0%")
    fig.update_yaxes(tickformat=".1%")
    return layout(
        fig,
        "Risk model: flagging the landed changes that break main",
        "Recall (breaking changes flagged)",
        "Precision",
        height=420,
    )


def budget_fig(risk: dict[str, Any]) -> go.Figure:
    fig = go.Figure()
    for t, color in zip(
        config.BUDGET_TARGETS, (COLORS["adaptive"][0], COLORS["after"][0])
    ):
        hist = {int(k): v for k, v in risk["budget_hist"][str(t)].items()}
        fig.add_trace(
            go.Bar(
                x=sorted(hist),
                y=[hist[k] for k in sorted(hist)],
                name=f"mean {t}%",
                marker={"color": color},
                hovertemplate=f"%{{y}} changes at %{{x}}%<extra>mean {t}%</extra>",
            )
        )
    fig.update_layout(barmode="group", bargap=0.15)
    return layout(
        fig,
        "Cutoffs the risk model picks per landed change",
        "Cutoff (% of test files)",
        "Landed changes",
        height=420,
    )
