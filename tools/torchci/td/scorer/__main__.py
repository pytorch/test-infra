"""`refit`: build the labels and rows, train a twin before the gate's slice and gate it
against TD and the live model, then train the model on everything and write it when the
gate passes. `check`: the published model's staleness, and the pytorch side's fallback
rate. `check` imports nothing outside the stdlib but torchci.clickhouse (with
--metrics): the daily job installs only clickhouse-connect and runs from tools/."""

import argparse
import json
import logging
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from torchci.td.scorer import gate, model_json, spec
from torchci.td.scorer.report import (
    gate_record,
    REPORT_FILE,
    SUMMARY_FILE,
    write_report,
)


logger = logging.getLogger(__name__)

SETTLE_DAYS = 3
# The label builder skips PR units for a window starting more than
# labels.queries.PR_LOOK_BACK_DAYS ago; the window also ends SETTLE_DAYS ago.
DEFAULT_DAYS = 360
FULL_DAYS = 56
# OpenMP's default thread count makes the tree fits far slower on hosts with many cores.
MAX_FIT_THREADS = 16
MAX_MODEL_BYTES = 5 * 1024 * 1024
FETCH_TIMEOUT_SECONDS = 30
METRIC_HOURS = 24
MAX_FALLBACK_SHARE = 0.10
TOP_REASONS = 5
MAX_REASON_CHARS = 200
# A full sha holds a run of 15 digits about 1% of the time; the model file must hold none.
COMMIT_CHARS = 12
EXIT_OK, EXIT_ERROR, EXIT_CHECK_FAILED, EXIT_NOT_WRITTEN = 0, 1, 2, 3

FALLBACKS = f"""
SELECT JSONExtractString(info, 'fallback') AS fallback, count() AS n
FROM misc.ossci_uploaded_metrics
WHERE metric_name = 'td_scorer' AND repo = 'pytorch/pytorch'
    AND timestamp >= {{start: DateTime64(3)}}
GROUP BY fallback
ORDER BY n DESC
"""


def utc_now(value: Optional[str]) -> datetime:
    return gate.parse_time(value) if value else datetime.now(timezone.utc)


def read_model(source: str) -> Any:
    """The decoded model at a path or http(s) URL (at most MAX_MODEL_BYTES), or the
    exception that stopped it."""
    try:
        if source.startswith(("https://", "http://")):
            with urllib.request.urlopen(source, timeout=FETCH_TIMEOUT_SECONDS) as r:
                data = r.read(MAX_MODEL_BYTES + 1)
        else:
            with open(source, "rb") as f:
                data = f.read(MAX_MODEL_BYTES + 1)
        if len(data) > MAX_MODEL_BYTES:
            raise ValueError(f"{source} is over {MAX_MODEL_BYTES} bytes")
        return json.loads(data)
    except Exception as e:
        logger.warning("cannot read %s: %r", source, e)
        return e


def sanitize(reason: Any) -> str:
    """A metric row's fallback reason (written by PR code) as one inert line: no
    newlines, no workflow command ('::' at a line's start, or the legacy '##[' the
    runner matches anywhere in a line), at most MAX_REASON_CHARS characters."""
    line = " ".join(str(reason).split()).replace("::", ": ").replace("##[", "# [")
    return line[:MAX_REASON_CHARS]


def fallback_rows(now: datetime) -> list[dict[str, Any]]:
    from torchci.clickhouse import query_clickhouse
    from torchci.td.llm.events_sql import SETTINGS

    start = (now - timedelta(hours=METRIC_HOURS)).strftime("%Y-%m-%d %H:%M:%S")
    return query_clickhouse(FALLBACKS + SETTINGS, {"start": start})


def check(args: argparse.Namespace) -> int:
    now = utc_now(args.now)
    status, reasons = gate.staleness(read_model(args.model), now)
    print(f"td_scorer.json: {status}")
    for reason in reasons:
        print(f"- {reason}")
    failed = status not in (gate.OK, gate.DISABLED)
    if args.metrics and status in (gate.OK, gate.STALE):
        rows = fallback_rows(now)
        total = sum(int(r["n"]) for r in rows)
        fell_back = [r for r in rows if r["fallback"]]
        n_fallback = sum(int(r["n"]) for r in fell_back)
        if not total:
            print(f"- note: no td_scorer metric rows in the last {METRIC_HOURS} h")
        else:
            share = n_fallback / total
            print(f"- {n_fallback} of {total} TD runs fell back ({share:.1%})")
            for r in fell_back[:TOP_REASONS]:
                print(f"  - {r['n']}: {sanitize(r['fallback'])}")
            if share > MAX_FALLBACK_SHARE:
                print(f"- FAIL: more than {MAX_FALLBACK_SHARE:.0%} fell back")
                failed = True
    return EXIT_CHECK_FAILED if failed else EXIT_OK


def prepare(
    args: argparse.Namespace,
    units_dir: Path,
    start: datetime,
    stop: datetime,
    full_from: datetime,
) -> Optional[dict[str, dict[str, float]]]:
    """Fetches the commits the selected units need (with --fetch) and returns their
    llm_n (None with --no-llm). The units are chosen as features.build chooses them."""
    from torchci.td.scorer import context, features, llm

    if args.no_llm and not args.fetch:
        return None
    units, months = context.read_labels(units_dir)
    units = features.selected_units(context.window_units(units, start, stop), full_from)
    pr_meta = context.fetch_pr_meta(units)
    if args.fetch:
        missing = context.fetch_commits(
            args.pytorch, context.needed_commits(units, pr_meta)
        )
        logger.info("%d commits still absent after the fetch", len(missing))
    if args.no_llm:
        return None
    work = args.out / "llm"
    return llm.scores(
        units,
        llm.unit_diffs(
            units, args.pytorch, context.pr_bases(units, args.pytorch, pr_meta)
        ),
        lambda unit: context.unit_tests(unit, months),
        llm.download_bundle(work),
        args.threads,
        args.llm_cache or work / "cache",
        work,
    )


def load_live(path: str) -> tuple[Optional[dict[str, Any]], bool, Optional[str]]:
    """(the live model or None, whether it is disabled, why it is not used)."""
    if not path:
        return None, False, "no live model"
    doc = read_model(path)
    if not isinstance(doc, dict):
        return None, False, f"live model unreadable: {doc}"
    try:
        model_json.validate(doc)
        gate.parse_time(doc.get("data_through"))
    except model_json.ModelDisabled:
        return None, True, "the live model is disabled"
    except (model_json.InvalidModel, ValueError) as e:
        return None, False, f"live model invalid: {e}"
    return doc, False, None


def refit(args: argparse.Namespace) -> int:
    from threadpoolctl import threadpool_limits
    from torchci.td import labels
    from torchci.td.labels.queries import PR_LOOK_BACK_DAYS
    from torchci.td.labels.schema import epoch
    from torchci.td.scorer import evaluate, features, pathrisk, train

    now = utc_now(args.now)
    cutoff = (now - timedelta(days=SETTLE_DAYS)).replace(
        hour=0, minute=0, second=0, microsecond=0, tzinfo=None
    )
    start = cutoff - timedelta(days=args.days)
    full_from = cutoff - timedelta(days=FULL_DAYS)
    look_back = now.replace(tzinfo=None) - timedelta(days=PR_LOOK_BACK_DAYS)
    if start < look_back:
        raise ValueError(
            f"--days {args.days}: the window starts {start:%Y-%m-%d}, before the label"
            f" builder's {PR_LOOK_BACK_DAYS}-day PR look-back ({look_back:%Y-%m-%d}),"
            " which would drop every PR unit"
        )
    out: dict[str, Any] = {"now": now.isoformat(), "window": [str(start), str(cutoff)]}
    units_dir = args.units_dir or args.out / "labels"
    if not args.units_dir:
        out["labels"] = labels.build(
            start, cutoff, args.pytorch, units_dir, now=now.replace(tzinfo=None)
        )
    llm = prepare(args, units_dir, start, cutoff, full_from)
    history = pathrisk.History.load(args.pytorch, epoch(start))
    rows, units = features.build(
        units_dir,
        args.pytorch,
        features.load_stats(args.stats_dir),
        start,
        cutoff,
        full_from,
        llm=llm,
        procs=args.procs,
        history=history,
    )
    out["dropped"] = dict(units.attrs.get("dropped", {}))
    live, live_disabled, out["live_note"] = load_live(args.live)
    commit = args.commit[:COMMIT_CHARS] if args.commit else None
    source = {"run_id": args.run_id, "commit": commit}
    trained_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    threads = min(args.threads or MAX_FIT_THREADS, MAX_FIT_THREADS)
    with threadpool_limits(limits=threads):
        out.update(
            evaluate.run_gate(
                rows, units, epoch(cutoff), live, trained_at, source, history
            )
        )
        if live_disabled:
            out["passed"] = False
            out["reasons"].append(gate.FAIL + "the live model is disabled")
        doc = None
        if out["passed"]:
            paths = pathrisk.table(history, epoch(cutoff))
            base = out["budget"]["base"]
            doc = train.fit(
                rows, units, epoch(cutoff), trained_at, source, paths=paths, base=base
            )
            doc["gate"] = train.rounded(gate_record(out))
            out["model_calibrated"] = doc["calibrated"]
    write_report(args.out, train.rounded(out))
    if doc is None:
        return EXIT_NOT_WRITTEN
    text = json.dumps(doc, indent=1, allow_nan=False) + "\n"
    if model_json.validate(json.loads(text)) or model_json.has_digit_run(text):
        raise model_json.InvalidModel("the model to write failed validation")
    size = len(text.encode())
    if size > MAX_MODEL_BYTES:
        raise model_json.InvalidModel(
            f"the model to write is {size} bytes, over {MAX_MODEL_BYTES}"
        )
    (args.out / spec.MODEL_FILE).write_text(text)
    logger.info("wrote %s", args.out / spec.MODEL_FILE)
    return EXIT_OK


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="torchci.td.scorer", description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    r = sub.add_parser("refit", help="train, gate and write td_scorer.json")
    r.add_argument("--pytorch", type=Path, required=True, help="pytorch clone")
    r.add_argument(
        "--stats-dir", type=Path, required=True, help="generated-stats stats/"
    )
    r.add_argument("--live", required=True, help='the live model\'s path, or ""')
    r.add_argument("--out", type=Path, required=True)
    r.add_argument("--now", help="ISO time (default: now)")
    r.add_argument("--days", type=int, default=DEFAULT_DAYS)
    r.add_argument("--procs", type=int, default=6)
    r.add_argument("--threads", type=int)
    r.add_argument("--fetch", action="store_true", help="fetch missing PR heads")
    r.add_argument("--no-llm", action="store_true")
    r.add_argument("--llm-cache", type=Path)
    r.add_argument("--units-dir", type=Path, help="reuse built labels")
    r.add_argument("--run-id", type=int)
    r.add_argument("--commit")
    c = sub.add_parser("check", help="check the published model")
    c.add_argument("--model", required=True, help="path or URL")
    c.add_argument("--now", help="ISO time (default: now)")
    c.add_argument("--metrics", action="store_true", help="also the fallback rate")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    if args.command == "check":
        return check(args)
    try:
        return refit(args)
    except Exception as e:
        logger.exception("refit failed")
        try:
            write_report(args.out, {"error": f"{type(e).__name__}: {e}"})
        except Exception:
            logger.exception("cannot write the report")
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
