"""Fetch step: HUD ClickHouse (read-only) and the pytorch clone (read-only git) into the
cache. PR and commit text is reduced to the test names it mentions here and never kept."""

import hashlib
import json
import logging
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
from torchci.td.analysis import config, gitdata, queries
from torchci.td.analysis.schema import save, write_manifest
from torchci.td.llm import events, pytorch_repo
from torchci.td.llm.events_sql import E2_SQL
from torchci.td.llm.replay import cut_applied


logger = logging.getLogger(__name__)

LINK_RE = (re.compile(r"#(\d+)"), re.compile(r"/pytorch/pytorch/.*/(\d+)"))
BATCH = 500


def ch(name: str, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    rows = events._query(name, sql, params)
    logger.info("%s: %d rows", name, len(rows))
    return rows


def batched(items: list[Any], size: int = BATCH) -> Iterable[list[Any]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def day(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S")


def author_key(login: str, salt: str) -> str:
    digest = hashlib.blake2b(
        login.lower().encode(), key=salt.encode(), digest_size=config.AUTHOR_HASH_BYTES
    )
    return digest.hexdigest() if login else ""


def universe(repo: Path, cache: Path) -> pd.DataFrame:
    rows = []
    month = config.MAIN_START.replace(day=1)
    while month < config.WINDOW_STOP:
        snap = pytorch_repo.snapshot(repo, cache / "corpus", month.strftime("%Y-%m"))
        rows.append(
            {
                "month": month.strftime("%Y-%m"),
                "commit": snap.commit,
                "tests": sorted(snap.tests),
            }
        )
        month = (month + timedelta(days=32)).replace(day=1)
    return pd.DataFrame(rows)


def mentioned_tests(text: str, tests: list[str]) -> list[str]:
    """MentionedInPR: a test is mentioned when its name is a substring of the text."""
    return [t for t in tests if t in text]


def linked_numbers(text: str) -> set[int]:
    return {int(n) for pattern in LINK_RE for n in pattern.findall(text)}


def bodies(numbers: set[int]) -> dict[int, str]:
    out: dict[int, str] = {}
    for sql, name in ((queries.ISSUE_TEXT, "issues"), (queries.PR_TEXT, "prs")):
        for batch in batched(sorted(numbers), 2000):
            for r in ch(name, sql, {"numbers": batch}):
                out.setdefault(int(r["number"]), r["body"] or "")
    return out


def mentions(texts: dict[Any, str], tests: list[str]) -> dict[Any, list[str]]:
    """Each text plus the bodies of the issues and PRs it links (depth 1, as pytorch's
    MentionedInPR follows them), reduced to the tests they name."""
    links = {k: linked_numbers(t) for k, t in texts.items()}
    linked = bodies(set().union(*links.values())) if links else {}
    return {
        k: sorted(
            set(
                mentioned_tests(
                    t + "\n" + "\n".join(linked.get(n, "") for n in links[k]), tests
                )
            )
        )
        for k, t in texts.items()
    }


def pushes() -> pd.DataFrame:
    rows = ch(
        "pushes",
        queries.MAIN_PUSHES,
        {
            "start": day(config.MAIN_START - timedelta(days=21)),
            "stop": day(config.WINDOW_STOP),
        },
    )
    df = pd.DataFrame(rows).drop_duplicates("push_sha")
    df["pushed_at"] = df["pushed_at"].astype(int)
    return df.sort_values("pushed_at").reset_index(drop=True)


def main_jobs(push_shas: list[str]) -> tuple[pd.DataFrame, pd.DataFrame]:
    jobs = [
        r
        for b in batched(push_shas)
        for r in ch("main_jobs", queries.MAIN_JOBS, {"shas": b})
    ]
    jobs_df = pd.DataFrame(jobs).drop_duplicates("job_id")
    failed = jobs_df[jobs_df["conclusion"] == "failure"]
    files = [
        r
        for b in batched(failed["job_id"].astype(int).tolist(), 2000)
        for r in ch("failed_files", queries.FAILED_FILES, {"job_ids": b})
    ]
    fail = pd.DataFrame(files, columns=["job_id", "file"]).merge(
        failed[
            [
                "job_id",
                "push_sha",
                "workflow",
                "build_environment",
                "test_config",
                "completed_at",
            ]
        ],
        on="job_id",
    )
    return jobs_df, fail


def fail_history() -> pd.DataFrame:
    rows = []
    start = config.HISTORY_START
    while start < config.WINDOW_STOP:
        stop = min(start + timedelta(days=7), config.WINDOW_STOP)
        rows += ch(
            "fail_history",
            queries.FAIL_HISTORY,
            {"start": day(start), "stop": day(stop)},
        )
        start = stop
    df = pd.DataFrame(rows)
    return df.groupby(["head_sha", "file"], as_index=False)["ts"].min()


def merge_bases(shas: set[str]) -> pd.DataFrame:
    rows = [
        r
        for b in batched(sorted(shas), 2000)
        for r in ch("merge_bases", queries.MERGE_BASES, {"shas": b})
    ]
    return pd.DataFrame(rows, columns=["sha", "merge_base", "changed_files"])


def gold(push_df: pd.DataFrame) -> pd.DataFrame:
    rows_e1 = events.fetch_e1(config.WINDOW_START, config.WINDOW_STOP)
    e1 = events.parse_e1(rows_e1)
    by_push = dict(zip(push_df["push_sha"], push_df["commit_shas"]))
    raw = {r["landing_sha"]: r for r in rows_e1 if r.get("grain") == "event"}
    rows = []
    for e in e1:
        rows.append(
            {
                "landing_sha": e.landing_sha,
                "landed_at": e.landed_at,
                "stack_size": e.stack_size,
                "outcome": e.outcome,
                "test_files": e.test_files,
                "test_outcomes": list(
                    raw.get(e.landing_sha, {}).get("test_outcomes", [])
                ),
                "test_file_list": list(
                    raw.get(e.landing_sha, {}).get("test_files", [])
                ),
                "window_closed": bool(
                    int(raw.get(e.landing_sha, {}).get("window_closed", 0))
                ),
                "commit_shas": list(by_push.get(e.landing_sha, [e.landing_sha])),
            }
        )
    return pd.DataFrame(rows)


def pr_failures() -> pd.DataFrame:
    """E2 (first failing row per (PR, file), PR-specific) joined with the first TD-off row
    and the job and head counts."""
    start, stop = config.WINDOW_START, config.WINDOW_STOP
    window = {"start": events._ch_time(start), "stop": events._ch_time(stop)}
    e2 = events.parse_e2(
        ch("e2", E2_SQL, {**window, "main_window": events.MAIN_WINDOW_SECONDS})
    )
    extra = {
        (int(r["pr_number"]), r["test_file"]): r
        for r in ch("pr_fail_extra", queries.PR_FAIL_EXTRA, window)
    }
    rows = []
    for e in e2:
        x = extra.get((e.pr_number, e.test_file), {})
        base = {
            "pr_number": e.pr_number,
            "file": e.test_file,
            "base_sha": e.base_sha,
            "n_jobs": int(x.get("n_jobs", 1)),
            "n_heads": int(x.get("n_heads", 1)),
        }
        r = e.row
        rows.append(
            {
                **base,
                "kind": "first",
                "head_sha": e.head_sha,
                "failed_at": e.failed_at,
                "td_off": not cut_applied(r),
                "run_id": r.run_id,
                "job_id": r.job_id,
                "workflow": r.workflow,
                "build_environment": r.build_environment,
                "test_config": r.test_config,
                "position": r.position,
                "n": len(r.all_scores),
                "all_scores": r.all_scores,
            }
        )
        off = x.get("off")
        if off and int(off[1]) > 0:
            scores = json.loads(off[8]) if isinstance(off[8], str) else off[8]
            rows.append(
                {
                    **base,
                    "kind": "first_off",
                    "head_sha": off[5],
                    "failed_at": events._ts(x["off_failed_at"]),
                    "td_off": True,
                    "run_id": int(off[0]),
                    "job_id": int(off[1]),
                    "workflow": off[2],
                    "build_environment": off[3],
                    "test_config": off[4],
                    "position": int(off[6]),
                    "n": len(scores),
                    "all_scores": {str(k): float(v) for k, v in scores.items()},
                }
            )
    return pd.DataFrame(rows)


def run_evidence(pr_fail: pd.DataFrame) -> pd.DataFrame:
    """For each TD-off PR unit (head, env, config), the test files that ran in any of the
    config's jobs at that head."""
    off = pr_fail[pr_fail["kind"] == "first_off"].drop_duplicates(
        ["pr_number", "head_sha", "build_environment", "test_config"]
    )
    heads = sorted(set(off["head_sha"]))
    jobs = pd.DataFrame(
        [
            r
            for b in batched(heads)
            for r in ch("head_jobs", queries.HEAD_JOBS, {"shas": b})
        ]
    ).drop_duplicates("job_id")
    jobs = jobs.merge(
        off[["pr_number", "head_sha", "build_environment", "test_config", "failed_at"]],
        on=["head_sha", "build_environment", "test_config"],
    )
    ran: dict[int, list[str]] = {}
    jobs["day"] = jobs["failed_at"].str[:10]
    for d, grp in jobs.groupby("day"):
        lo = datetime.fromisoformat(d) - timedelta(days=2)
        for b in batched(sorted(set(grp["job_id"].astype(int))), 200):
            for r in ch(
                "ran_files",
                queries.RAN_FILES,
                {"job_ids": b, "start": day(lo), "stop": day(lo + timedelta(days=5))},
            ):
                ran[int(r["job_id"])] = list(r["ran"])
    jobs["ran"] = jobs["job_id"].astype(int).map(ran)
    jobs = jobs.dropna(subset=["ran"])
    out = (
        jobs.groupby(["pr_number", "head_sha", "build_environment", "test_config"])[
            "ran"
        ]
        .agg(lambda xs: sorted(set().union(*map(set, xs))))
        .reset_index()
    )
    return out


def run(cache: Path, repo: Path, salt: str) -> None:
    uni = universe(repo, cache)
    all_tests = sorted(set().union(*map(set, uni["tests"])))
    push_df = pushes()
    commits = gitdata.commits(repo, push_df)
    texts = gitdata.messages(repo, commits["sha"].tolist())
    commit_mentions = mentions(texts, all_tests)
    commits["mentioned"] = commits["sha"].map(lambda s: commit_mentions.get(s, []))
    jobs_df, fail = main_jobs(push_df["push_sha"].tolist())
    gold_df = gold(push_df)
    pr_fail = pr_failures()
    ran = run_evidence(pr_fail)
    pr_numbers = sorted(set(pr_fail["pr_number"]) | set(commits["pr_number"]) - {0})
    pr_rows = {
        n: r
        for b in batched(pr_numbers, 2000)
        for r in ch("pr_text", queries.PR_TEXT, {"numbers": b})
        for n in [int(r["number"])]
    }
    pr_mentions = mentions({n: r["body"] or "" for n, r in pr_rows.items()}, all_tests)
    pr_meta = pd.DataFrame(
        [
            {
                "pr_number": n,
                "author_key": author_key(r["login"] or "", salt),
                "mentioned": pr_mentions[n],
            }
            for n, r in pr_rows.items()
        ],
        columns=["pr_number", "author_key", "mentioned"],
    )
    login = {n: author_key(r["login"] or "", salt) for n, r in pr_rows.items()}
    commits["author_key"] = commits["pr_number"].map(lambda n: login.get(n, ""))
    history = fail_history()
    mb = merge_bases(
        set(history["head_sha"]) | set(pr_fail["head_sha"]) | set(commits["sha"])
    )
    tables = {
        "universe": uni,
        "commits": commits,
        "main_jobs": jobs_df,
        "main_fail": fail,
        "gold": gold_df,
        "pr_fail": pr_fail,
        "pr_ran": ran,
        "pr_meta": pr_meta,
        "fail_history": history,
        "merge_bases": mb,
        "pushes": push_df,
    }
    for name, df in tables.items():
        save(cache, "fetch", name, df)
    write_manifest(
        cache,
        "fetch",
        tables,
        window=[day(config.WINDOW_START), day(config.WINDOW_STOP)],
        main_window=[day(config.MAIN_START), day(config.WINDOW_STOP)],
    )
