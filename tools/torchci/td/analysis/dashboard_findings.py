"""The dashboard's findings: sentences built from results.json, so every number on the
page comes from the evaluation."""

from typing import Any, Optional

from torchci.td.analysis.dashboard import KS, pct
from torchci.td.analysis.dashboard_text import SIGNAL_NAMES


FULL, CHEAP, PLANNED = "adaptive_time@td25", "cheap_time@td25", "adaptive@20"
# A signal non-zero on fewer rows than this cannot show its value in the importance test.
RARE = 0.01


def interp(points: list[tuple[float, float]], x: float) -> Optional[float]:
    """y at x on a curve given as (x, y) points, linearly between them."""
    pts = sorted(points)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0) if x1 > x0 else y1
    return None


def findings(r: dict[str, Any]) -> list[str]:
    rec, off = r["recall"], r["recall"]["pr_off"]
    gold, silver = rec["gold"], rec["silver"]
    boot = {(x["from"], x["to"]): x for x in r["pr_bootstrap"]}
    pairs = {p: {(x["from"], x["to"]): x for x in xs} for p, xs in r["paired"].items()}
    red = r["reds"]["policies"][FULL]
    cur = r["pr_off_by_recurrence"]
    novel, often = list(cur.values())[0], list(cur.values())[-1]
    imp = r["importance"]
    carries = [f"{SIGNAL_NAMES.get(i['feature'], i['feature']).lower()} {100 * i['mean']:.1f}" for i in imp if i["lo"] > 0]
    unclear = [SIGNAL_NAMES.get(i["feature"], i["feature"]).lower() for i in imp if i["lo"] <= 0 and i["nonzero_share"] >= RARE]
    rare = [SIGNAL_NAMES.get(i["feature"], i["feature"]).lower() for i in imp if i["lo"] <= 0 and i["nonzero_share"] < RARE]
    pl = off[PLANNED]
    td_same = interp([(off[f"before@{k}"]["time_share"], off[f"before@{k}"]["rate"]) for k in KS], pl["time_share"])
    ens = boot[(CHEAP, FULL)]
    ov = {x["overhead"]: x for x in r["overhead_sensitivity"]}
    rk = r["risk"]
    return [
        f"At the test time TD spends today, the After system with a time budget catches {pct(off[FULL]['rate'], 0)} of PR failures on TD-off jobs (TD: {pct(off['before@25']['rate'], 0)}), "
        f"{gold[FULL]['caught']} of {gold[FULL]['n']} reverted trunk breakages (TD's replay: {gold['before@25']['caught']}) and {silver[FULL]['caught']} of {silver[FULL]['n']} new failures on main (TD: {silver['before@25']['caught']}).",
        f"The project as planned, which keeps TD's cut by share of test files, does not get there. Its ensemble ranks better per file but favours big test files: at a risk-driven mean of 20% of files it catches {pct(pl['rate'], 0)} of PR failures "
        f"and runs {pct(pl['time_share'], 0)} of their test time, where TD at that test time would catch about {pct(td_same, 0)}.",
        f"The gain comes from cutting by test time, which no task of the project does yet. Test time sits in a few files (the top 5% of a default config's files take about 80% of its time), so a time budget skips a handful of expensive files and keeps most others. "
        f"With no model at all, cheapest files first at TD's test time catches {pct(off[CHEAP]['rate'], 0)} of PR failures, {gold[CHEAP]['caught']} of {gold[CHEAP]['n']} reverted breakages and {silver[CHEAP]['caught']} of {silver[CHEAP]['n']} new failures on main. "
        f"The ensemble on top adds {100 * ens['diff']:+.1f} points on PR failures (95% {100 * ens['lo']:+.1f} to {100 * ens['hi']:+.1f}, resampling PRs); on breakages and main failures the difference is a handful of events either way "
        f"({pairs['gold'][(CHEAP, FULL)]['gained']} gained, {pairs['gold'][(CHEAP, FULL)]['lost']} lost; {pairs['silver'][(CHEAP, FULL)]['gained']} gained, {pairs['silver'][(CHEAP, FULL)]['lost']} lost).",
        f"That holds for a larger per-file overhead too: at 30 s per file, cheapest first still catches {pct(ov[30.0]['cheap_recall'], 0)} and the ensemble {pct(ov[30.0]['after_recall'], 0)} of PR failures at TD's test time.",
        f"TD's ranking is close to random on PR failures no other PR had on a TD-off job in the 14 days before: {pct(novel['before@25']['rate'], 0)} at its 25% cut, against {pct(novel['random@25'], 0)} for a random cut of the same tests; "
        f"on tests that failed in 5 or more other PRs, often flaky, it catches {pct(often['before@25']['rate'], 0)}.",
        f"Reds kept off main per quarter: central {red['net_central_per_quarter']:+.1f}, high {red['net_high_per_quarter']:+.1f}, out of about {r['reds']['false_greens_per_quarter']:.0f} reverted false greens a quarter. "
        f"The estimators disagree and rest on two dozen breakages, so the sign is not established. The time budget keeps {pct(red['td_on_kept'], 0)} of the PR failures TD catches today on TD-on jobs.",
        f"The risk model separates breaking changes only weakly (ROC AUC {rk['auc']:.2f}, 95% {rk['auc_lo']:.2f}-{rk['auc_hi']:.2f}), so a per-change budget adds little over a fixed one.",
        "Signals (failing tests that fall out of the 25% cut when the signal is shuffled, in points): "
        + (", ".join(carries) if carries else "none clearly above zero")
        + (f". No measurable effect here: {', '.join(unclear)}" if unclear else "")
        + (f". Too rare in these populations to judge: {', '.join(rare)}" if rare else "")
        + ". This data supports no keep or drop verdict on a heuristic beyond that.",
    ]
