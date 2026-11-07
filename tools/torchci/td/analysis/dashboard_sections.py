"""The dashboard's sections below the recall charts: test history, reds on main,
precision and cost, and the two models."""

from typing import Any

from torchci.td.analysis.dashboard import CHEAP, esc, FULL, LIGHT, pct, PLANNED, table
from torchci.td.analysis.dashboard_text import SIGNAL_NAMES
from torchci.td.analysis.selection import name


def history(r: dict[str, Any]) -> str:
    share = [
        [
            label,
            f"{pct(v['before@25']['rate'])} (n = {v['before@25']['n']})",
            pct(v["after@25"]["rate"]),
            pct(v["time@20"]["rate"]),
            pct(v[FULL]["rate"]),
        ]
        for label, v in r["silver_by_share"].items()
    ]
    rec = [
        [
            label,
            f"{pct(v['before@25']['rate'])} (n = {v['before@25']['n']:,})",
            pct(v["random@25"]),
            pct(v["after@25"]["rate"]),
            pct(v[CHEAP]["rate"]),
            pct(v[FULL]["rate"]),
        ]
        for label, v in r["pr_off_by_recurrence"].items()
    ]
    return (
        '<h2>By test history</h2><div class="grid2"><div><p class="muted">New failures on main, by the test\'s failure share on main in the 14 days before.</p>'
        + table(
            [
                "Test's prior failure share",
                "TD today",
                "Ensemble, 25% of files",
                "Ensemble, 20% of time",
                "After with a time budget",
            ],
            share,
        )
        + '</div><div><p class="muted">PR failures on TD-off jobs, by how many other PRs failed the same file on a TD-off job in the 14 days before; a test failing across many PRs is more likely flaky than a regression. Random: the recall of a random 25% cut of the same tests.</p>'
        + table(
            [
                "Other PRs",
                "TD today",
                "Random",
                "Ensemble, 25% of files",
                "Cheapest first, TD's time",
                "After with a time budget",
            ],
            rec,
        )
        + "</div></div>"
    )


def reds_section(r: dict[str, Any], divs: dict[str, str]) -> str:
    red = r["reds"]
    rows = [
        [
            name(p),
            x["pr_gained"],
            x["pr_lost"],
            pct(x["td_off_kept"]),
            pct(x["td_on_kept"]),
            x["false_greens_caught"],
            f"{x['net_central_per_quarter']:+.1f}",
            f"{x['net_high_per_quarter']:+.1f}",
        ]
        for p, x in red["policies"].items()
        if p
        in (
            "before@15",
            "before@20",
            "before@25",
            "time@20",
            "time@40",
            "cheap@40",
            FULL,
            LIGHT,
            CHEAP,
            PLANNED,
            "adaptive@25",
        )
    ]
    return (
        "<h2>Reds on main</h2>"
        + divs["reds"]
        + f'<p class="muted">{red["false_greens_in_window"]} reverted false greens fell in the {red["gold_days"]} evaluation days ({red["false_greens"]} with TD\'s logged test lists, the ones the estimates use). '
        f"Central: false greens caught beyond TD's replay at 25% (which, under the same any-breaking-file rule, already catches {red['replay_catches_false_greens']}), times {pct(red['p_fail_on_pr_given_ran'], 0)} (an assumption: how often a breaking test that ran on its PR failed there, measured on reds that landed), minus TD's PR catches given up, at the rate TD's PR misses ({red['pr_missed_by_td']:,} on TD-off jobs) became false greens. High: false greens in proportion to TD's misses on PR failures. "
        "The two disagree by a wide margin and rest on two dozen breakages: the sign of the change in reds on main is not established. The share of TD's PR catches kept is about the same on TD-on and TD-off jobs, which supports the loss term.</p>"
        "<details open><summary>Terms</summary>"
        + table(
            [
                "Policy",
                "PR failures gained (TD-off)",
                "PR failures lost (TD-off)",
                "TD's PR catches kept (TD-off)",
                "TD's PR catches kept (TD-on)",
                f"Reverted false greens caught (of {red['false_greens']})",
                "Central per quarter",
                "High per quarter",
            ],
            rows,
        )
        + "</details>"
    )


def cost_section(r: dict[str, Any], divs: dict[str, str]) -> str:
    cost = [
        [
            name(p),
            pct(r["cost"]["main"][p]["test_share"]),
            pct(r["cost"]["main"][p]["time_share"]),
            pct(r["cost"]["pr_off"][p]["time_share"]),
            f"{r['precision'][p]['per_1000_hours']:.2f}"
            if r["precision"][p]["per_1000_hours"]
            else "-",
            f"{r['precision'][p]['tests_per_catch']:,.0f}"
            if r["precision"][p]["tests_per_catch"]
            else "-",
        ]
        for p in (
            "before@15",
            "before@20",
            "before@25",
            "after@20",
            "after@25",
            "time@20",
            "time@30",
            "time@40",
            PLANNED,
            "adaptive@25",
            CHEAP,
            FULL,
            LIGHT,
        )
    ]
    sens = [
        [
            f"{x['overhead']:.0f} s",
            pct(x["td25_time_share"]),
            pct(x["before_recall"]),
            f"{pct(x['cheap_recall'])} ({pct(x['cheap_test_share'], 0)} of files)",
            f"{pct(x['after_recall'])} ({pct(x['after_test_share'], 0)} of files)",
        ]
        for x in r["overhead_sensitivity"]
    ]
    return (
        "<h2>Precision and cost</h2>"
        + divs["precision"]
        + "<details open><summary>Cost and precision by policy</summary>"
        + table(
            [
                "Policy",
                "Test files run (landed)",
                "Test time run (landed)",
                "Test time run (PR TD-off)",
                "New main failures per 1,000 test hours",
                "Test files run per new main failure",
            ],
            cost,
        )
        + "</details>"
        "<details open><summary>Per-file overhead: PR failures caught on TD-off jobs at the test time TD spends today</summary>"
        + table(
            [
                "Overhead per file",
                "TD's test time share",
                "TD today",
                "Cheapest files first",
                "Ensemble per second",
            ],
            sens,
        )
        + "</details>"
    )


def models_section(r: dict[str, Any], divs: dict[str, str]) -> str:
    cal, imp, rk = r["calibration"], r["importance"], r["risk"]
    cal_text = "; ".join(
        f"{label}: Brier {c['brier']:.2e} vs {c['brier_base']:.2e} for the base rate, mean prediction {pct(c['mean_p'], 3)} vs observed {pct(c['base_rate'], 3)}"
        for label, c in (
            ("landed changes", cal["main"]),
            ("TD-off PR jobs", cal["pr_off"]),
        )
    )
    imp_rows = [
        [
            SIGNAL_NAMES.get(i["feature"], i["feature"]),
            f"{100 * i['mean']:+.2f}",
            f"{100 * i['lo']:+.2f} to {100 * i['hi']:+.2f}",
            pct(i["nonzero_share"], 2),
        ]
        for i in imp
    ]
    flag = [
        [f"top {pct(f['flag_top'], 0)}", pct(f["precision"]), pct(f["recall"])]
        for f in rk["flagging"]
    ]
    by_kind = "; ".join(
        f"{k}: " + ", ".join(f"{v:.1f}% for target {t}%" for t, v in m.items())
        for k, m in rk["mean_by_kind"].items()
    )
    return (
        '<h2>The ensemble</h2><div class="grid2"><div>'
        + divs["calibration"]
        + f'<p class="muted">Platt-scaled, but not calibrated: its Brier score is no better than the base rate\'s on either population, so its probabilities rank tests without being good absolute risks. {esc(cal_text)}. Bins with no failure are left out of the chart.</p></div><div>'
        + divs["importance"]
        + "<details><summary>Table</summary>"
        + table(
            [
                "Signal",
                "Drop (points)",
                "95% interval (units resampled)",
                "Rows where non-zero",
            ],
            imp_rows,
        )
        + "</details>"
        f'<p class="muted">Measured on the last 4 evaluation weeks ({imp[0]["units"]:,} units, {imp[0]["positives"]:,} failing tests), at TD\'s 25% file cut. A signal that is non-zero on few rows (edited, mentioned, public bindings, previously failed) cannot show its value here.</p></div></div>'
        '<h2>The risk model and cutoff</h2><div class="grid2"><div>'
        + divs["risk"]
        + f'<p class="muted">ROC AUC {rk["auc"]:.2f} (95% {rk["auc_lo"]:.2f}-{rk["auc_hi"]:.2f}), average precision {rk["average_precision"]:.3f} against a base rate of {pct(rk["base_rate"])} ({rk["positives"]} of {rk["units"]:,} landed changes broke main).</p>'
        "<details><summary>Flagging the riskiest changes</summary>"
        + table(["Flagged", "Precision", "Recall"], flag)
        + "</details></div><div>"
        + divs["budget"]
        + f'<p class="muted">Mean cutoff it picks, by population: {esc(by_kind)}. It is fit on landed changes; PR jobs lack line counts and get the median, so they sit higher, and the evaluation rescales each population\'s cutoffs to the target mean.</p></div></div>'
    )
