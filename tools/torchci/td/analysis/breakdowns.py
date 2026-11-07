"""The evaluation's breakdowns: reds kept off main, splits by test history, the cost-model
sensitivity, PR-clustered intervals and the sanity checks."""

import logging
from datetime import timedelta
from math import comb
from typing import Any

import numpy as np
import pandas as pd
from torchci.td.analysis import config, policies
from torchci.td.analysis.selection import POLICIES, recall, strip, Unit


logger = logging.getLogger(__name__)

DAY = 86400
BOOTSTRAP = 1000
SEED = 0
OVERHEADS = (0.0, 5.0, 15.0, 30.0)
SHARE_BUCKETS = (
    (0.0, 0.0, "never failed on main"),
    (0.0, 0.05, "failed on up to 5% of pushes"),
    (0.05, 1.01, "failed on over 5%"),
)
RECURRENCE_BUCKETS = (
    (0, 0, "no other PR failed it in the 14 days before"),
    (1, 4, "1-4 other PRs failed it"),
    (5, 10**9, "5 or more other PRs failed it"),
)


def reds(
    rec_gold: dict[str, Any],
    rec_off: dict[str, Any],
    gold_outcomes: list[str],
    gold_all: pd.DataFrame,
    units,
    ev,
    on_ids,
    fg_window: int,
) -> dict[str, Any]:
    """Reds kept off main against TD today at 25%, per quarter. FG: the reverted false
    greens of the evaluation weeks that have TD's test lists, the reds TD's misses put on
    main today.

    - Central: the false greens a policy catches beyond TD's replay at 25% (under the same
      catch rule, any breaking file of any failing config selected), discounted by d1, how
      often a breaking test that ran on its PR failed there (an assumption: it is measured
      on reds that landed), minus the PR failures TD catches today that the policy skips,
      converted at the rate TD's misses became false greens: FG * lost / missed, all on
      TD-off PR jobs. The share of TD's catches a policy keeps on TD-on jobs is reported
      beside it as a check of that loss rate.
    - High: FG change in proportion to TD's misses on PR failures on TD-off jobs:
      FG * (gained - lost) / missed."""
    ran = gold_all[gold_all["outcome"].isin(("signal_on_pr", "passed_on_pr"))][
        "outcome"
    ].value_counts()
    d1 = ran.get("signal_on_pr", 0) / max(1, ran.sum())
    days = (config.WINDOW_STOP - timedelta(days=7) - config.EVAL_START).days
    quarter = 91 / days
    fg = sum(1 for o in gold_outcomes if o == "false_green")
    b25 = rec_off["before@25"]["hits"]
    missed = sum(1 for x in b25 if not x)

    def caught_fg(p: str) -> int:
        return sum(
            1
            for hit, o in zip(rec_gold[p]["hits"], gold_outcomes)
            if hit and o == "false_green"
        )

    base = caught_fg("before@25")
    out = {
        "false_greens": fg,
        "false_greens_in_window": fg_window,
        "false_greens_per_quarter": fg_window * quarter,
        "p_fail_on_pr_given_ran": d1,
        "quarter_factor": quarter,
        "gold_days": days,
        "pr_missed_by_td": missed,
        "replay_catches_false_greens": base,
        "policies": {},
    }
    for p in POLICIES:
        hp = rec_off[p]["hits"]
        gained = sum(1 for x, y in zip(b25, hp) if y and not x)
        lost = sum(1 for x, y in zip(b25, hp) if x and not y)
        a = caught_fg(p)
        kept = [
            f in units[u].sel[p]
            for u in on_ids
            for f in ev.loc[u, "positives"]
            if f in units[u].sel["before@25"]
        ]
        out["policies"][p] = {
            "pr_gained": gained,
            "pr_lost": lost,
            "false_greens_caught": a,
            "net_central_per_quarter": ((a - base) * d1 - fg * lost / max(1, missed))
            * quarter,
            "net_high_per_quarter": fg * (gained - lost) / max(1, missed) * quarter,
            "td_on_kept": float(np.mean(kept)) if kept else None,
            "td_off_kept": 1 - lost / max(1, len(b25) - missed),
        }
    return out


def silver_by_share(
    units: dict[str, Unit],
    silver: pd.DataFrame,
    silver_view: dict[str, Any],
    ev: pd.DataFrame,
) -> dict[str, Any]:
    share = {(r.sha, r.file): r.fail_share for r in silver.itertuples()}

    def in_bucket(s: float, lo: float, hi: float) -> bool:
        return s == 0 if hi == 0 else lo < s <= hi

    out = {}
    for lo, hi, label in SHARE_BUCKETS:
        evs = []
        for u, (vids, fmap) in silver_view.items():
            sub = {
                v: [
                    f
                    for f in fs
                    if in_bucket(share.get((ev.loc[u, "sha"], f), 0.0), lo, hi)
                ]
                for v, fs in fmap.items()
            }
            if any(sub.values()):
                evs.append((vids, sub))
        out[label] = strip(recall(units, evs))
    return out


def random_catch(n: int, m: int, c: int) -> float:
    """P(a random c of n tests holds at least one of m failing ones)."""
    return 1.0 - comb(n - m, c) / comb(n, c)


def pr_recurrence(
    units: dict[str, Unit],
    ev: pd.DataFrame,
    units_df: pd.DataFrame,
    off_pos: dict[str, list[str]],
) -> dict[str, Any]:
    """PR TD-off recall split by how many other PRs failed the same file on a TD-off job
    (uncensored: every test could run there) in the 14 days before, over every unit of the
    window; with the exact recall of a random cut of the same size per unit."""
    hits: dict[str, list[tuple[int, int]]] = {}
    for r in units_df[units_df["kind"] == "pr_off"].itertuples():
        for f in r.positives:
            hits.setdefault(f, []).append((int(r.time), int(r.pr_number)))
    out = {}
    for lo, hi, label in RECURRENCE_BUCKETS:
        pos = {}
        for u, fs in off_pos.items():
            t, pr = int(ev.loc[u, "time"]), int(ev.loc[u, "pr_number"])
            keep = [
                f
                for f in fs
                if lo
                <= len(
                    {
                        p
                        for tt, p in hits.get(f, [])
                        if t - 14 * DAY <= tt < t and p != pr
                    }
                )
                <= hi
            ]
            if keep:
                pos[u] = keep
        rec = strip(recall(units, [([u], {u: f}) for u, f in pos.items()]))
        rec["random@25"] = (
            float(
                np.mean(
                    [
                        random_catch(
                            len(units[u].tests),
                            len(f),
                            policies.cut_size(len(units[u].tests), 25),
                        )
                        for u, f in pos.items()
                    ]
                )
            )
            if pos
            else None
        )
        out[label] = rec
    return out


def overhead_sensitivity(
    units: dict[str, Unit], main_ids: list[str], off_pos: dict[str, list[str]]
) -> list[dict[str, Any]]:
    """PR TD-off recall of the ensemble ranked per second and of cheapest-first, each at
    the test time TD spends on the unit at 25%, under other per-file overheads."""
    out = []
    for overhead in OVERHEADS:
        secs = {
            u: {
                t: s - config.FILE_OVERHEAD_SECONDS + overhead
                for t, s in units[u].seconds.items()
            }
            for u in set(main_ids) | set(off_pos)
        }

        def share(u: str, sel: set[str], secs: dict = secs) -> float:
            return sum(secs[u][t] for t in sel) / sum(secs[u].values())

        row: dict[str, Any] = {
            "overhead": overhead,
            "td25_time_share": float(
                np.mean([share(u, units[u].sel["before@25"]) for u in main_ids])
            ),
            "before_recall": float(
                np.mean(
                    [
                        bool(units[u].sel["before@25"] & set(f))
                        for u, f in off_pos.items()
                    ]
                )
            ),
        }
        for name, order in (
            (
                "after",
                lambda u, secs=secs: policies.by_value(
                    units[u].after, units[u].tests, secs[u]
                ),
            ),
            (
                "cheap",
                lambda u, secs=secs: policies.cheapest(units[u].tests, secs[u]),
            ),
        ):
            sels = {
                u: set(
                    policies.time_select(
                        order(u), secs[u], share(u, units[u].sel["before@25"])
                    )
                )
                for u in off_pos
            }
            row[f"{name}_recall"] = float(
                np.mean([bool(sels[u] & set(f)) for u, f in off_pos.items()])
            )
            row[f"{name}_test_share"] = float(
                np.mean([len(sels[u]) / len(units[u].tests) for u in off_pos])
            )
        out.append(row)
    return out


def pr_bootstrap(
    rec_off: dict[str, Any], prs: list[int], pairs: list[tuple[str, str]]
) -> list[dict[str, Any]]:
    """95% intervals of recall differences on PR TD-off failures, resampling PRs (a PR
    contributes several units)."""
    rng = np.random.default_rng(SEED)
    ids, inverse = np.unique(prs, return_inverse=True)
    counts = np.bincount(inverse)
    out = []
    for a, b in pairs:
        diff = np.bincount(
            inverse,
            weights=np.array(rec_off[b]["hits"], float)
            - np.array(rec_off[a]["hits"], float),
        )
        boots = [
            diff[pick].sum() / counts[pick].sum()
            for pick in (rng.integers(0, len(ids), len(ids)) for _ in range(BOOTSTRAP))
        ]
        out.append(
            {
                "from": a,
                "to": b,
                "diff": float(diff.sum() / counts.sum()),
                "lo": float(np.quantile(boots, 0.025)),
                "hi": float(np.quantile(boots, 0.975)),
                "prs": int(len(ids)),
            }
        )
    return out


def sanity(out: dict[str, Any]) -> dict[str, Any]:
    checks = {}
    for pop, rec in out["recall"].items():
        checks[f"{pop}: recall at 100% is 1"] = rec["before@100"]["rate"] in (
            None,
            1.0,
        ) and rec["time@100"]["rate"] in (None, 1.0)
        for side in ("before", "after", "time", "cheap"):
            caught = [rec[f"{side}@{k}"]["caught"] for k in config.CUTOFFS]
            checks[f"{pop}: {side} recall is monotone in the cutoff"] = all(
                a <= b for a, b in zip(caught, caught[1:])
            )
    for t in config.BUDGET_TARGETS:
        checks[f"landed changes: realised mean cutoff within 1 point of {t}%"] = (
            abs(out["risk"]["realized_mean"][str(t)] - t) <= 1.0
        )
    pol = out["reds"]["policies"]["before@25"]
    checks["reds: TD at 25% nets 0 against itself"] = (
        pol["net_central_per_quarter"] == 0 and pol["net_high_per_quarter"] == 0
    )
    failed = [k for k, v in checks.items() if not v]
    if failed:
        logger.error("sanity checks failed: %s", failed)
    return {"checks": checks, "failed": failed}
