"""The dashboard's HTML: headline cards, the findings, the charts with their tables, and
the text."""

import json
from typing import Any, Optional

from torchci.td.analysis.dashboard import (
    COLORS,
    esc,
    FULL,
    GRID,
    INK,
    KS,
    LIGHT,
    MUTED,
    pct,
    SURFACE,
    table,
    TD,
)
from torchci.td.analysis.dashboard_findings import findings
from torchci.td.analysis.dashboard_sections import (
    cost_section,
    history,
    models_section,
    reds_section,
)
from torchci.td.analysis.dashboard_text import CAVEATS, INVENTORY, METHODS, POP_NAMES
from torchci.td.analysis.selection import name


STYLE = """
.viz-root{color-scheme:light;--surface:%s;--ink:%s;--muted:%s;--grid:%s;font-family:system-ui,sans-serif;
  background:var(--surface);color:var(--ink);max-width:1240px;margin:0 auto;padding:24px;line-height:1.45}
@media (prefers-color-scheme: dark){.viz-root{color-scheme:dark;--surface:%s;--ink:%s;--muted:%s;--grid:%s}}
body{margin:0;background:var(--surface)} h1{font-size:24px;margin:0 0 4px} h2{font-size:18px;margin:34px 0 8px}
.muted{color:var(--muted);font-size:13px} .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin:16px 0}
.card{border:1px solid var(--grid);border-radius:8px;padding:12px} .card .v{font-size:26px;font-weight:600}
.card .l{font-size:14px} .grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:12px} .grid2>div,.grid3>div{min-width:0}
table{border-collapse:collapse;font-size:13px;margin:8px 0} th,td{border-bottom:1px solid var(--grid);padding:4px 10px;text-align:right}
th:first-child,td:first-child{text-align:left} details{margin:6px 0 14px} summary{cursor:pointer;color:var(--muted);font-size:13px}
ul{padding-left:20px} li{margin:4px 0}
"""

DARK_JS = """<script>
window.addEventListener('load', function(){
 document.querySelectorAll('.plotly-graph-div').forEach(function(d){ Plotly.Plots.resize(d); });
});
(function(){
 if(!window.matchMedia('(prefers-color-scheme: dark)').matches) return;
 var map = %s;
 document.querySelectorAll('.plotly-graph-div').forEach(function(d){
  Plotly.relayout(d, {'paper_bgcolor':'%s','plot_bgcolor':'%s','font.color':'%s','xaxis.gridcolor':'%s','yaxis.gridcolor':'%s'});
  (d.data||[]).forEach(function(t,i){
   var c=(t.line&&t.line.color)||(t.marker&&t.marker.color);
   if(typeof c==='string'&&map[c]){Plotly.restyle(d,{'line.color':map[c],'marker.color':map[c],'marker.line.color':map[c]},[i]);}
  });
 });
})();
</script>"""


def card(value: str, label: str, sub: str) -> str:
    return f'<div class="card"><div class="v">{esc(value)}</div><div class="l">{esc(label)}</div><div class="muted">{esc(sub)}</div></div>'


def time_for_recall(rec: dict[str, Any], target: float) -> tuple[Optional[float], bool]:
    """The share of test time at which After with a time budget reaches `target` recall,
    linearly between the measured budgets; True when the smallest budget already does
    (the share is then an upper bound)."""
    pts = sorted(
        (rec[f"adaptive_time@{k}"]["time_share"], rec[f"adaptive_time@{k}"]["rate"])
        for k in KS
    )
    if pts[0][1] >= target:
        return pts[0][0], True
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if y0 < target <= y1:
            return (
                x0 + (x1 - x0) * (target - y0) / (y1 - y0) if y1 > y0 else x1
            ), False
    return None, False


def headline(r: dict[str, Any]) -> list[str]:
    cards = []
    for pop in ("gold", "pr_off", "silver"):
        rec = r["recall"][pop]
        b, a = rec[TD], rec[FULL]
        cards.append(
            card(
                f"{pct(b['rate'], 0)} → {pct(a['rate'], 0)}",
                f"{POP_NAMES[pop][0]} caught",
                f"TD today vs After with a time budget, at the same test time ({pct(b['time_share'], 0)}; n = {a['n']:,}; After {pct(a['lo'], 0)}-{pct(a['hi'], 0)})",
            )
        )
    red = r["reds"]["policies"][FULL]
    cards.append(
        card(
            f"{red['net_central_per_quarter']:+.0f} to {red['net_high_per_quarter']:+.0f}",
            "Reds kept off main per quarter (not established)",
            f"After with a time budget; central and high estimates, of about {r['reds']['false_greens_per_quarter']:.0f} reverted false greens a quarter today",
        )
    )
    off = r["recall"]["pr_off"]
    need, bound = time_for_recall(off, off[TD]["rate"])
    if need is not None:
        cards.append(
            card(
                f"{pct(off[TD]['time_share'], 0)} → {'≤ ' if bound else ''}{pct(need, 0)}",
                "Test time for TD's PR recall today",
                "After with a time budget, on PR failures on TD-off jobs",
            )
        )
    return cards


def recall_rows(rec: dict[str, Any]) -> list[list[Any]]:
    def fmt(x: dict[str, Any]) -> str:
        return f"{pct(x['rate'])} ({x['caught']}/{x['n']}) · {pct(x['test_share'], 0)} files · {pct(x['time_share'], 0)} time"

    return [
        [name(p), fmt(rec[p])]
        for p in (
            "before@15",
            "before@20",
            TD,
            "before@40",
            "adaptive_time@10",
            "adaptive_time@20",
            "adaptive_time@30",
            "adaptive_time@40",
            "adaptive_time@50",
            FULL,
            LIGHT,
        )
    ]


def page(r: dict[str, Any], divs: dict[str, str], stamp: str) -> str:
    s = [f'<div class="cards">{"".join(headline(r))}</div>']
    s.append(
        "<h2>What the numbers say</h2><ul>"
        + "".join(f"<li>{esc(x)}</li>" for x in findings(r))
        + "</ul>"
    )
    s.append(
        '<h2>Recall by test time</h2><p class="muted">CI cost is test time. TD cuts by share of test files (orange: its 5-100% cutoffs; the star and dotted line: TD today, 25%). After ranks by expected failures per second and stops at a test-time budget the risk model scales per change (green: 5-100% of test time on average). Bars are 95% Wilson intervals.</p>'
    )
    s.append(
        '<div class="grid3">'
        + "".join(
            f'<div>{divs["time_" + p]}<p class="muted">{esc(POP_NAMES[p][1])}</p><details><summary>Table</summary>{table(["Policy", "Recall · files · time"], recall_rows(r["recall"][p]))}</details></div>'
            for p in POP_NAMES
        )
        + "</div>"
    )
    paired = [
        [
            POP_NAMES[p][0],
            name(x["from"]),
            name(x["to"]),
            x["gained"],
            x["lost"],
            f"{x['p']:.3f}",
        ]
        for p, xs in r["paired"].items()
        for x in xs
    ]
    s.append(
        "<details><summary>The same failures under two policies (exact McNemar)</summary>"
        + table(
            [
                "Population",
                "From",
                "To",
                "Caught only by To",
                "Caught only by From",
                "p",
            ],
            paired,
        )
        + "</details>"
    )
    boot = [
        [
            name(x["from"]),
            name(x["to"]),
            f"{100 * x['diff']:+.1f}",
            f"{100 * x['lo']:+.1f} to {100 * x['hi']:+.1f}",
        ]
        for x in r["pr_bootstrap"]
    ]
    s.append(
        f"<details><summary>PR failures on TD-off jobs: recall differences with intervals that resample PRs ({r['meta']['pr_off_prs']:,} PRs)</summary>"
        + table(["From", "To", "Difference (points)", "95% interval"], boot)
        + "</details>"
    )
    s.append(history(r))
    s.append(reds_section(r, divs))
    s.append(cost_section(r, divs))
    s.append(models_section(r, divs))
    fid = r["fidelity"]
    s.append(
        "<h2>What is built today</h2><ul>"
        + "".join(f"<li>{esc(x)}</li>" for x in INVENTORY)
        + "</ul>"
    )
    s.append(
        "<h2>Method</h2><ul>"
        + "".join(f"<li>{esc(x)}</li>" for x in METHODS)
        + f"<li>Replay check: on {fid['failures']:,} PR failures, the replay of today's TD puts the failing file on the same side of the 25% cut as TD's logged ranking {pct(fid['share'])} of the time.</li>"
        f"<li>Samples: {', '.join(f'{v:,} {k} units' for k, v in r['meta']['units'].items())}; {r['meta']['gold_events']} reverted breakages and {r['meta']['silver_with_config_lists']} of {r['meta']['silver_units']} new-failure changes have TD's logged test lists for their failing configs ({r['meta']['gold_without_config_lists']} breakages without them are left out).</li></ul>"
    )
    s.append(
        "<h2>Caveats</h2><ul>"
        + "".join(f"<li>{esc(x)}</li>" for x in CAVEATS)
        + "</ul>"
    )
    style = STYLE % (
        SURFACE[0],
        INK[0],
        MUTED[0],
        GRID[0],
        SURFACE[1],
        INK[1],
        MUTED[1],
        GRID[1],
    )
    cmap = json.dumps(
        {v[0]: v[1] for v in COLORS.values()} | {INK[0]: INK[1], MUTED[0]: MUTED[1]}
    )
    dark = DARK_JS % (cmap, SURFACE[1], SURFACE[1], INK[1], GRID[1], GRID[1])
    meta = r["meta"]
    head = (
        f'<h1>Target determination: TD today vs after the TD project</h1><div class="muted">Data {esc(meta["window"][0])} to {esc(meta["window"][1])}; '
        f"After evaluated from {esc(meta['eval_start'])}. Generated {esc(stamp)}.</div>"
    )
    return (
        f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>TD before and after</title>'
        f'<style>{style}</style><!--PLOTLY--></head><body><div class="viz-root">{head}{"".join(s)}</div>{dark}</body></html>'
    )
