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
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple

from torchci.clickhouse import get_clickhouse_client
from torchci.vllm_log_parser import parse_log, strip_markers


VLLM_REPO = "https://github.com/vllm-project/vllm.git"
PIPELINE = "CI"

TORCH_NIGHTLY_MSG = "Full CI run torch nightly"
# The plain nightly is the pinned-torch counterpart of the torch-nightly build;
# the daily is the fallback when a day has no plain nightly.
BASELINE_MSGS = ("Full CI run - nightly", "Full CI run - daily")

BAD_STATES = ("failed", "timed_out")

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


def compare(client: Any, tn_number: int, base_number: int) -> Dict[str, List[Dict]]:
    """Bucket every job by its outcome in the torch-nightly vs baseline build.

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
    rows = _rows(
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

    buckets: Dict[str, List[Dict]] = {"regressed": [], "both": [], "baseline_only": []}
    for (
        name,
        shard,
        tn_state,
        tn_exit,
        tn_url,
        tn_agent,
        base_state,
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
    return buckets


def agent_concentration(regressed: List[Dict]) -> List[Tuple[str, int]]:
    """Failures piled onto one host usually mean a sick agent, not a regression."""
    counts: Dict[str, int] = defaultdict(int)
    for job in regressed:
        counts[job.get("agent") or "<unknown>"] += 1
    return sorted(counts.items(), key=lambda kv: -kv[1])


def render(
    tn: Dict[str, Any], base: Dict[str, Any], buckets: Dict[str, List[Dict]]
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
    )

    if not regressed:
        out.append("No torch-attributable regressions in this run.")
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


def _render_cluster_artifact(
    body: str, cluster_key: str, representative: Dict, tail_lines: int
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


def fetch_cluster_logs(
    buckets: Dict[str, List[Dict]],
    logs_dir: str,
    token: str,
    tail_lines: int,
    torch_versions: Optional[List[str]] = None,
) -> List[str]:
    """Download one representative log per cluster, cleaned and tail-trimmed.

    One per cluster rather than one per job: a cluster is most likely a single root
    cause, and 28 full logs is both slow and far more context than the analysis needs.
    Only the tail is kept -- the failure and traceback are at the end, while the head
    is install and setup noise.
    """
    import urllib.error
    import urllib.request

    clusters: Dict[str, List[Dict]] = defaultdict(list)
    for job in buckets["regressed"]:
        clusters[cluster_key(job["name"])].append(job)

    pathlib_dir = __import__("pathlib").Path(logs_dir)
    pathlib_dir.mkdir(parents=True, exist_ok=True)
    written: List[str] = []

    for key, jobs in sorted(clusters.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        rep = sorted(jobs, key=lambda j: j["name"])[0]
        # job["url"] is .../builds/<n>#<job-uuid>; the log endpoint needs both parts.
        m = re.search(r"/builds/(\d+)#([0-9a-f-]+)$", rep["url"] or "")
        if not m:
            print(f"skip {key}: cannot parse job url {rep['url']!r}", file=sys.stderr)
            continue
        build_number, job_id = m.group(1), m.group(2)
        url = (
            "https://api.buildkite.com/v2/organizations/vllm/pipelines/"
            f"{PIPELINE.lower()}/builds/{build_number}/jobs/{job_id}/log.txt"
        )
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            hint = ""
            if exc.code == 401:
                hint = (
                    "  (401 => token invalid for this org. Check it has read_builds "
                    "and read_build_logs, that the vllm organization is selected, and "
                    "that the value has no trailing newline.)"
                )
            print(f"skip {key}: HTTP {exc.code} {exc.reason}{hint}", file=sys.stderr)
            continue
        except urllib.error.URLError as exc:
            print(f"skip {key}: {exc}", file=sys.stderr)
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
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lookback-days", type=int, default=14)
    parser.add_argument("--output", help="write the rendered markdown report here")
    parser.add_argument("--json-output", help="write the raw buckets here")
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
    buckets = compare(client, tn["number"], base["number"])
    report = render(tn, base, buckets)

    if args.output:
        with open(args.output, "w") as f:
            f.write(report)
    else:
        print(report)

    # Logs are fetched before the JSON is written: the torch version is only
    # observable in a log body, and report.json is what carries it downstream.
    torch_versions: List[str] = []
    if args.logs_dir and buckets["regressed"]:
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
                buckets, args.logs_dir, token, args.log_tail_lines, torch_versions
            )
            print(f"fetched {len(written)} cluster log(s)", file=sys.stderr)

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
                },
                f,
                indent=2,
                default=str,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
