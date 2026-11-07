"""The models' checks: the ensemble's calibration, how well the risk model ranks the
landed changes that broke main, and how closely the replay of today's TD follows TD's
logged rankings."""

from typing import Any

import numpy as np
import pandas as pd
from torchci.td.analysis import config, labels, policies
from torchci.td.analysis.breakdowns import BOOTSTRAP, SEED


def calibration(rows: pd.DataFrame) -> dict[str, Any]:
    df = rows[rows["y"].notna()]
    edges = np.unique(np.quantile(df["p"], np.linspace(0, 1, 11)))
    df = df.assign(bin=np.digitize(df["p"], edges[1:-1]))
    table = (
        df.groupby("bin")
        .agg(pred=("p", "mean"), obs=("y", "mean"), n=("y", "size"), pos=("y", "sum"))
        .reset_index()
    )
    base = df["y"].mean()
    return {
        "bins": table.to_dict("records"),
        "brier": float(((df["p"] - df["y"]) ** 2).mean()),
        "brier_base": float(((base - df["y"]) ** 2).mean()),
        "base_rate": float(base),
        "mean_p": float(df["p"].mean()),
        "rows": len(df),
        "positives": int(df["y"].sum()),
    }


def risk_summary(risk: pd.DataFrame, units_df: pd.DataFrame) -> dict[str, Any]:
    from sklearn.metrics import (
        average_precision_score,
        precision_recall_curve,
        roc_auc_score,
    )

    df = risk.merge(units_df[["unit_id", "kind", "positives", "single"]], on="unit_id")
    by_kind = {
        k: {str(t): float(g[f"budget_{t}"].mean()) for t in config.BUDGET_TARGETS}
        for k, g in df.groupby("kind")
    }
    df = df[(df["kind"] == "main") & df["single"]]
    y = (df["positives"].map(len) > 0).astype(int).to_numpy()
    score = df["risk"].to_numpy()
    rng = np.random.default_rng(SEED)
    aucs = []
    for _ in range(BOOTSTRAP):
        pick = rng.integers(0, len(y), len(y))
        if 0 < y[pick].sum() < len(pick):
            aucs.append(roc_auc_score(y[pick], score[pick]))
    prec, rec, _ = precision_recall_curve(y, score)
    step = max(1, len(prec) // 60)
    flagging = []
    for q in np.linspace(0.1, 0.9, 9):
        flagged = score >= float(np.quantile(score, q))
        tp = int((flagged & (y == 1)).sum())
        flagging.append(
            {
                "flag_top": round(1 - q, 2),
                "precision": tp / max(1, int(flagged.sum())),
                "recall": tp / max(1, int(y.sum())),
            }
        )
    return {
        "units": len(df),
        "positives": int(y.sum()),
        "auc": float(roc_auc_score(y, score)),
        "auc_lo": float(np.quantile(aucs, 0.025)),
        "auc_hi": float(np.quantile(aucs, 0.975)),
        "average_precision": float(average_precision_score(y, score)),
        "base_rate": float(y.mean()),
        "pr_curve": [
            {"precision": float(p), "recall": float(r)}
            for p, r in zip(prec[::step], rec[::step])
        ],
        "flagging": flagging,
        "budget_hist": {
            str(t): {
                str(k): int(v)
                for k, v in df[f"budget_{t}"].value_counts().sort_index().items()
            }
            for t in config.BUDGET_TARGETS
        },
        "realized_mean": {
            str(t): float(df[f"budget_{t}"].mean()) for t in config.BUDGET_TARGETS
        },
        "mean_by_kind": by_kind,
    }


def fidelity(rows: pd.DataFrame, ev: pd.DataFrame) -> dict[str, Any]:
    """How often the replay of today's TD puts a PR failure on the same side of the 25%
    cut as TD's logged ranking."""
    same = total = 0
    for uid, g in rows[rows["unit_id"].str.startswith("p:")].groupby("unit_id"):
        tests = list(g["test"])
        logged = policies.top_k(dict(zip(g["test"], g["before_score"])), tests, 25)
        replay = policies.top_k(dict(zip(g["test"], g["before_replay"])), tests, 25)
        for f in ev.loc[uid, "positives"]:
            total += 1
            same += (f in logged) == (f in replay)
    return {
        "failures": total,
        "same_side_of_cut": same,
        "share": same / total if total else None,
    }


def rebuild_check(
    rows: pd.DataFrame, ev: pd.DataFrame, silver_pos: dict[str, list[str]]
) -> dict[str, Any]:
    """How closely TD's replay on the ratings rebuilt with the pre-test-infra#9325
    formulas (Before's ratings where generated-stats kept no version) follows the replay
    on the versions that were live, on the new failures on main since WINDOW_START, where
    both exist: failures on the same side of the 25% cut, and TD's recall each way."""
    w0 = labels.unix(str(config.WINDOW_START))
    ids = {u for u in silver_pos if ev.loc[u, "time"] >= w0}
    same = total = live_hits = rebuilt_hits = 0
    for uid, g in rows[rows["unit_id"].isin(ids)].groupby("unit_id"):
        tests = list(g["test"])
        live = policies.top_k(dict(zip(tests, g["before_replay"])), tests, 25)
        rebuilt = policies.top_k(dict(zip(tests, g["before_rebuilt"])), tests, 25)
        files = silver_pos[uid]
        same += sum((f in live) == (f in rebuilt) for f in files)
        total += len(files)
        live_hits += any(f in live for f in files)
        rebuilt_hits += any(f in rebuilt for f in files)
    n = len(ids)
    return {
        "units": n,
        "failures": total,
        "same_side_share": same / total if total else None,
        "td_recall_live": live_hits / n if n else None,
        "td_recall_rebuilt": rebuilt_hits / n if n else None,
    }
