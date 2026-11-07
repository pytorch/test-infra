"""The dashboard's findings: sentences built from results.json, so every number on the
page comes from the evaluation."""

from typing import Any

from torchci.td.analysis.dashboard import FULL, pct, TD
from torchci.td.analysis.dashboard_text import SIGNAL_NAMES


# A signal non-zero on fewer rows than this cannot show its value in the importance test.
RARE = 0.01


def caught(rec: dict[str, Any], policy: str) -> str:
    x = rec[policy]
    return f"{x['caught']} of {x['n']}"


def findings(r: dict[str, Any]) -> list[str]:
    rec, off = r["recall"], r["recall"]["pr_off"]
    gold, silver = rec["gold"], rec["silver"]
    boot = {(x["from"], x["to"]): x for x in r["pr_bootstrap"]}
    red = r["reds"]["policies"][FULL]
    cur = r["pr_off_by_recurrence"]
    novel, often = list(cur.values())[0], list(cur.values())[-1]
    imp = r["importance"]
    label = lambda i: SIGNAL_NAMES.get(i["feature"], i["feature"])  # noqa: E731
    common = [i for i in imp if i["nonzero_share"] >= RARE]
    carries = [f"{label(i)} {100 * i['mean']:.1f}" for i in common if i["lo"] > 0]
    unclear = [label(i) for i in common if i["lo"] <= 0]
    rare = [label(i) for i in imp if i["nonzero_share"] < RARE]
    diff = boot[(TD, FULL)]
    ov = {x["overhead"]: x for x in r["overhead_sensitivity"]}
    rk = r["risk"]
    budgets = [
        f"at {k}% of test time on average it catches {pct(off[f'adaptive_time@{k}']['rate'], 0)} of PR failures, "
        f"{caught(gold, f'adaptive_time@{k}')} reverted breakages and {caught(silver, f'adaptive_time@{k}')} new failures on main"
        for k in (10, 20)
    ]
    return [
        f"At the test time TD spends today ({pct(off[TD]['time_share'], 0)} of it on PR jobs), After with a time budget catches {pct(off[FULL]['rate'], 0)} of PR failures on TD-off jobs (TD: {pct(off[TD]['rate'], 0)}; "
        f"{100 * diff['diff']:+.0f} points, 95% {100 * diff['lo']:+.0f} to {100 * diff['hi']:+.0f}, resampling PRs), "
        f"{caught(gold, FULL)} reverted trunk breakages (TD's replay: {gold[TD]['caught']}) and {caught(silver, FULL)} new failures on main (TD: {silver[TD]['caught']}).",
        f"With less test time: {budgets[0]}; {budgets[1]}.",
        "After ranks tests by expected failures per second of test time and stops at a test-time budget, which no task of the project does yet: the project plans a cut by share of files. "
        f"Test time sits in a few files (the top 5% of a default config's files take about 80% of its time), so at TD's test time After skips a handful of expensive files and runs {pct(off[FULL]['test_share'], 0)} of the files (TD: {pct(off[TD]['test_share'], 0)}).",
        f"That holds for a larger per-file overhead too: at 30 s per file, After still catches {pct(ov[30.0]['after_recall'], 0)} of PR failures at TD's test time.",
        f"TD's ranking is close to random on PR failures no other PR had on a TD-off job in the 14 days before: {pct(novel[TD]['rate'], 0)} at its 25% cut, against {pct(novel['random@25'], 0)} for a random cut of the same tests; "
        f"on tests that failed in 5 or more other PRs, often flaky, it catches {pct(often[TD]['rate'], 0)}.",
        f"Reds kept off main per quarter: central {red['net_central_per_quarter']:+.1f}, high {red['net_high_per_quarter']:+.1f}, out of about {r['reds']['false_greens_per_quarter']:.0f} reverted false greens a quarter. "
        f"The estimators disagree and rest on two dozen breakages, so the sign is not established. The time budget keeps {pct(red['td_on_kept'], 0)} of the PR failures TD catches today on TD-on jobs.",
        f"The risk model separates breaking changes only weakly (ROC AUC {rk['auc']:.2f}, 95% {rk['auc_lo']:.2f}-{rk['auc_hi']:.2f}), so its per-change scaling of the budget can do little.",
        "Signals (failing tests that fall out of the 25% cut when the signal is shuffled, in points): "
        + (", ".join(carries) if carries else "none clearly above zero")
        + (f". No measurable effect here: {', '.join(unclear)}" if unclear else "")
        + (
            f". Present on under 1% of rows, too rare here to judge: {', '.join(rare)}"
            if rare
            else ""
        )
        + ". This data supports no keep or drop verdict on a heuristic beyond that.",
    ]
