"""The dashboard's sections below the recall charts: test history, precision and cost,
and what each signal adds to the ensemble."""

from typing import Any

from torchci.td.analysis.dashboard import esc, FULL, LIGHT, pct, table
from torchci.td.analysis.dashboard_text import SIGNAL_NAMES
from torchci.td.analysis.selection import AFTER_NAME, name


def history(r: dict[str, Any]) -> str:
    share = [
        [
            label,
            f"{pct(v['before@25']['rate'])} (n = {v['before@25']['n']})",
            pct(v["adaptive_time@20"]["rate"]),
            pct(v[FULL]["rate"]),
        ]
        for label, v in r["silver_by_share"].items()
    ]
    rec = [
        [
            label,
            f"{pct(v['before@25']['rate'])} (n = {v['before@25']['n']:,})",
            pct(v["random@25"]),
            pct(v[FULL]["rate"]),
        ]
        for label, v in r["pr_off_by_recurrence"].items()
    ]
    return (
        f'<h2>By test history</h2><div class="grid2"><div><p class="muted">Changes with a new failure on main since {esc(r["meta"]["silver_eval_start"])}, by the failing test\'s failure share on main in the 14 days before (a change with failures in several rows counts in each): the first row is the fresh failures charted above, the others are mostly flaky re-failures.</p>'
        + table(
            [
                "Test's prior failure share",
                "TD today",
                "After, 20% of test time",
                "After, TD's test time",
            ],
            share,
        )
        + '</div><div><p class="muted">PR failures on TD-off jobs, by how many other PRs failed the same file on a TD-off job in the 14 days before; a test failing across many PRs is more likely flaky than a regression. Random: the recall of a random 25% cut of the same tests.</p>'
        + table(
            [
                "Other PRs",
                "TD today",
                "Random",
                "After, TD's test time",
            ],
            rec,
        )
        + "</div></div>"
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
            "adaptive_time@10",
            "adaptive_time@20",
            "adaptive_time@30",
            "adaptive_time@40",
            "adaptive_time@50",
            FULL,
            LIGHT,
        )
    ]
    sens = [
        [
            f"{x['overhead']:.0f} s",
            pct(x["td25_time_share"]),
            pct(x["before_recall"]),
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
                "All new main failures per 1,000 test hours",
                "Test files run per new main failure (all)",
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
                AFTER_NAME,
            ],
            sens,
        )
        + "</details>"
    )


def models_section(r: dict[str, Any], divs: dict[str, str]) -> str:
    imp = r["importance"]
    imp_rows = [
        [
            SIGNAL_NAMES.get(i["feature"], i["feature"]),
            f"{100 * i['mean']:+.2f}",
            f"{100 * i['lo']:+.2f} to {100 * i['hi']:+.2f}",
            pct(i["nonzero_share"], 2),
        ]
        for i in imp
    ]
    return (
        "<h2>The ensemble</h2>"
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
        f'<p class="muted">Measured on the last 4 evaluation weeks ({imp[0]["units"]:,} units, {imp[0]["positives"]:,} failing tests), at TD\'s 25% file cut. A signal that is non-zero on few rows (edited, mentioned, public bindings, previously failed) cannot show its value here.</p>'
    )
