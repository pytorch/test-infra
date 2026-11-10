"""The gate's calibration check: mean p against the observed rate on landed changes,
with a reliability table."""

from typing import Any, Optional

import numpy as np
import pandas as pd
from torchci.td.labels.schema import DAY
from torchci.td.scorer import train


CALIBRATION_DAYS = 56
MIN_CALIBRATION_POSITIVES = 20
RELIABILITY_BINS = 10


def calibration(p: np.ndarray, y: np.ndarray) -> Optional[dict[str, Any]]:
    """mean(p) / mean(y), Brier, the base rate and a reliability table of
    RELIABILITY_BINS equal-count bins by p; None below MIN_CALIBRATION_POSITIVES."""
    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=float)
    if y.sum() < MIN_CALIBRATION_POSITIVES:
        return None
    order = np.argsort(p, kind="stable")
    bins = [
        {"n": len(b), "mean_p": float(p[b].mean()), "observed": float(y[b].mean())}
        for b in np.array_split(order, RELIABILITY_BINS)
        if len(b)
    ]
    return {
        "ratio": float(p.mean() / y.mean()),
        "brier": float(np.mean((p - y) ** 2)),
        "base_rate": float(y.mean()),
        "mean_p": float(p.mean()),
        "rows": len(p),
        "positives": int(y.sum()),
        "reliability": bins,
    }


def calibration_rows(
    rows: pd.DataFrame, units: pd.DataFrame, stop: int
) -> pd.DataFrame:
    """Full rows of landed `train_ok` changes in the CALIBRATION_DAYS before `stop`."""
    ids = train.landed_units(units, stop - CALIBRATION_DAYS * DAY, stop)["unit_id"]
    keep = rows["unit_id"].isin(ids) & rows["full"].astype(bool) & rows["y"].notna()
    return rows[keep]
