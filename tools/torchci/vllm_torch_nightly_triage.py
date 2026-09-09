"""Detect vLLM CI regressions caused by PyTorch nightly.

The vLLM Buildkite pipeline runs three scheduled builds on ``main``, all from the
same ``HEAD``:

===========================  ======================  =========================
schedule (America/LA)        build message           distinguishing env
===========================  ======================  =========================
``0 23 * * 1,2,4``           Full CI run torch       ``TORCH_NIGHTLY=1``
                             nightly
``0 23 * * *``               Full CI run - nightly   (none)
``0 14 * * *``               Full CI run - daily     (none)
===========================  ======================  =========================

The baseline is the plain nightly from the *same UTC day*, differing only by
``TORCH_NIGHTLY=1``. When both fire in the same cron slot they also share a
commit and the pair is a controlled A/B; otherwise the comparison is
day-over-day and a regression may instead come from vLLM commits landing
between the builds. Reports state which case they are.

This script finds the most recent such pair and reports the delta. It reads only
job metadata from ClickHouse -- log *contents* are not ingested (the tables carry
``log_url`` pointers only), so this identifies *which* jobs regressed and groups
them, but not *why*. Root-causing means reading the linked logs.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from torchci.clickhouse import get_clickhouse_client
from torchci.vllm_log_parser import (
    FailedTest,
    get_test_signature,
    parse_log,
    strip_markers,
)


VLLM_REPO = "https://github.com/vllm-project/vllm.git"
PIPELINE = "CI"

TORCH_NIGHTLY_MSG = "Full CI run torch nightly"
# The plain nightly is the pinned-torch counterpart of the torch-nightly build;
# the daily is the fallback when a day has no plain nightly.
BASELINE_MSGS = ("Full CI run - nightly", "Full CI run - daily")

BAD_STATES = ("failed", "timed_out")

# Must stay in the same order as the SELECT in get_rows() -- ClickHouse returns
# positional tuples that compare() unpacks by position and write_compare_rows()
# zips against these names. Reorder or add a column in one place, change all three.
COMPARE_ROW_COLUMNS = (
    "job_name",
    "shard",
    "tn_state",
    "tn_exit",
    "tn_url",
    "tn_agent",
    "base_state",
    "base_url",
    "in_tn",
    "in_base",
)

# Job names are frequently sharded ("Multi-Modal Processor (CPU) 1..4") or
# parameterised by hardware ("Fusion E2E TP2 (B200)"). Collapsing those into one
# cluster keeps a single root cause from looking like N independent regressions.
_SHARD_SUFFIX = re.compile(r"\s+\d+$")
_PAREN_QUALIFIER = re.compile(r"\s*\([^)]*\)\s*$")


# torch nightly wheels are versioned 2.<minor>.0.dev<YYYYMMDD>+cu<nnn>. Only some
# jobs install torch verbosely enough to print it, and the line is in the install
# preamble that the log tail drops -- so this is scanned against the full body, and
# the caller must treat "not found" as normal rather than exceptional.
_TORCH_VERSION = re.compile(r"\b(2\.\d+\.\d+\.dev\d{8}(?:\+cu\d+)?)\b")


def cluster_key(job_name: str) -> str:
    """Collapse shard indices and trailing hardware qualifiers."""
    name = _SHARD_SUFFIX.sub("", job_name.strip())
    name = _PAREN_QUALIFIER.sub("", name)
    return name.strip() or job_name.strip()


def _rows(client: Any, query: str, params: Dict[str, Any]) -> List[Tuple]:
    return client.query(query, parameters=params).result_rows


@dataclass
class DiffResult:
    """Failing-test diff between the torch-nightly and baseline logs.

    Keyed on (test_id, exception_class); the exception_chain is never compared,
    only recorded for the root-cause agent.

    Attributes:
        new_failures: Failures on torch-nightly only (definitely new).
        shared_failures: (nightly, baseline) pairs sharing a signature.
        skipped: Reason the diff is unusable, or "" when usable.
    """

    new_failures: List[FailedTest] = field(default_factory=list)
    shared_failures: List[Tuple[FailedTest, FailedTest]] = field(default_factory=list)
    skipped: str = ""


def all_failures(parsed) -> List[FailedTest]:
    return [
        failure
        for pytest_result in parsed.pytest_results
        for failure in pytest_result.test_failures
    ]


def diff_failing_tests(torch_nightly_body: str, baseline_body: str) -> DiffResult:
    """Diff the failing-test signatures of two same-commit job logs.

    Baseline-only failures are ignored; they are not torch-attributable. Fails
    closed: if either side has no pytest session or parsing raises, the result is
    marked skipped and no new failures are emitted.

    Args:
        torch_nightly_body: Raw log body from the torch-nightly job.
        baseline_body: Raw log body from the same-commit baseline job.

    Returns:
        A DiffResult; new_failures is empty when skipped is set.
    """
    try:
        torch_nightly_parsed = parse_log(torch_nightly_body)
        baseline_parsed = parse_log(baseline_body)
    except Exception as exc:  # parser asserts an invariant; never emit on that
        return DiffResult(skipped=f"parse raised: {exc}")

    if not torch_nightly_parsed.pytest_results:
        return DiffResult(skipped="no pytest session in torch-nightly log")
    if not baseline_parsed.pytest_results:
        return DiffResult(skipped="no pytest session in baseline log")

    torch_nightly_failures = all_failures(torch_nightly_parsed)
    baseline_failures = all_failures(baseline_parsed)

    baseline_by_signature = {
        get_test_signature(failure): failure for failure in baseline_failures
    }

    result = DiffResult()
    seen_signatures = set()
    for failure in torch_nightly_failures:
        signature = get_test_signature(failure)
        # A retry pass re-lists the same failure in a second summary block; count
        # each signature once.
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        baseline_match = baseline_by_signature.get(signature)
        if baseline_match is None:
            result.new_failures.append(failure)
        else:
            result.shared_failures.append((failure, baseline_match))
    return result


def find_latest_pair(
    client: Any, lookback_days: int
) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
    """Return (torch_nightly_build, baseline_build) for the newest complete pair.

    The baseline is the scheduled run closest in time on the same UTC day. Returns
    None when no torch-nightly build exists in the window, or when none of them ran
    on a day that also had a baseline (in which case there is nothing to compare
    against and reporting raw failures would be misleading).
    """
    builds = _rows(
        client,
        """
        SELECT
            toUInt32(tupleElement(build, 'number'))              AS number,
            splitByChar('\\n', tupleElement(build, 'message'))[1] AS title,
            tupleElement(build, 'commit')                        AS commit,
            tupleElement(build, 'created_at')                    AS created_at,
            tupleElement(build, 'state')                         AS state,
            tupleElement(build, 'web_url')                       AS url
        FROM vllm.vllm_buildkite_builds FINAL
        WHERE tupleElement(pipeline, 'repository') = {repo: String}
          AND tupleElement(pipeline, 'name') = {pipeline: String}
          AND tupleElement(build, 'branch') = 'main'
          AND tupleElement(build, 'created_at') > now() - INTERVAL {days: UInt64} DAY
        ORDER BY number DESC
        """,
        {"repo": VLLM_REPO, "pipeline": PIPELINE, "days": lookback_days},
    )

    def as_dict(row: Tuple) -> Dict[str, Any]:
        return dict(
            zip(("number", "title", "commit", "created_at", "state", "url"), row)
        )

    parsed = [as_dict(r) for r in builds]
    nightlies = [b for b in parsed if b["title"].startswith(TORCH_NIGHTLY_MSG)]
    if not nightlies:
        return None

    # Walk newest-first rather than taking only nightlies[0]: a torch-nightly build
    # can land on a day with no scheduled baseline at all.
    for target in nightlies:
        candidates = [
            b
            for b in parsed
            if b["title"].startswith(BASELINE_MSGS)
            and b["created_at"].date() == target["created_at"].date()
        ]
        if not candidates:
            continue
        # Plain nightly first, then closest in time.
        candidates.sort(
            key=lambda b: (
                0 if b["title"].startswith(BASELINE_MSGS[0]) else 1,
                abs((b["created_at"] - target["created_at"]).total_seconds()),
            )
        )
        return target, candidates[0]
    return None


def write_compare_rows(rows: List[Tuple], compare_rows_path: str) -> None:
    """Write raw ClickHouse comparison rows to a self-describing JSON artifact.

    Args:
        rows: Direct result of get_rows()'s ClickHouse query.
        compare_rows_path: Destination path for compare-rows.json.
    """
    with open(compare_rows_path, "w") as f:
        json.dump(
            {
                "columns": COMPARE_ROW_COLUMNS,
                "rows": [dict(zip(COMPARE_ROW_COLUMNS, row)) for row in rows],
            },
            f,
            indent=2,
            default=str,
        )


def get_rows(
    client: Any,
    tn_number: int,
    base_number: int,
) -> List[Tuple]:
    """Fetch the raw job-comparison rows for the torch-nightly and baseline builds.

    ``retried`` jobs are excluded: a retried attempt is superseded and counting it
    double-reports. ``soft_failed`` jobs are non-blocking by design.
    """
    # Group by (name, shard), not name alone. Buildkite parallelism gives every
    # shard the same job name, and the shards frequently disagree -- on one measured
    # pair "Kernels Core Operation Test" was passed,passed,failed across 3 shards.
    # Grouping by name alone and picking with any() is nondeterministic: the same
    # immutable data yields a different verdict per run, and state, url and agent
    # can each resolve from a different row. argMax over finished_at makes the pick
    # deterministic (latest attempt wins) and keeps the fields mutually consistent.
    return _rows(
        client,
        """
        SELECT
            tupleElement(job, 'name') AS job_name,
            ifNull(tupleElement(job, 'parallel_group_index'), 0) AS shard,
            argMaxIf(lowerUTF8(tupleElement(job, 'state')),
                     tupleElement(job, 'finished_at'),
                     toUInt32(tupleElement(build, 'number')) = {tn: UInt32}) AS tn_state,
            argMaxIf(tupleElement(job, 'exit_status'),
                     tupleElement(job, 'finished_at'),
                     toUInt32(tupleElement(build, 'number')) = {tn: UInt32}) AS tn_exit,
            argMaxIf(tupleElement(job, 'web_url'),
                     tupleElement(job, 'finished_at'),
                     toUInt32(tupleElement(build, 'number')) = {tn: UInt32}) AS tn_url,
            argMaxIf(tupleElement(tupleElement(job, 'agent'), 'hostname'),
                     tupleElement(job, 'finished_at'),
                     toUInt32(tupleElement(build, 'number')) = {tn: UInt32}) AS tn_agent,
            argMaxIf(lowerUTF8(tupleElement(job, 'state')),
                     tupleElement(job, 'finished_at'),
                     toUInt32(tupleElement(build, 'number')) = {base: UInt32}) AS base_state,
            argMaxIf(tupleElement(job, 'web_url'),
                     tupleElement(job, 'finished_at'),
                     toUInt32(tupleElement(build, 'number')) = {base: UInt32}) AS base_url,
            countIf(toUInt32(tupleElement(build, 'number')) = {tn: UInt32}) AS in_tn,
            countIf(toUInt32(tupleElement(build, 'number')) = {base: UInt32}) AS in_base
        FROM vllm.vllm_buildkite_jobs FINAL
        WHERE toUInt32(tupleElement(build, 'number')) IN ({tn: UInt32}, {base: UInt32})
          AND tupleElement(job, 'soft_failed') = 0
          AND tupleElement(job, 'retried') = 0
          AND tupleElement(job, 'name') != ''
        GROUP BY job_name, shard
        """,
        {"tn": tn_number, "base": base_number},
    )


def compare(rows: List[Tuple]) -> Dict[str, List[Dict]]:
    """Bucket every job by its outcome in the torch-nightly vs baseline build.

    ``rows`` are the positional tuples from get_rows(), unpacked here in the order
    defined by COMPARE_ROW_COLUMNS.
    """

    buckets: Dict[str, List[Dict]] = {
        "regressed": [],
        "both": [],
        "baseline_only": [],
        "unclassified": [],
    }
    for (
        name,
        shard,
        tn_state,
        tn_exit,
        tn_url,
        tn_agent,
        base_state,
        base_url,
        in_tn,
        in_base,
    ) in rows:
        if not in_tn:
            # Only present in the baseline; nothing to say about torch nightly.
            if base_state in BAD_STATES:
                buckets["baseline_only"].append({"name": name, "state": base_state})
            continue
        job = {
            "name": name if shard in (0, None) else f"{name} [shard {shard}]",
            "state": tn_state,
            "exit_status": tn_exit,
            "url": tn_url,
            "agent": tn_agent,
            "baseline_state": base_state,
            "baseline_url": base_url,
        }
        tn_bad = tn_state in BAD_STATES
        if tn_bad and base_state in BAD_STATES:
            buckets["both"].append(job)
        elif tn_bad and base_state == "passed":
            # A regression only means anything against a baseline that actually
            # passed. "Present in the baseline" is not enough: cancelled, skipped
            # and still-running baseline jobs would all score as torch regressions.
            buckets["regressed"].append(job)
        elif base_state in BAD_STATES and not tn_bad:
            buckets["baseline_only"].append(job)
        elif tn_bad:
            # Fails on nightly, but the baseline neither passed nor failed
            buckets["unclassified"].append(job)
    return buckets


def agent_concentration(regressed: List[Dict]) -> List[Tuple[str, int]]:
    """Failures piled onto one host usually mean a sick agent, not a regression."""
    counts: Dict[str, int] = defaultdict(int)
    for job in regressed:
        counts[job.get("agent") or "<unknown>"] += 1
    return sorted(counts.items(), key=lambda kv: -kv[1])


def render_regressed_tests_section(regressed_tests: List[Dict]) -> List[str]:
    """Render the red-on-both test-set regressions that job state alone misses.

    Args:
        regressed_tests: The regressed_tests entries to render.

    Returns:
        Markdown lines for the report.
    """
    out = [
        f"\n### Test-set regressions ({len(regressed_tests)})\n",
        "These jobs are red on **both** twins, so job state calls them pre-existing, "
        "but they fail *more* tests on torch nightly. Each new failing test below is "
        "torch-nightly-only; shared failures are recorded in the artifacts for the "
        "root-cause agent.\n",
    ]
    for entry in sorted(regressed_tests, key=lambda e: e["cluster"]):
        new_failures = entry["new_failures"]
        shared_count = len(entry["shared_failures"])
        out.append(
            f"<details><summary><b>{entry['cluster']}</b> — "
            f"{len(new_failures)} new failing test(s), "
            f"{shared_count} shared</summary>\n"
        )
        out.append(f"- [{entry['name']}]({entry['url']}) — `{entry['state']}`")
        for failure in new_failures:
            out.append(f"  - `{failure['test_id']}` — `{failure['exception_class']}`")
        out.append("\n</details>")
    return out


def render(
    tn: Dict[str, Any],
    base: Dict[str, Any],
    buckets: Dict[str, List[Dict]],
    regressed_tests: Optional[List[Dict]] = None,
) -> str:
    regressed = buckets["regressed"]
    clusters: Dict[str, List[Dict]] = defaultdict(list)
    for job in regressed:
        clusters[cluster_key(job["name"])].append(job)
    ordered = sorted(clusters.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    agents = agent_concentration(regressed)
    top_agent_share = (agents[0][1] / len(regressed)) if regressed else 0.0

    same_commit = tn["commit"] == base["commit"]
    out: List[str] = []
    if same_commit:
        out.append(
            f"**{len(regressed)} job(s) regressed** on torch nightly "
            f"[#{tn['number']}]({tn['url']}) versus baseline "
            f"[#{base['number']}]({base['url']}), both at commit "
            f"`{tn['commit'][:12]}`.\n"
        )
    else:
        gap_hours = (base["created_at"] - tn["created_at"]).total_seconds() / 3600
        out.append(
            f"**{len(regressed)} job(s) regressed** on torch nightly "
            f"[#{tn['number']}]({tn['url']}) versus same-day baseline "
            f"[#{base['number']}]({base['url']}) ({gap_hours:+.1f}h).\n\n"
            f"> :warning: The two builds ran **different commits** "
            f"(`{tn['commit'][:12]}` vs `{base['commit'][:12]}`), so this is a "
            f"same-day comparison rather than a controlled A/B. A regression here "
            f"may be caused by vLLM commits landing between the builds rather than "
            f"by torch nightly.\n"
        )
    out.append("| | build | commit | outcome |")
    out.append("|---|---|---|---|")
    out.append(
        f"| torch nightly | [#{tn['number']}]({tn['url']}) "
        f"| `{tn['commit'][:12]}` | {tn['state']} |"
    )
    out.append(
        f"| baseline | [#{base['number']}]({base['url']}) "
        f"| `{base['commit'][:12]}` | {base['state']} |"
    )
    out.append(
        f"\n- regressed (fails here, passes on baseline): **{len(regressed)}**\n"
        f"- fails on both (pre-existing, not torch): {len(buckets['both'])}\n"
        f"- fails on baseline only: {len(buckets['baseline_only'])}\n"
        f"- failures unclassified: {len(buckets['unclassified'])}\n"
    )

    if not regressed and not regressed_tests:
        out.append("No torch-attributable regressions in this run.")
        return "\n".join(out)

    # Test-set regressions are independent of the job-state regressed bucket -- a
    # red-on-both job can hide one even when nothing flipped green->red.
    if regressed_tests:
        out.extend(render_regressed_tests_section(regressed_tests))

    # The cluster and infrastructure sections describe the regressed bucket; both
    # index into agents/ordered, which are empty when nothing flipped green->red.
    if not regressed:
        return "\n".join(out)

    out.append(f"\n### Clusters ({len(ordered)})\n")
    out.append(
        "Shard indices and hardware qualifiers are collapsed — a cluster is most "
        "likely one root cause, not N.\n"
    )
    for key, jobs in ordered:
        states = sorted({j["state"] for j in jobs})
        exits = sorted({str(j["exit_status"]) for j in jobs})
        out.append(
            f"<details><summary><b>{key}</b> — {len(jobs)} job(s), "
            f"{'/'.join(states)}, exit {','.join(exits)}</summary>\n"
        )
        for j in sorted(jobs, key=lambda x: x["name"]):
            out.append(
                f"- [{j['name']}]({j['url']}) — `{j['state']}` exit `{j['exit_status']}`"
            )
        out.append("\n</details>")

    out.append("\n### Infrastructure check\n")
    if top_agent_share >= 0.5:
        out.append(
            f"⚠️ {agents[0][1]}/{len(regressed)} failures landed on `{agents[0][0]}`. "
            "That concentration suggests a sick agent rather than a torch regression — "
            "verify before filing anything upstream."
        )
    else:
        out.append(
            f"Failures span {len(agents)} agents (heaviest `{agents[0][0]}` with "
            f"{agents[0][1]}). No single-host concentration, consistent with real signal."
        )
    return "\n".join(out)


def _render_shared_section(shared_failures: List[Tuple[FailedTest, FailedTest]]) -> str:
    """Render the shared failures, each with its nightly and baseline chain.

    Args:
        shared_failures: (nightly, baseline) failure pairs.

    Returns:
        The rendered section text.
    """
    sections = [f"\n# {len(shared_failures)} shared failure(s) (red on both sides)\n"]
    for torch_nightly_side, baseline_side in shared_failures:
        sections.append(f"## {torch_nightly_side.test_id}")
        sections.append(
            f"pytest_exception_class: {torch_nightly_side.pytest_exception_class}"
        )
        sections.append("")
        sections.append("### torch_nightly_exception_chain")
        sections.append(torch_nightly_side.exception_chain)
        sections.append("")
        sections.append("### baseline_exception_chain")
        sections.append(baseline_side.exception_chain)
        sections.append("")
    return "\n".join(sections)


def _render_cluster_artifact(
    body: str,
    cluster_key: str,
    representative: Dict,
    tail_lines: int,
    shared_failures: Optional[List[Tuple[FailedTest, FailedTest]]] = None,
) -> str:
    """Serialize one cluster's representative log for the root-cause agent.
    parse_log extracts per-test signatures (test id, exception class, the raw
    traceback body) from anywhere in the log, so a failure far from the end of a
    huge log is still captured. When there are no pytest failures -- a build/crash
    before pytest ran, an empty parse, or the parser raising on its own invariant --
    fall back to the raw tail this script has always emitted.
    """
    header = (
        f"# cluster: {cluster_key}\n"
        f"# job: {representative['name']}\n"
        f"# url: {representative['url']}\n"
        f"# state: {representative['state']} exit_status: {representative['exit_status']}\n"
    )

    parse_error = ""
    parsed = None
    try:
        parsed = parse_log(body)
    except Exception as exc:  # parser asserts an invariant; never abort the run
        parse_error = str(exc)

    test_failures = (
        [
            failure
            for result in parsed.pytest_results
            for failure in result.test_failures
        ]
        if parsed
        else []
    )

    if test_failures:
        sections = [header, f"# parsed {len(test_failures)} failing test(s)\n"]
        for failure in test_failures:
            sections.append(f"## {failure.test_id}")
            sections.append(f"pytest_exception_class: {failure.pytest_exception_class}")
            sections.append(f"test_is_infra: {failure.test_is_infra}")
            sections.append("")
            sections.append(failure.exception_chain)
            sections.append("")
        if shared_failures:
            sections.append(_render_shared_section(shared_failures))
        return "\n".join(sections)

    cleaned_lines = strip_markers(body).splitlines()
    job_is_infra = parsed.job_is_infra if parsed else False
    fallback_notes = (
        "# parse_fallback: true (raw tail; scan upward for the real error)\n"
    )
    if parse_error:
        fallback_notes += f"# parse_error: {parse_error}\n"
    fallback_notes += (
        f"# job_is_infra: {job_is_infra}\n"
        f"# showing last {tail_lines} of {len(cleaned_lines)} lines\n\n"
    )
    return header + fallback_notes + "\n".join(cleaned_lines[-tail_lines:])


def _fetch_job_log(job_url: str, token: str, timeout: int = 120) -> Optional[str]:
    """GET one Buildkite job's raw log body.

    Args:
        job_url: Job url of the form .../builds/<n>#<job-uuid>.
        token: Buildkite API token.
        timeout: Request timeout in seconds.

    Returns:
        The log body, or None when job_url can't be parsed into build + job ids.

    Raises:
        urllib.error.URLError: On HTTP or network failure; the caller decides
            whether that is a skip or a fail-closed.
    """
    # job_url is .../builds/<n>#<job-uuid>; the log endpoint needs both parts.
    match = re.search(r"/builds/(\d+)#([0-9a-f-]+)$", job_url or "")
    if not match:
        return None
    build_number, job_id = match.group(1), match.group(2)
    url = (
        "https://api.buildkite.com/v2/organizations/vllm/pipelines/"
        f"{PIPELINE.lower()}/builds/{build_number}/jobs/{job_id}/log.txt"
    )
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def _http_error_hint(exc: urllib.error.HTTPError) -> str:
    if exc.code == 401:
        return (
            "  (401 => token invalid for this org. Check it has read_builds "
            "and read_build_logs, that the vllm organization is selected, and "
            "that the value has no trailing newline.)"
        )
    return ""


def _failure_dict(failure: FailedTest) -> Dict[str, str]:
    return {
        "test_id": failure.test_id,
        "exception_class": failure.pytest_exception_class,
        "torch_nightly_exception_chain": failure.exception_chain,
    }


def _build_regressed_entry(cluster: str, rep: Dict, diff: DiffResult) -> Dict:
    """Build the regressed_tests entry for one `both`-cluster with new failures.

    Args:
        cluster: Cluster name.
        rep: Representative job for the cluster.
        diff: The failing-test diff for the cluster.

    Returns:
        The regressed_tests entry.
    """
    return {
        "name": rep["name"],
        "cluster": cluster,
        "url": rep["url"],
        "baseline_url": rep.get("baseline_url"),
        "state": rep["state"],
        "baseline_state": rep["baseline_state"],
        "new_failures": [_failure_dict(failure) for failure in diff.new_failures],
        "shared_failures": [
            {
                "test_id": torch_nightly_side.test_id,
                "exception_class": torch_nightly_side.pytest_exception_class,
                "torch_nightly_exception_chain": torch_nightly_side.exception_chain,
                "baseline_exception_chain": baseline_side.exception_chain,
            }
            for torch_nightly_side, baseline_side in diff.shared_failures
        ],
    }


@dataclass
class BothClusterDiff:
    """A surfaced `both`-cluster: its diff plus what rendering needs.

    Attributes:
        cluster: Cluster name.
        rep: Representative job for the cluster.
        torch_nightly_body: Raw nightly log, kept for the artifact.
        diff: The failing-test diff; new_failures is non-empty.
    """

    cluster: str
    rep: Dict
    torch_nightly_body: str
    diff: DiffResult


def _fetch_both_clusters(
    buckets: Dict[str, List[Dict]], token: str
) -> List[Tuple[str, Dict, str, str]]:
    """Fetch the nightly and baseline logs for each `both`-bucket cluster.

    Fail closed: a cluster whose nightly or baseline log 401s, errors, or has an
    unparseable url is skipped rather than returned, so a fetch failure can never
    fall through to "every nightly failure is new."

    Args:
        buckets: The compare() buckets.
        token: Buildkite API token.

    Returns:
        (cluster, rep, torch_nightly_body, baseline_body) per fetchable cluster.
    """
    clusters: Dict[str, List[Dict]] = defaultdict(list)
    for job in buckets["both"]:
        clusters[cluster_key(job["name"])].append(job)

    fetched: List[Tuple[str, Dict, str, str]] = []
    for key, jobs in sorted(clusters.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        rep = sorted(jobs, key=lambda j: j["name"])[0]
        baseline_url = rep.get("baseline_url")
        if baseline_url is None:
            continue
        try:
            torch_nightly_body = _fetch_job_log(rep["url"], token)
            baseline_body = _fetch_job_log(baseline_url, token)
        except urllib.error.HTTPError as exc:
            print(
                f"skip {key} diff: HTTP {exc.code} {exc.reason}{_http_error_hint(exc)}",
                file=sys.stderr,
            )
            continue
        except urllib.error.URLError as exc:
            print(f"skip {key} diff: {exc}", file=sys.stderr)
            continue
        if torch_nightly_body is None or baseline_body is None:
            continue
        fetched.append((key, rep, torch_nightly_body, baseline_body))
    return fetched


def diff_both_clusters(
    fetched: List[Tuple[str, Dict, str, str]],
) -> List[BothClusterDiff]:
    """Diff each fetched `both`-cluster; keep only those with new failures.

    Red-on-both jobs are dropped by the metadata layer, but a larger
    failing-test set on nightly is a real torch regression. A cluster is dropped
    when its diff is unusable (parse failure, no pytest session) or when nightly
    adds no new failure.

    Args:
        fetched: (cluster, rep, torch_nightly_body, baseline_body) tuples.

    Returns:
        One BothClusterDiff per surfaced cluster (>=1 new failure).
    """
    surfaced: List[BothClusterDiff] = []
    for cluster, rep, torch_nightly_body, baseline_body in fetched:
        diff = diff_failing_tests(torch_nightly_body, baseline_body)
        if diff.skipped:
            print(f"skip {cluster} diff: {diff.skipped}", file=sys.stderr)
            continue
        if not diff.new_failures:
            continue
        surfaced.append(BothClusterDiff(cluster, rep, torch_nightly_body, diff))
    return surfaced


def _write_both_artifacts(
    cluster_diffs: List[BothClusterDiff], pathlib_dir: Any, tail_lines: int
) -> List[str]:
    """Write one `both_*.log` artifact per surfaced cluster.

    Args:
        cluster_diffs: Surfaced both-cluster diffs.
        pathlib_dir: Directory to write artifacts into.
        tail_lines: Lines of raw tail kept in the fallback.

    Returns:
        Paths of the artifacts written.
    """
    written: List[str] = []
    for cluster_diff in cluster_diffs:
        artifact = _render_cluster_artifact(
            cluster_diff.torch_nightly_body,
            cluster_diff.cluster,
            cluster_diff.rep,
            tail_lines,
            shared_failures=cluster_diff.diff.shared_failures,
        )
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", cluster_diff.cluster)[:80]
        dest = pathlib_dir / f"both_{safe}.log"
        with open(dest, "w") as f:
            f.write(artifact)
        written.append(str(dest))
    return written


def fetch_cluster_logs(
    buckets: Dict[str, List[Dict]],
    logs_dir: str,
    token: str,
    tail_lines: int,
    torch_versions: Optional[List[str]] = None,
    regressed_tests: Optional[List[Dict]] = None,
) -> List[str]:
    """Download one representative log per cluster, cleaned and tail-trimmed.

    One per cluster rather than one per job: a cluster is most likely a single root
    cause, and only the tail is kept since the failure and traceback are at the end.

    Args:
        buckets: The compare() buckets.
        logs_dir: Directory to write artifacts into.
        token: Buildkite API token.
        tail_lines: Lines of raw tail kept in the fallback.
        torch_versions: Optional output list; a detected torch version per log is
            appended here.
        regressed_tests: Optional output list; when provided, the `both`-bucket
            clusters are diffed and surfaced entries are appended here.

    Returns:
        Paths of the artifacts written.
    """
    clusters: Dict[str, List[Dict]] = defaultdict(list)
    for job in buckets["regressed"]:
        clusters[cluster_key(job["name"])].append(job)

    pathlib_dir = __import__("pathlib").Path(logs_dir)
    pathlib_dir.mkdir(parents=True, exist_ok=True)
    written: List[str] = []

    for key, jobs in sorted(clusters.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        rep = sorted(jobs, key=lambda j: j["name"])[0]
        try:
            body = _fetch_job_log(rep["url"], token)
        except urllib.error.HTTPError as exc:
            print(
                f"skip {key}: HTTP {exc.code} {exc.reason}{_http_error_hint(exc)}",
                file=sys.stderr,
            )
            continue
        except urllib.error.URLError as exc:
            print(f"skip {key}: {exc}", file=sys.stderr)
            continue
        if body is None:
            print(f"skip {key}: cannot parse job url {rep['url']!r}", file=sys.stderr)
            continue

        if torch_versions is not None:
            found = _TORCH_VERSION.search(body)
            if found:
                torch_versions.append(found.group(1))

        artifact = _render_cluster_artifact(body, key, rep, tail_lines)
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", key)[:80]
        dest = pathlib_dir / f"{safe}.log"
        with open(dest, "w") as f:
            f.write(artifact)
        written.append(str(dest))

    if regressed_tests is not None:
        cluster_diffs = diff_both_clusters(_fetch_both_clusters(buckets, token))
        regressed_tests.extend(
            _build_regressed_entry(cd.cluster, cd.rep, cd.diff) for cd in cluster_diffs
        )
        written.extend(_write_both_artifacts(cluster_diffs, pathlib_dir, tail_lines))

    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lookback-days", type=int, default=14)
    parser.add_argument("--output", help="write the rendered markdown report here")
    parser.add_argument("--json-output", help="write the raw buckets here")
    parser.add_argument(
        "--compare-rows-output",
        help="write the raw ClickHouse job-comparison rows here",
    )
    parser.add_argument(
        "--logs-dir",
        help="fetch one representative Buildkite log per cluster into this directory "
        "(requires BUILDKITE_TOKEN)",
    )
    parser.add_argument("--log-tail-lines", type=int, default=400)
    args = parser.parse_args()

    client = get_clickhouse_client()
    pair = find_latest_pair(client, args.lookback_days)
    if pair is None:
        print(
            f"No torch-nightly build with a same-day baseline in the last "
            f"{args.lookback_days} days; nothing to compare.",
            file=sys.stderr,
        )
        return 0

    tn, base = pair
    rows = get_rows(client=client, tn_number=tn["number"], base_number=base["number"])
    if args.compare_rows_output:
        write_compare_rows(rows=rows, compare_rows_path=args.compare_rows_output)
    buckets = compare(rows=rows)

    # Logs are fetched before the report is rendered/written: the torch version and
    # the red-on-both test-set regressions are only observable in the log bodies, and
    # both feed the rendered report and report.json downstream.
    torch_versions: List[str] = []
    regressed_tests: List[Dict] = []
    # `both` clusters are diffed for hidden test-set regressions even when nothing
    # flipped green->red, so fetch whenever either bucket is non-empty.
    if args.logs_dir and (buckets["regressed"] or buckets["both"]):
        import os as _os

        # .strip() matters: a trailing newline in the value (easy to introduce when
        # pasting a token into a secret) makes the Authorization header invalid and
        # every request 401s.
        token = _os.environ.get("BUILDKITE_TOKEN", "").strip()
        if not token:
            # Not fatal: the report above is still useful without logs.
            print("BUILDKITE_TOKEN unset; skipping log fetch", file=sys.stderr)
        else:
            written = fetch_cluster_logs(
                buckets,
                args.logs_dir,
                token,
                args.log_tail_lines,
                torch_versions,
                regressed_tests,
            )
            print(f"fetched {len(written)} cluster log(s)", file=sys.stderr)

    report = render(tn, base, buckets, regressed_tests)
    if args.output:
        with open(args.output, "w") as f:
            f.write(report)
    else:
        print(report)

    # Most common wins: a stray version from some other wheel in one log should not
    # outvote the torch build the rest of the jobs installed.
    torch_version = ""
    if torch_versions:
        torch_version = Counter(torch_versions).most_common(1)[0][0]
        print(
            f"detected torch {torch_version} "
            f"({len(torch_versions)} log(s) reported a version)",
            file=sys.stderr,
        )
    else:
        print("no torch version found in fetched logs", file=sys.stderr)
    torch_version_minor = (
        ".".join(torch_version.split(".")[:2]) if torch_version else ""
    )

    if args.json_output:
        with open(args.json_output, "w") as f:
            json.dump(
                {
                    "torch_nightly_build": tn["number"],
                    "baseline_build": base["number"],
                    "commit": tn["commit"],
                    "torch_version": torch_version,
                    "torch_version_minor": torch_version_minor,
                    "regressed": buckets["regressed"],
                    "both": buckets["both"],
                    "regressed_tests": regressed_tests,
                },
                f,
                indent=2,
                default=str,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
