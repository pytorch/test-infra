"""Per-unit context for the scorer's rows, from torchci.td.labels' units, HUD ClickHouse
(read-only) and a pytorch clone (read-only git, history.py and gitdata.py): what each
change touched, the tests its text mentions, the PR's earlier failures, its line
counts, the failure history the ratings are rebuilt from, and which main positives
were fresh. A PR unit is diffed as TD diffs it: against its merge base with the PR's
own base (for ghstack, its gh/<user>/<n>/base branch), not with main.

A unit's cutoff is the time no input of its rows may reach: a main unit's push, or the
start of the PR unit's workflow run (TD ranks a run's tests before its test jobs, so
the PR's later failures were unknown to it). Commit and PR texts are reduced to the
test names they mention and never kept."""

import gzip
import json
import logging
import math
import re
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from torchci.td.labels import CANDIDATES_FILE, queries as label_queries, UNITS_FILE
from torchci.td.labels.schema import epoch, MAIN, month_of, PR_TD_OFF
from torchci.td.llm import pytorch_repo
from torchci.td.llm.diff import SHA_RE
from torchci.td.scorer import gitdata, history, queries


logger = logging.getLogger(__name__)

KINDS = (MAIN, PR_TD_OFF)
# pytorch's MentionedInPR follows these links one level deep; a text's links beyond
# MAX_LINKS are not read.
LINK_RES = (re.compile(r"#(\d+)"), re.compile(r"/pytorch/pytorch/.*/(\d+)"))
MAX_LINKS = 50
BATCH = 2000

UnitContext = dict[str, Any]


@dataclass
class Context:
    """Per unit id the inputs of its rows, plus the failure history and merge bases
    the daily failure ratings need, and when the fetched history and PR failures start
    (unix seconds; None when nothing was fetched)."""

    units: dict[str, UnitContext]
    history: list[dict[str, Any]]
    merge_bases: dict[str, dict[str, Any]]
    dropped: Counter = field(default_factory=Counter)
    history_start: Optional[int] = None
    pr_failures_start: Optional[int] = None


def read_jsonl_gz(path: Path) -> list[dict[str, Any]]:
    with gzip.open(path, "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def read_labels(units_dir: Path) -> tuple[list[dict[str, Any]], dict[str, list[str]]]:
    """The units of a torchci.td.labels output, and each month's test list."""
    units = read_jsonl_gz(units_dir / UNITS_FILE)
    months = {
        c["month"]: c["tests"] for c in read_jsonl_gz(units_dir / CANDIDATES_FILE)
    }
    return units, months


def window_units(
    units: list[dict[str, Any]], start: datetime, stop: datetime
) -> list[dict[str, Any]]:
    """The main and pr_td_off units in [start, stop) (explored units are skipped)."""
    w0, w1 = epoch(start), epoch(stop)
    return [u for u in units if u["kind"] in KINDS and w0 <= int(u["time"]) < w1]


def unit_tests(u: dict[str, Any], months: dict[str, list[str]]) -> list[str]:
    """The tests TD ranked for the unit: its month's list plus the job's own list."""
    month = months.get(month_of(int(u["time"])), [])
    return sorted(set(month) | set(u["candidates"] or []))


def linked_numbers(text: str) -> list[int]:
    """The issue and PR numbers a text links, in MentionedInPR's order, the first
    MAX_LINKS of them."""
    found = [int(n) for pattern in LINK_RES for n in pattern.findall(text)]
    return list(dict.fromkeys(found))[:MAX_LINKS]


def mentioned_tests(text: str, tests: Iterable[str]) -> list[str]:
    """MentionedInPR: a test is mentioned when its name is a substring of the text."""
    return sorted({t for t in tests if t in text})


def fetch_bodies(numbers: Iterable[int]) -> dict[int, str]:
    """Issue and PR bodies by number (an issue's when both exist)."""
    out: dict[int, str] = {}
    for name, sql in (("issue_text", queries.ISSUE_TEXT), ("pr_meta", queries.PR_META)):
        for batch in label_queries.batched(sorted(set(numbers)), BATCH):
            for r in label_queries.ch(name, sql, {"numbers": batch}):
                out.setdefault(int(r["number"]), r["body"] or "")
    return out


def mentions(
    texts: Mapping[str, str], tests: Mapping[str, Iterable[str]]
) -> dict[str, list[str]]:
    """Per key, the tests its text or the bodies of the issues and PRs it links name."""
    links = {k: linked_numbers(t) for k, t in texts.items()}
    linked = fetch_bodies({n for ns in links.values() for n in ns}) if links else {}
    return {
        k: mentioned_tests(
            "\n".join([t, *(linked.get(n, "") for n in links[k])]), tests[k]
        )
        for k, t in texts.items()
    }


def fetch_pr_meta(units: list[dict[str, Any]]) -> dict[int, dict[str, str]]:
    """Per PR of the pr_td_off units: its body and its base branch's ref and sha."""
    numbers = {int(u["pr_number"]) for u in units if u["kind"] == PR_TD_OFF}
    out = {}
    for batch in label_queries.batched(sorted(numbers), BATCH):
        for r in label_queries.ch("pr_meta", queries.PR_META, {"numbers": batch}):
            out[int(r["number"])] = {
                k: r[k] or "" for k in ("body", "base_sha", "base_ref")
            }
    return out


def needed_commits(
    units: list[dict[str, Any]], pr_meta: dict[int, dict[str, str]]
) -> list[str]:
    """The commits the clone needs: every unit's own and its PR's base sha."""
    shas = {u["sha"] for u in units}
    for u in units:
        if u["kind"] == PR_TD_OFF:
            shas.add(pr_meta.get(int(u["pr_number"]), {}).get("base_sha", ""))
    return sorted(s for s in shas if s and SHA_RE.match(s))


def fetch_commits(repo: Path, shas: Iterable[str]) -> set[str]:
    """Fetches the absent commits by sha from the clone's origin (the clone must be one
    that may be written to); returns those still absent."""
    absent, _ = pytorch_repo.fetch_missing(repo, {s for s in shas if SHA_RE.match(s)})
    return absent


def pr_bases(
    units: list[dict[str, Any]],
    repo: Path,
    pr_meta: dict[int, dict[str, str]],
    dropped: Optional[Counter] = None,
) -> dict[str, str]:
    """Per pr_td_off unit whose head the clone has, the merge base TD diffs it against:
    with its PR's base sha (`git merge-base <base sha> <head>`), else, when that sha is
    unknown or absent (counted), with the clone's main."""
    dropped = Counter() if dropped is None else dropped
    prs = [u for u in units if u["kind"] == PR_TD_OFF]
    base_of = {
        u["unit_id"]: pr_meta.get(int(u["pr_number"]), {}).get("base_sha", "")
        for u in prs
    }
    revs = sorted({u["sha"] for u in prs} | set(base_of.values()))
    have = pytorch_repo.present(repo, [r for r in revs if r and SHA_RE.match(r)])
    main = gitdata.main_ref(repo) if prs else None
    out = {}
    for u in prs:
        if u["sha"] not in have:
            dropped["pr_td_off:no_head"] += 1
            continue
        base = base_of[u["unit_id"]]
        found = gitdata.merge_base(repo, base, u["sha"]) if base in have else None
        if found is None and main is not None:
            dropped["pr_td_off:base_main_fallback"] += 1
            found = gitdata.merge_base(repo, main, u["sha"])
        if found is None:
            dropped["pr_td_off:no_base"] += 1
            continue
        out[u["unit_id"]] = found
    return out


def build(
    units: list[dict[str, Any]],
    months: dict[str, list[str]],
    repo: Path,
    start: datetime,
    stop: datetime,
) -> Context:
    """The context of every main and pr_td_off unit. A main unit whose commit the clone
    lacks and a PR unit without a head or base in it are dropped (counted). A main
    unit's earlier failures are those of the PR it landed, in any workflow; a PR unit's
    those of its PR's runs of its own workflow."""
    dropped: Counter = Counter()
    main = [u for u in units if u["kind"] == MAIN]
    prs = [u for u in units if u["kind"] == PR_TD_OFF]
    commits = gitdata.main_commits(repo, [u["sha"] for u in main])
    meta = fetch_pr_meta(prs)
    bases = pr_bases(prs, repo, meta, dropped)
    starts = history.run_starts([u["sha"] for u in prs]) if prs else {}
    by_pr = history.pr_failures(start, stop) if units else {}
    rows = history.fetch_history(start, stop)
    merge_bases = history.fetch_merge_bases({r["head_sha"] for r in rows})
    out: dict[str, UnitContext] = {}
    texts: dict[str, str] = {}
    tests: dict[str, set[str]] = {}
    for u in main:
        c = commits.get(u["sha"])
        if c is None:
            dropped["main:no_commit"] += 1
            continue
        t, pr = int(u["time"]), int(u["pr_number"] or 0)
        out[u["unit_id"]] = {
            "cutoff": t,
            "changed": c["files"],
            "prev_failed": history.prev_failed(by_pr.get(pr, []), None, t),
            "sig_added": float(c["sig_added"]),
            "sig_deleted": float(c["sig_deleted"]),
        }
        texts[u["unit_id"]] = c.get("message", "")
        tests[u["unit_id"]] = set(unit_tests(u, months))
    for u in prs:
        if u["unit_id"] not in bases:
            continue
        try:
            changed, log = gitdata.pr_change(repo, bases[u["unit_id"]], u["sha"])
        except subprocess.SubprocessError as e:
            logger.warning("git diff of %s failed: %r", u["unit_id"], e)
            dropped["pr_td_off:no_diff"] += 1
            continue
        pr, cutoff = int(u["pr_number"]), history.pr_cutoff(u, starts)
        out[u["unit_id"]] = {
            "cutoff": cutoff,
            "changed": changed,
            "prev_failed": history.prev_failed(
                by_pr.get(pr, []), u["workflow"], cutoff
            ),
            "sig_added": math.nan,
            "sig_deleted": math.nan,
        }
        texts[u["unit_id"]] = log
        tests[u["unit_id"]] = set(unit_tests(u, months))
        texts[f"pr:{pr}"] = meta.get(pr, {}).get("body", "")
        tests.setdefault(f"pr:{pr}", set()).update(tests[u["unit_id"]])
    found = mentions(texts, tests)
    positive = {
        u["unit_id"]: int(u["time"])
        for u in main
        if u["unit_id"] in out and u["positives"]
    }
    fails = history.main_failure_times(list(positive.values())) if positive else {}
    for u in units:
        c = out.get(u["unit_id"])
        if c is None:
            continue
        is_pr = u["kind"] == PR_TD_OFF
        body = set(found.get(f"pr:{u['pr_number']}", [])) if is_pr else set()
        c["mentioned"] = sorted(set(found[u["unit_id"]]) | body & tests[u["unit_id"]])
        pushed = positive.get(u["unit_id"])
        c["fresh"] = (
            history.fresh(u["positives"], pushed, fails) if pushed is not None else []
        )
    first_failure = min((f[0] for v in by_pr.values() for f in v), default=None)
    first_row = min((r["ts"] for r in rows), default=None)
    logger.info("context: %d units, dropped %s", len(out), dict(dropped))
    return Context(out, rows, merge_bases, dropped, first_row, first_failure)
