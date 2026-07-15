#!/usr/bin/env python3
"""Compare today's wheel-size snapshot against prior snapshot(s) and flag
wheels whose size increased significantly.

Baseline per wheel = median of the provided prior snapshots (robust to daily
jitter). A wheel is flagged when today's size exceeds the baseline by more than
``--pct`` percent OR more than ``--mb`` megabytes. New wheels (no baseline) are
skipped, not flagged.

Example:
    python wheel_size_delta.py --today today.json \\
        --previous-glob 'prev/*.json' --pct 2 --mb 15 --out flagged.json
"""

import argparse
import glob
import json
import statistics


def _load(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--today", required=True, help="today's snapshot JSON")
    ap.add_argument(
        "--previous",
        action="append",
        default=[],
        help="prior snapshot JSON (repeatable)",
    )
    ap.add_argument(
        "--previous-glob", default=None, help="glob matching prior snapshot JSONs"
    )
    ap.add_argument(
        "--pct", type=float, default=2.0, help="flag if increase > this percent"
    )
    ap.add_argument(
        "--mb", type=float, default=15.0, help="or flag if increase > this many MB"
    )
    ap.add_argument("--out", required=True, help="output JSON path (list of flagged)")
    args = ap.parse_args()

    today = _load(args.today)
    prev_paths = list(args.previous)
    if args.previous_glob:
        prev_paths += sorted(glob.glob(args.previous_glob))
    priors = [_load(p) for p in prev_paths]

    flagged = []
    for key, cur in today.items():
        cur_bytes = cur["bytes"]
        base_vals = [p[key]["bytes"] for p in priors if key in p]
        if not base_vals:
            continue  # new wheel — no baseline to compare against
        baseline = statistics.median(base_vals)
        if baseline <= 0:
            continue
        mb_delta = (cur_bytes - baseline) / 1024 / 1024
        pct = (cur_bytes - baseline) / baseline * 100
        if pct > args.pct or mb_delta > args.mb:
            flagged.append(
                {
                    "key": key,
                    "name": cur.get("name"),
                    "url": cur.get("url"),
                    "today_mb": round(cur_bytes / 1024 / 1024, 2),
                    "baseline_mb": round(baseline / 1024 / 1024, 2),
                    "mb_delta": round(mb_delta, 2),
                    "pct_increase": round(pct, 2),
                    "baseline_samples": len(base_vals),
                }
            )

    flagged.sort(key=lambda x: x["pct_increase"], reverse=True)
    with open(args.out, "w") as f:
        json.dump(flagged, f, indent=2)
    print(f"Flagged {len(flagged)} wheel(s) with significant size increase")


if __name__ == "__main__":
    main()
