"""The dashboard's HTML: headline cards, the findings, the charts with their tables, and
the text."""

import json
from typing import Any, Optional

import numpy as np
from torchci.td.analysis import config
from torchci.td.analysis.dashboard import COLORS, esc, GRID, INK, KS, MUTED, pct, SURFACE, table
from torchci.td.analysis.dashboard_findings import findings, interp
from torchci.td.analysis.dashboard_text import CAVEATS, INVENTORY, METHODS, POP_NAMES, SIGNAL_NAMES
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

FULL, LIGHT, CHEAP, PLANNED = "adaptive_time@td25", "adaptive_time@td20", "cheap_time@td25", "adaptive@20"


def card(value: str, label: str, sub: str) -> str:
    return f'<div class="card"><div class="v">{esc(value)}</div><div class="l">{esc(label)}</div><div class="muted">{esc(sub)}</div></div>'


def time_for_recall(rec: dict[str, Any], target: float) -> tuple[Optional[float], bool]:
    """The share of test time at which the ensemble ranked per second reaches `target`
    recall, linearly between the measured cutoffs; True when the smallest cutoff already
    does (the share is then an upper bound)."""
    pts = sorted((rec[f"time@{k}"]["time_share"], rec[f"time@{k}"]["rate"]) for k in KS)
    if pts[0][1] >= target:
        return pts[0][0], True
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if y0 < target <= y1:
            return (x0 + (x1 - x0) * (target - y0) / (y1 - y0) if y1 > y0 else x1), False
    return None, False


def headline(r: dict[str, Any]) -> list[str]:
    cards = []
    for pop in ("gold", "pr_off", "silver"):
        rec = r["recall"][pop]
        b, a, c, pl = rec["before@25"], rec[FULL], rec[CHEAP], rec[PLANNED]
        cards.append(card(f"{pct(b['rate'], 0)} → {pct(a['rate'], 0)}", f"{POP_NAMES[pop][0]} caught",
                          f"TD today vs After with a time budget, at the same test time (n = {a['n']:,}; After {pct(a['lo'], 0)}-{pct(a['hi'], 0)}). "
                          f"No model: {pct(c['rate'], 0)}. After as planned: {pct(pl['rate'], 0)} at {pct(pl['time_share'], 0)} of test time vs TD's {pct(b['time_share'], 0)}."))
    red = r["reds"]["policies"][FULL]
    cards.append(card(f"{red['net_central_per_quarter']:+.0f} to {red['net_high_per_quarter']:+.0f}", "Reds kept off main per quarter (not established)",
                      f"After with a time budget; central and high estimates, of about {r['reds']['false_greens_per_quarter']:.0f} reverted false greens a quarter today"))
    off = r["recall"]["pr_off"]
    need, bound = time_for_recall(off, off["before@25"]["rate"])
    if need is not None:
        cards.append(card(f"{pct(off['before@25']['time_share'], 0)} → {'≤ ' if bound else ''}{pct(need, 0)}", "Test time for TD's PR recall today",
                          "the ensemble ranked per second of test time, on TD-off PR jobs"))
    pl = off[PLANNED]
    td_same = interp([(off[f"before@{k}"]["time_share"], off[f"before@{k}"]["rate"]) for k in KS], pl["time_share"])
    cards.append(card(f"{pct(pl['rate'], 0)} vs {pct(td_same, 0)}", "After as planned vs TD, same test time",
                      f"PR failures on TD-off jobs at {pct(pl['time_share'], 0)} of test time: the planned cut by files buys no recall per hour"))
    return cards


def recall_rows(rec: dict[str, Any]) -> list[list[Any]]:
    def fmt(x: dict[str, Any]) -> str:
        return f"{pct(x['rate'])} ({x['caught']}/{x['n']}) · {pct(x['test_share'], 0)} files · {pct(x['time_share'], 0)} time"

    return [[name(p), fmt(rec[p])] for p in rec if p.split("@")[1] in ("15", "20", "25", "40") or "adaptive" in p or "cheap_time" in p]


def page(r: dict[str, Any], divs: dict[str, str], stamp: str) -> str:
    s = [f'<div class="cards">{"".join(headline(r))}</div>']
    s.append("<h2>What the numbers say</h2><ul>" + "".join(f"<li>{esc(x)}</li>" for x in findings(r)) + "</ul>")
    s.append("<h2>Recall by test time</h2><p class=\"muted\">CI cost is test time. TD cuts by share of test files; the time budget ranks by expected failures per second and stops at a share of test time. Bars are 95% Wilson intervals.</p>")
    s.append('<div class="grid3">' + "".join(f"<div>{divs['time_' + p]}<p class=\"muted\">{esc(POP_NAMES[p][1])}</p><details><summary>Table</summary>{table(['Policy', 'Recall · files · time'], recall_rows(r['recall'][p]))}</details></div>" for p in POP_NAMES) + "</div>")
    s.append("<details><summary>Recall by share of test files, TD's cutoff (the view the project planned in)</summary><div class=\"grid3\">" +
             "".join(f"<div>{divs['count_' + p]}</div>" for p in POP_NAMES) + "</div></details>")
    paired = [[POP_NAMES[p][0], name(x["from"]), name(x["to"]), x["gained"], x["lost"], f"{x['p']:.3f}"] for p, xs in r["paired"].items() for x in xs]
    s.append("<details><summary>The same failures under two policies (exact McNemar)</summary>" + table(["Population", "From", "To", "Caught only by To", "Caught only by From", "p"], paired) + "</details>")
    boot = [[name(x["from"]), name(x["to"]), f"{100 * x['diff']:+.1f}", f"{100 * x['lo']:+.1f} to {100 * x['hi']:+.1f}"] for x in r["pr_bootstrap"]]
    s.append(f"<details><summary>PR failures on TD-off jobs: recall differences with intervals that resample PRs ({r['meta']['pr_off_prs']:,} PRs)</summary>" +
             table(["From", "To", "Difference (points)", "95% interval"], boot) + "</details>")
    s.append(history(r))
    s.append(reds_section(r, divs))
    s.append(cost_section(r, divs))
    s.append(models_section(r, divs))
    fid = r["fidelity"]
    s.append("<h2>What is built today</h2><ul>" + "".join(f"<li>{esc(x)}</li>" for x in INVENTORY) + "</ul>")
    s.append("<h2>Method</h2><ul>" + "".join(f"<li>{esc(x)}</li>" for x in METHODS) +
             f"<li>Replay check: on {fid['failures']:,} PR failures, the replay of today's TD puts the failing file on the same side of the 25% cut as TD's logged ranking {pct(fid['share'])} of the time.</li>"
             f"<li>Samples: {', '.join(f'{v:,} {k} units' for k, v in r['meta']['units'].items())}; {r['meta']['gold_events']} reverted breakages and {r['meta']['silver_with_config_lists']} of {r['meta']['silver_units']} new-failure changes have TD's logged test lists for their failing configs ({r['meta']['gold_without_config_lists']} breakages without them are left out).</li></ul>")
    s.append("<h2>Caveats</h2><ul>" + "".join(f"<li>{esc(x)}</li>" for x in CAVEATS) + "</ul>")
    style = STYLE % (SURFACE[0], INK[0], MUTED[0], GRID[0], SURFACE[1], INK[1], MUTED[1], GRID[1])
    cmap = json.dumps({v[0]: v[1] for v in COLORS.values()} | {INK[0]: INK[1], MUTED[0]: MUTED[1]})
    dark = DARK_JS % (cmap, SURFACE[1], SURFACE[1], INK[1], GRID[1], GRID[1])
    meta = r["meta"]
    head = (f"<h1>Target determination: TD today vs after the TD project</h1><div class=\"muted\">Data {esc(meta['window'][0])} to {esc(meta['window'][1])}; "
            f"After evaluated from {esc(meta['eval_start'])}. Generated {esc(stamp)}.</div>")
    return (f"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>TD before and after</title>"
            f"<style>{style}</style><!--PLOTLY--></head><body><div class=\"viz-root\">{head}{''.join(s)}</div>{dark}</body></html>")


def history(r: dict[str, Any]) -> str:
    share = [[label, f"{pct(v['before@25']['rate'])} (n = {v['before@25']['n']})", pct(v["after@25"]["rate"]), pct(v["time@20"]["rate"]), pct(v[FULL]["rate"])]
             for label, v in r["silver_by_share"].items()]
    rec = [[label, f"{pct(v['before@25']['rate'])} (n = {v['before@25']['n']:,})", pct(v["random@25"]), pct(v["after@25"]["rate"]), pct(v[CHEAP]["rate"]), pct(v[FULL]["rate"])]
           for label, v in r["pr_off_by_recurrence"].items()]
    return ("<h2>By test history</h2><div class=\"grid2\"><div><p class=\"muted\">New failures on main, by the test's failure share on main in the 14 days before.</p>" +
            table(["Test's prior failure share", "TD today", "Ensemble, 25% of files", "Ensemble, 20% of time", "After with a time budget"], share) +
            "</div><div><p class=\"muted\">PR failures on TD-off jobs, by how many other PRs failed the same file on a TD-off job in the 14 days before; a test failing across many PRs is more likely flaky than a regression. Random: the recall of a random 25% cut of the same tests.</p>" +
            table(["Other PRs", "TD today", "Random", "Ensemble, 25% of files", "Cheapest first, TD's time", "After with a time budget"], rec) + "</div></div>")


def reds_section(r: dict[str, Any], divs: dict[str, str]) -> str:
    red = r["reds"]
    rows = [[name(p), x["pr_gained"], x["pr_lost"], pct(x["td_off_kept"]), pct(x["td_on_kept"]), x["false_greens_caught"], f"{x['net_central_per_quarter']:+.1f}", f"{x['net_high_per_quarter']:+.1f}"]
            for p, x in red["policies"].items() if p in ("before@15", "before@20", "before@25", "time@20", "time@40", "cheap@40", FULL, LIGHT, CHEAP, PLANNED, "adaptive@25")]
    return ("<h2>Reds on main</h2>" + divs["reds"] +
            f"<p class=\"muted\">{red['false_greens_in_window']} reverted false greens fell in the {red['gold_days']} evaluation days ({red['false_greens']} with TD's logged test lists, the ones the estimates use). "
            f"Central: false greens caught beyond TD's replay at 25% (which, under the same any-breaking-file rule, already catches {red['replay_catches_false_greens']}), times {pct(red['p_fail_on_pr_given_ran'], 0)} (an assumption: how often a breaking test that ran on its PR failed there, measured on reds that landed), minus TD's PR catches given up, at the rate TD's PR misses ({red['pr_missed_by_td']:,} on TD-off jobs) became false greens. High: false greens in proportion to TD's misses on PR failures. "
            "The two disagree by a wide margin and rest on two dozen breakages: the sign of the change in reds on main is not established. The share of TD's PR catches kept is about the same on TD-on and TD-off jobs, which supports the loss term.</p>"
            "<details open><summary>Terms</summary>" + table(["Policy", "PR failures gained (TD-off)", "PR failures lost (TD-off)", "TD's PR catches kept (TD-off)", "TD's PR catches kept (TD-on)",
                                                         f"Reverted false greens caught (of {red['false_greens']})", "Central per quarter", "High per quarter"], rows) + "</details>")


def cost_section(r: dict[str, Any], divs: dict[str, str]) -> str:
    cost = [[name(p), pct(r["cost"]["main"][p]["test_share"]), pct(r["cost"]["main"][p]["time_share"]), pct(r["cost"]["pr_off"][p]["time_share"]),
             f"{r['precision'][p]['per_1000_hours']:.2f}" if r["precision"][p]["per_1000_hours"] else "-",
             f"{r['precision'][p]['tests_per_catch']:,.0f}" if r["precision"][p]["tests_per_catch"] else "-"]
            for p in ("before@15", "before@20", "before@25", "after@20", "after@25", "time@20", "time@30", "time@40", PLANNED, "adaptive@25", CHEAP, FULL, LIGHT)]
    sens = [[f"{x['overhead']:.0f} s", pct(x["td25_time_share"]), pct(x["before_recall"]), f"{pct(x['cheap_recall'])} ({pct(x['cheap_test_share'], 0)} of files)",
             f"{pct(x['after_recall'])} ({pct(x['after_test_share'], 0)} of files)"] for x in r["overhead_sensitivity"]]
    return ("<h2>Precision and cost</h2>" + divs["precision"] +
            "<details open><summary>Cost and precision by policy</summary>" +
            table(["Policy", "Test files run (landed)", "Test time run (landed)", "Test time run (PR TD-off)", "New main failures per 1,000 test hours", "Test files run per new main failure"], cost) + "</details>"
            "<details open><summary>Per-file overhead: PR failures caught on TD-off jobs at the test time TD spends today</summary>" +
            table(["Overhead per file", "TD's test time share", "TD today", "Cheapest files first", "Ensemble per second"], sens) + "</details>")


def models_section(r: dict[str, Any], divs: dict[str, str]) -> str:
    cal, imp, rk = r["calibration"], r["importance"], r["risk"]
    cal_text = "; ".join(f"{label}: Brier {c['brier']:.2e} vs {c['brier_base']:.2e} for the base rate, mean prediction {pct(c['mean_p'], 3)} vs observed {pct(c['base_rate'], 3)}"
                         for label, c in (("landed changes", cal["main"]), ("TD-off PR jobs", cal["pr_off"])))
    imp_rows = [[SIGNAL_NAMES.get(i["feature"], i["feature"]), f"{100 * i['mean']:+.2f}", f"{100 * i['lo']:+.2f} to {100 * i['hi']:+.2f}", pct(i["nonzero_share"], 2)] for i in imp]
    flag = [[f"top {pct(f['flag_top'], 0)}", pct(f["precision"]), pct(f["recall"])] for f in rk["flagging"]]
    by_kind = "; ".join(f"{k}: " + ", ".join(f"{v:.1f}% for target {t}%" for t, v in m.items()) for k, m in rk["mean_by_kind"].items())
    return ("<h2>The ensemble</h2><div class=\"grid2\"><div>" + divs["calibration"] +
            f"<p class=\"muted\">Platt-scaled, not calibrated on landed changes. {esc(cal_text)}. Bins with no failure are left out of the chart.</p></div><div>" + divs["importance"] +
            "<details><summary>Table</summary>" + table(["Signal", "Drop (points)", "95% interval (units resampled)", "Rows where non-zero"], imp_rows) + "</details>"
            f"<p class=\"muted\">Measured on the last 4 evaluation weeks ({imp[0]['units']:,} units, {imp[0]['positives']:,} failing tests), at TD's 25% file cut. A signal that is non-zero on few rows (edited, mentioned, public bindings, previously failed) cannot show its value here.</p></div></div>"
            "<h2>The risk model and cutoff</h2><div class=\"grid2\"><div>" + divs["risk"] +
            f"<p class=\"muted\">ROC AUC {rk['auc']:.2f} (95% {rk['auc_lo']:.2f}-{rk['auc_hi']:.2f}), average precision {rk['average_precision']:.3f} against a base rate of {pct(rk['base_rate'])} ({rk['positives']} of {rk['units']:,} landed changes broke main).</p>"
            "<details><summary>Flagging the riskiest changes</summary>" + table(["Flagged", "Precision", "Recall"], flag) + "</details></div><div>" + divs["budget"] +
            f"<p class=\"muted\">Mean cutoff it picks, by population: {esc(by_kind)}. It is fit on landed changes; PR jobs lack line counts and get the median, so they sit higher.</p></div></div>")
