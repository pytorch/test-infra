"""Train step: the After system's two models, refit every week on an expanding window and
applied only to the weeks after their data (a TRAIN_GAP_DAYS gap lets every training
label settle first).

- Ensemble: P(test fails on this change), a low-capacity gradient-boosted model
  over the After signals, Platt-calibrated on a later slice it was not fit on.
- Risk: P(this landed change newly breaks a test on main), logistic regression on
  PR stats, file risk, author history and the ensemble's outputs, mapped to a per-change
  cutoff k = BUDGET_MIN + (BUDGET_MAX - BUDGET_MIN) * F(risk)^g, F the risk's CDF over the
  training changes, g set so the mean cutoff over them is the target (no labels used).
"""

import logging
from datetime import timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from torchci.td.analysis import config
from torchci.td.analysis.features import SIGNALS, UNIT_STATS
from torchci.td.analysis.schema import load, save, write_manifest


logger = logging.getLogger(__name__)

DAY = 86400
# Calibration slices tried in turn, until one holds MIN_POSITIVES main positives.
CALIB_DAYS = (28, 42, 56)
# The first week the ensemble predicts (as risk-model features only before EVAL_START).
PRED_START = config.EVAL_START - timedelta(days=14)
NEG_KEEP = 0.2
MIN_POSITIVES = 10
IMPORTANCE_WEEKS = 4
IMPORTANCE_REPEATS = 3
SEED = 0
ENSEMBLE_FEATURES = (*SIGNALS, "llm_raw", "llm_tq", "is_pr", *UNIT_STATS)
RISK_FEATURES = ("log_files", "log_src_files", "n_test_files", "log_sig_added", "log_sig_deleted", "docs_only",
                 *[f"area_{a}" for a in config.AREAS], "sum_p", "max_p", "sum_fail", "max_llm", "author_landings", "author_breaks")


def weeks(start_at: Any = None) -> list[int]:
    """Mondays from EVAL_START (or `start_at`) to the window's end."""
    start = int((start_at or config.EVAL_START).replace(tzinfo=timezone.utc).timestamp())
    stop = int(config.WINDOW_STOP.replace(tzinfo=timezone.utc).timestamp())
    return list(range(start, stop, 7 * DAY))


def training_rows(rows: pd.DataFrame, units: pd.DataFrame, before: int) -> pd.DataFrame:
    """Labelled rows of units that settled before `before`: main changes (not infra-wide
    breaks) and TD-off PR configs with run evidence; negatives subsampled, reweighted."""
    ok = units[(units["time"] < before) & (units["train_ok"])]["unit_id"]
    df = rows[rows["unit_id"].isin(ok) & rows["y"].notna()]
    rng = np.random.default_rng(SEED)
    keep = (df["y"] == 1) | (rng.random(len(df)) < NEG_KEEP)
    df = df[keep]
    return df.assign(w=np.where(df["y"] == 1, 1.0, 1.0 / NEG_KEEP))


def fit_ensemble(train: pd.DataFrame) -> HistGradientBoostingClassifier:
    model = HistGradientBoostingClassifier(
        max_depth=3, learning_rate=0.05, max_iter=300, min_samples_leaf=200, l2_regularization=1.0,
        early_stopping=True, validation_fraction=0.1, random_state=SEED,
    )
    model.fit(train[list(ENSEMBLE_FEATURES)], train["y"], sample_weight=train["w"])
    return model


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-7, 1 - 1e-7)
    return np.log(p / (1 - p))


def fit_platt(raw: np.ndarray, y: np.ndarray, w: np.ndarray) -> LogisticRegression:
    platt = LogisticRegression(C=1e6)
    platt.fit(logit(raw).reshape(-1, 1), y, sample_weight=w)
    return platt


def ensemble_week(rows: pd.DataFrame, units: pd.DataFrame, week: int) -> pd.DataFrame:
    end = week - config.TRAIN_GAP_DAYS * DAY
    train = training_rows(rows, units, end)
    model = fit_ensemble(train)
    platt = None
    for days in CALIB_DAYS:
        calib_train = training_rows(rows, units, end - days * DAY)
        main_ids = units[(units["kind"] == "main") & units["train_ok"] & (units["time"] >= end - days * DAY) & (units["time"] < end)]["unit_id"]
        calib = rows[rows["unit_id"].isin(main_ids)]
        if calib_train["y"].sum() >= MIN_POSITIVES and calib["y"].sum() >= MIN_POSITIVES:
            calib_model = fit_ensemble(calib_train)
            platt = fit_platt(calib_model.predict_proba(calib[list(ENSEMBLE_FEATURES)])[:, 1], calib["y"].to_numpy(), np.ones(len(calib)))
            break
    target = units[(units["time"] >= week) & (units["time"] < week + 7 * DAY)]["unit_id"]
    out = rows[rows["unit_id"].isin(target)][["unit_id", "test", *ENSEMBLE_FEATURES]].copy()
    raw = model.predict_proba(out[list(ENSEMBLE_FEATURES)])[:, 1]
    out["p_raw"] = raw
    out["p"] = platt.predict_proba(logit(raw).reshape(-1, 1))[:, 1] if platt is not None else raw
    out["calibrated"] = platt is not None
    out["week"] = week
    logger.info("week %s: %d units, %d train positives, calibrated %s", pd.Timestamp(week, unit="s").date(), len(target),
                int(train["y"].sum()), platt is not None)
    return out[["unit_id", "test", "p_raw", "p", "calibrated", "week"]]


def author_history(units: pd.DataFrame, commits: pd.DataFrame, silver: pd.DataFrame) -> pd.DataFrame:
    """Per unit: the author's landings in the 180 days before, and their changes that newly
    broke main and settled at least TRAIN_GAP_DAYS before. Authors stay hashed keys."""
    landed = commits[commits["author_key"] != ""][["author_key", "pushed_at", "sha"]]
    broke = set(silver["sha"])
    out = []
    by_author = {a: g.sort_values("pushed_at") for a, g in landed.groupby("author_key")}
    for u in units.itertuples():
        g = by_author.get(u.author_key)
        if g is None:
            out.append((u.unit_id, 0, 0))
            continue
        t = int(u.time)
        prior = g[(g["pushed_at"] < t) & (g["pushed_at"] >= t - 180 * DAY)]
        settled = g[g["pushed_at"] < t - config.TRAIN_GAP_DAYS * DAY]
        out.append((u.unit_id, len(prior), int(settled["sha"].isin(broke).sum())))
    return pd.DataFrame(out, columns=["unit_id", "author_landings", "author_breaks"])


def risk_table(units: pd.DataFrame, stats: pd.DataFrame, preds: pd.DataFrame, rows: pd.DataFrame, authors: pd.DataFrame) -> pd.DataFrame:
    agg = preds.groupby("unit_id").agg(sum_p=("p", "sum"), max_p=("p", "max"))
    sig = rows.groupby("unit_id").agg(sum_fail=("fail", "sum"), max_llm=("llm_raw", "max"))
    df = units[["unit_id", "kind", "time", "positives", "train_ok"]].merge(stats, on="unit_id", how="left")
    df = df.merge(agg, on="unit_id", how="left").merge(sig, on="unit_id", how="left").merge(authors, on="unit_id", how="left")
    for col in ("files", "src_files", "sig_added", "sig_deleted"):
        src = {"files": "n_files", "src_files": "n_src_files"}.get(col, col)
        df[f"log_{col}"] = np.log1p(df[src].astype(float))
    df["y"] = (df["positives"].map(len) > 0).astype(int)
    return df


def budget_curve(risk_train: np.ndarray, target: float) -> tuple[np.ndarray, float]:
    """The exponent g so that the mean of round(kmin + (kmax - kmin) F^g) over the
    training risks is `target`; F is their empirical CDF."""
    ref = np.sort(risk_train)
    f = np.searchsorted(ref, risk_train, side="right") / len(ref)
    lo, hi = 0.01, 100.0
    for _ in range(60):
        g = (lo * hi) ** 0.5
        mean = np.round(config.BUDGET_MIN + (config.BUDGET_MAX - config.BUDGET_MIN) * f**g).mean()
        lo, hi = (g, hi) if mean > target else (lo, g)
    return ref, (lo * hi) ** 0.5


def budget(ref: np.ndarray, g: float, risk: np.ndarray) -> np.ndarray:
    f = np.searchsorted(ref, risk, side="right") / len(ref)
    return np.round(config.BUDGET_MIN + (config.BUDGET_MAX - config.BUDGET_MIN) * f**g).astype(int)


def risk_week(table: pd.DataFrame, week: int) -> pd.DataFrame:
    end = week - config.TRAIN_GAP_DAYS * DAY
    train = table[(table["kind"] == "main") & table["train_ok"] & (table["time"] < end) & table["sum_p"].notna()]
    model = make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=2000, class_weight="balanced"))
    x = list(RISK_FEATURES)
    fill = train[x].median()
    model.fit(train[x].fillna(fill), train["y"])
    target = table[(table["time"] >= week) & (table["time"] < week + 7 * DAY)].copy()
    target["risk"] = model.predict_proba(target[x].fillna(fill))[:, 1]
    train_risk = model.predict_proba(train[x].fillna(fill))[:, 1]
    for k in config.BUDGET_TARGETS:
        ref, g = budget_curve(train_risk, k)
        target[f"budget_{k}"] = budget(ref, g, target["risk"].to_numpy())
    target["week"] = week
    return target[["unit_id", "risk", "week", *[f"budget_{k}" for k in config.BUDGET_TARGETS]]]


def run(cache: Path) -> None:
    units = load(cache, "labels", "units")
    silver, commits = load(cache, "labels", "silver"), load(cache, "fetch", "commits")
    rows, stats = load(cache, "features", "rows"), load(cache, "features", "unit_stats")
    llm = load(cache, "llm", "scores")
    rows = rows.merge(llm, on=["unit_id", "test"], how="left")
    rows = rows.merge(stats, on="unit_id", how="left")
    infra = set(silver.loc[~silver["train_ok"], "sha"])
    units = units.assign(
        train_ok=((units["kind"] == "main") & units["single"] & ~units["sha"].isin(infra))
        | ((units["kind"] == "pr_off") & units["observed"].notna())
    )
    rows["is_pr"] = rows["unit_id"].str.startswith("p:").astype(np.int8)
    # Weeks before EVAL_START get predictions too, only as the risk model's training
    # features; every reported figure uses weeks from EVAL_START.
    preds = pd.concat([ensemble_week(rows, units, w) for w in weeks(PRED_START)], ignore_index=True)
    pr_meta = load(cache, "fetch", "pr_meta").set_index("pr_number")["author_key"]
    units = units.assign(author_key=units["pr_number"].map(pr_meta).fillna(""))
    authors = author_history(units, commits, silver)
    # The risk model's ensemble features for training changes come from the ensemble
    # trained before each change's own week, so they are out-of-time too.
    table = risk_table(units, stats, preds, rows, authors)
    risk = pd.concat([risk_week(table, w) for w in weeks()], ignore_index=True)
    imp = importance(rows, units)
    save(cache, "train", "preds", preds)
    save(cache, "train", "risk", risk)
    save(cache, "train", "importance", imp)
    write_manifest(cache, "train", {"preds": preds, "risk": risk, "importance": imp})


IMPORTANCE_GROUPS = {
    "fail": ("fail", "fail_n"), "coedit": ("coedit", "coedit_n"), "filepath": ("filepath", "filepath_n"),
    "llm": ("llm_raw", "llm_tq"), "profiling": ("profiling_n",), "edited": ("edited",), "mentioned": ("mentioned",),
    "prev_failed": ("prev_failed",), "public_bindings": ("public_bindings",), "fail_share": ("fail_share",),
    "test_seconds": ("test_seconds",), "is_pr": ("is_pr",), "pr_stats": UNIT_STATS,
}


UNIT_LEVEL = ("is_pr", "pr_stats")
BOOTSTRAP = 300


def caught_at_cut(df: pd.DataFrame, p: np.ndarray) -> pd.Series:
    """Per failing row (indexed like `df`): whether it is inside its unit's 25% cut when
    the unit's tests are ranked by `p` (TD's objective: the ranking within one change)."""
    d = pd.DataFrame({"u": df["unit_id"].to_numpy(), "t": df["test"].to_numpy(), "p": p, "y": df["y"].to_numpy()}, index=df.index)
    d = d.sort_values(["u", "p", "t"], ascending=[True, False, True])
    d["pos"] = d.groupby("u").cumcount()
    n = d.groupby("u")["t"].transform("size")
    keep = d["pos"] <= config.CUT_PERCENT * n // 100
    return keep[d["y"] == 1].sort_index()


def importance(rows: pd.DataFrame, units: pd.DataFrame) -> pd.DataFrame:
    """Grouped permutation importance: how much the share of failing tests inside their
    unit's 25% cut drops when one signal's columns are shuffled together (a change-level
    signal between changes), for the model fit before the last IMPORTANCE_WEEKS evaluation
    weeks, on those weeks' units (every candidate). The interval bootstraps units."""
    last = weeks()[-IMPORTANCE_WEEKS]
    model = fit_ensemble(training_rows(rows, units, last - config.TRAIN_GAP_DAYS * DAY))
    ids = units[(units["time"] >= last) & units["train_ok"]]["unit_id"]
    test = rows[rows["unit_id"].isin(ids)].reset_index(drop=True)
    x = test[list(ENSEMBLE_FEATURES)]
    base = caught_at_cut(test, model.predict_proba(x)[:, 1]).astype(float)
    unit_of = test.loc[base.index, "unit_id"].to_numpy()
    rng = np.random.default_rng(SEED)
    uniq, inverse = np.unique(unit_of, return_inverse=True)
    counts = np.bincount(inverse)
    out = []
    for name, cols in IMPORTANCE_GROUPS.items():
        permuted = np.zeros(len(base))
        for _ in range(IMPORTANCE_REPEATS):
            shuffled = x.copy()
            if name in UNIT_LEVEL:
                per_unit = test.groupby("unit_id")[list(cols)].first()
                donor = pd.Series(per_unit.index.to_numpy()[rng.permutation(len(per_unit))], index=per_unit.index)
                shuffled[list(cols)] = per_unit.loc[donor.loc[test["unit_id"]].to_numpy()].to_numpy()
            else:
                shuffled[list(cols)] = x[list(cols)].to_numpy()[rng.permutation(len(x))]
            permuted += caught_at_cut(test, model.predict_proba(shuffled)[:, 1]).astype(float).to_numpy() / IMPORTANCE_REPEATS
        diffs = np.bincount(inverse, weights=base.to_numpy() - permuted)
        boots = []
        for _ in range(BOOTSTRAP):
            pick = rng.integers(0, len(uniq), len(uniq))
            boots.append(diffs[pick].sum() / counts[pick].sum())
        out.append({"feature": name, "mean": float(diffs.sum() / counts.sum()), "lo": float(np.quantile(boots, 0.025)),
                    "hi": float(np.quantile(boots, 0.975)), "nonzero_share": float((x[list(cols)] != 0).any(axis=1).mean()),
                    "base": float(base.mean()), "rows": len(x), "positives": int(len(base)), "units": int(len(uniq))})
    return pd.DataFrame(out).sort_values("mean", ascending=False)
