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

On Mon/Tue/Thu the torch-nightly build and the plain nightly fire in the *same
second* on the *same commit*, differing only by ``TORCH_NIGHTLY=1``. That pair is
a controlled A/B: a job failing in the former and passing in the latter is
attributable to torch nightly, with the vLLM variable held constant.

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
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

from torchci.clickhouse import get_clickhouse_client


VLLM_REPO = "https://github.com/vllm-project/vllm.git"
PIPELINE = "CI"

TORCH_NIGHTLY_MSG = "Full CI run torch nightly"
# The plain nightly shares the torch-nightly cron slot; the daily is the fallback
# baseline when a same-second sibling is missing.
BASELINE_MSGS = ("Full CI run - nightly", "Full CI run - daily")

# A build is only a valid control if it ran the same commit. Buildkite schedules
# fire at the same instant but a commit can land between them in principle.
SIBLING_WINDOW_SECONDS = 900

BAD_STATES = ("failed", "timed_out")

# Job names are frequently sharded ("Multi-Modal Processor (CPU) 1..4") or
# parameterised by hardware ("Fusion E2E TP2 (B200)"). Collapsing those into one
# cluster keeps a single root cause from looking like N independent regressions.
_SHARD_SUFFIX = re.compile(r"\s+\d+$")
_PAREN_QUALIFIER = re.compile(r"\s*\([^)]*\)\s*$")


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

    Returns None when no torch-nightly build exists in the window, or when the
    newest one has no same-commit baseline (in which case there is nothing to
    compare against and reporting raw failures would be misleading).
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
        return dict(zip(("number", "title", "commit", "created_at", "state", "url"), row))

    parsed = [as_dict(r) for r in builds]
    nightlies = [b for b in parsed if b["title"].startswith(TORCH_NIGHTLY_MSG)]
    if not nightlies:
        return None

    target = nightlies[0]
    candidates = [
        b
        for b in parsed
        if b["title"].startswith(BASELINE_MSGS)
        and b["commit"] == target["commit"]
        and abs((b["created_at"] - target["created_at"]).total_seconds())
        <= SIBLING_WINDOW_SECONDS
    ]
    if not candidates:
        return None

    # Prefer the closest in time; ties favour the plain nightly (same cron slot).
    candidates.sort(
        key=lambda b: (
            abs((b["created_at"] - target["created_at"]).total_seconds()),
            0 if b["title"].startswith(BASELINE_MSGS[0]) else 1,
        )
    )
    return target, candidates[0]


def compare(client: Any, tn_number: int, base_number: int) -> Dict[str, List[Dict]]:
    """Bucket every job by its outcome in the torch-nightly vs baseline build.

    ``retried`` jobs are excluded: a retried attempt is superseded and counting it
    double-reports. ``soft_failed`` jobs are non-blocking by design.
    """
    rows = _rows(
        client,
        """
        SELECT
            tupleElement(job, 'name') AS job_name,
            anyIf(lowerUTF8(tupleElement(job, 'state')),
                  toUInt32(tupleElement(build, 'number')) = {tn: UInt32}) AS tn_state,
            anyIf(tupleElement(job, 'exit_status'),
                  toUInt32(tupleElement(build, 'number')) = {tn: UInt32}) AS tn_exit,
            anyIf(tupleElement(job, 'web_url'),
                  toUInt32(tupleElement(build, 'number')) = {tn: UInt32}) AS tn_url,
            anyIf(tupleElement(tupleElement(job, 'agent'), 'hostname'),
                  toUInt32(tupleElement(build, 'number')) = {tn: UInt32}) AS tn_agent,
            anyIf(lowerUTF8(tupleElement(job, 'state')),
                  toUInt32(tupleElement(build, 'number')) = {base: UInt32}) AS base_state,
            countIf(toUInt32(tupleElement(build, 'number')) = {base: UInt32}) AS in_base
        FROM vllm.vllm_buildkite_jobs FINAL
        WHERE toUInt32(tupleElement(build, 'number')) IN ({tn: UInt32}, {base: UInt32})
          AND tupleElement(job, 'soft_failed') = 0
          AND tupleElement(job, 'retried') = 0
          AND tupleElement(job, 'name') != ''
        GROUP BY job_name
        """,
        {"tn": tn_number, "base": base_number},
    )

    buckets: Dict[str, List[Dict]] = {"regressed": [], "both": [], "baseline_only": []}
    for name, tn_state, tn_exit, tn_url, tn_agent, base_state, in_base in rows:
        job = {
            "name": name,
            "state": tn_state,
            "exit_status": tn_exit,
            "url": tn_url,
            "agent": tn_agent,
            "baseline_state": base_state,
        }
        tn_bad = tn_state in BAD_STATES
        base_bad = base_state in BAD_STATES
        if tn_bad and base_bad:
            buckets["both"].append(job)
        elif tn_bad and in_base:
            # Only comparable if the job actually ran in the baseline build.
            buckets["regressed"].append(job)
        elif base_bad and not tn_bad:
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

    out: List[str] = []
    out.append(
        f"**{len(regressed)} job(s) regressed** on torch nightly "
        f"[#{tn['number']}]({tn['url']}) versus baseline "
        f"[#{base['number']}]({base['url']}), both at commit "
        f"`{tn['commit'][:12]}`.\n"
    )
    out.append("| | build | outcome |")
    out.append("|---|---|---|")
    out.append(f"| torch nightly | [#{tn['number']}]({tn['url']}) | {tn['state']} |")
    out.append(f"| baseline | [#{base['number']}]({base['url']}) | {base['state']} |")
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
        out.append(f"<details><summary><b>{key}</b> — {len(jobs)} job(s), "
                   f"{'/'.join(states)}, exit {','.join(exits)}</summary>\n")
        for j in sorted(jobs, key=lambda x: x["name"]):
            out.append(f"- [{j['name']}]({j['url']}) — `{j['state']}` exit `{j['exit_status']}`")
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lookback-days", type=int, default=14)
    parser.add_argument("--output", help="write the rendered markdown report here")
    parser.add_argument("--json-output", help="write the raw buckets here")
    args = parser.parse_args()

    client = get_clickhouse_client()
    pair = find_latest_pair(client, args.lookback_days)
    if pair is None:
        print(
            f"No torch-nightly build with a same-commit baseline in the last "
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

    if args.json_output:
        with open(args.json_output, "w") as f:
            json.dump(
                {
                    "torch_nightly_build": tn["number"],
                    "baseline_build": base["number"],
                    "commit": tn["commit"],
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
