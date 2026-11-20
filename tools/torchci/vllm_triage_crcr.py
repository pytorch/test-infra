#!/usr/bin/env python3
"""Turn the vLLM torch-nightly root-cause findings into CRCR late reports.

vLLM reports each torch-nightly job to CRCR from its own Buildkite build, hours
before the root-cause agent in .github/workflows/vllm-torch-nightly-triage.yml has
anything to say, and a row is write-once. So the findings are added afterwards, as
a late report: this script writes the list of reports, and the workflow sends it
with the cross-repo-ci-relay-callback action (event-type: late-report).

Like vllm_triage_file_issues, the model only emits data (findings.json); what is
reported is decided here. A job is only matched through report.json, which the
triage job built from ClickHouse: a job URL or cluster name that appears only in the
findings matches nothing, since the findings are derived from untrusted CI logs.
The relay validates every verdict again before HUD stores it.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from torchci.vllm_triage_file_issues import (
    classification_confidence,
    routing_of,
    TORCH_ROUTING,
    VLLM_ROUTING,
)


ANALYZER_NAME = "vllm-pytorch-ci-triage"
# The relay's `routing` vocabulary for a cause, as CRCR's `category`.
CATEGORY = {TORCH_ROUTING: "upstream", VLLM_ROUTING: "backend", "infra": "infra"}
CONFIDENCES = ("high", "medium", "low")
# The buckets of report.json that hold jobs failing on torch nightly.
FAILING_BUCKETS = ("regressed", "both")

# <job_url> is .../<pipeline>/builds/<n>#<job-uuid>: the same ids vLLM's
# crcr_report.py puts in a row's `buildkite-<build>-<job id>` and workflow name.
_JOB_URL = re.compile(
    r"/(?P<pipeline>[^/]+)/builds/(?P<build>\d+)#(?P<job>[0-9a-f-]+)$"
)
_SHARD = re.compile(r" \[shard \d+\]$")


def unsharded(name: str) -> str:
    """The job name vLLM reported: the triage report appends ` [shard N]`."""
    return _SHARD.sub("", name)


def parse_job_url(url: Any) -> Optional[Dict[str, str]]:
    match = _JOB_URL.search(url) if isinstance(url, str) else None
    return match.groupdict() if match else None


def _level(cause: Dict[str, Any]) -> str:
    level = classification_confidence(cause)
    return level if level in CONFIDENCES else "low"


def _rank(cause: Dict[str, Any]) -> Tuple[int, int, int]:
    """Which cause wins a job two causes both claim: determined, then surer, then the
    more specific one (a cause on fewer clusters than a catch-all one)."""
    determined = 1 if cause.get("determined") is not False else 0
    return (
        determined,
        CONFIDENCES[::-1].index(_level(cause)),
        -len(cause.get("clusters") or []),
    )


def build_verdict(
    cause: Dict[str, Any],
    job: Dict[str, Any],
    analyzed_at: str,
    analyzer: Dict[str, str],
) -> Optional[Dict[str, Any]]:
    """The verdict CRCR shows for `job`, or None when `cause` gives none."""
    summary = str(cause.get("summary") or cause.get("title") or "").strip()
    if not summary:
        return None

    category = CATEGORY.get(routing_of(cause))
    if category is None or cause.get("determined") is False:
        # Routing the agent did not commit to is `unknown`, whatever it guessed.
        category, confidence = "unknown", "low"
    else:
        confidence = _level(cause)

    evidence = {"job": job["name"], "log_url": job["url"]}
    signature = str(cause.get("signature") or "").strip()
    if signature:
        evidence["excerpt"] = signature

    return {
        "schema_version": 1,
        "category": category,
        "confidence": confidence,
        "summary": summary,
        "evidence": [evidence],
        "analyzer": {"name": ANALYZER_NAME, **analyzer},
        "analyzed_at": analyzed_at,
    }


def plan_reports(
    findings: Dict[str, Any],
    report: Dict[str, Any],
    analyzed_at: str,
    analyzer: Dict[str, str],
) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    """One late report per failing torch-nightly job that a cause explains."""
    jobs = [j for key in FAILING_BUCKETS for j in report.get(key) or []]
    by_url = {j["url"]: j for j in jobs if j.get("url")}
    causes = findings.get("causes") or []

    # job url -> the best cause that claims it
    claimed: Dict[str, Tuple[Tuple[int, int, int], Dict[str, Any]]] = {}
    for cause in causes:
        clusters = {str(c) for c in cause.get("clusters") or []}
        urls = set(cause.get("job_urls") or [])
        for url, job in by_url.items():
            name = job.get("name", "")
            # A cluster named with its ` [shard N]` suffix is that one shard; one named
            # without it is every shard of the job.
            if url in urls or name in clusters or unsharded(name) in clusters:
                rank = _rank(cause)
                if url not in claimed or rank > claimed[url][0]:
                    claimed[url] = (rank, cause)

    named_urls = {u for c in causes for u in c.get("job_urls") or []}
    counts = {
        "jobs": len(jobs),
        "matched": len(claimed),
        "unparsable": 0,
        "no_verdict": 0,
        "unknown_urls": len(named_urls - set(by_url)),
    }
    reports = []
    for url, (_, cause) in claimed.items():
        job = by_url[url]
        ids = parse_job_url(url)
        if ids is None:
            counts["unparsable"] += 1
            continue
        verdict = build_verdict(cause, job, analyzed_at, analyzer)
        if verdict is None:
            counts["no_verdict"] += 1
            continue
        reports.append(
            {
                "delivery_id": f"buildkite-{ids['build']}-{ids['job']}",
                "workflow_name": ids["pipeline"],
                "job_name": unsharded(job["name"]),
                "triage_verdict": verdict,
            }
        )
    return reports, counts


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--findings", required=True, help="findings.json from the agent")
    p.add_argument("--report", required=True, help="report.json from the triage job")
    p.add_argument("--output", required=True, help="where to write the reports (JSON)")
    p.add_argument("--analyzer-version", default="", help="e.g. the workflow's commit")
    p.add_argument("--analyzer-model", default="")
    args = p.parse_args(argv)

    with open(args.findings) as f:
        findings = json.load(f)
    with open(args.report) as f:
        report = json.load(f)
    analyzer = {
        k: v
        for k, v in (("version", args.analyzer_version), ("model", args.analyzer_model))
        if v
    }
    analyzed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    reports, counts = plan_reports(findings, report, analyzed_at, analyzer)
    print(
        f"{counts['jobs']} failing job(s) in the report, {counts['matched']} explained "
        f"by a cause, {len(reports)} report(s) to send "
        f"({counts['unparsable']} with an unparsable job URL, {counts['no_verdict']} "
        f"whose cause gives no verdict, {counts['unknown_urls']} finding URL(s) not "
        f"in the report)"
    )
    for r in reports:
        v = r["triage_verdict"]
        print(f"  {v['category']:<9} {v['confidence']:<6} {r['job_name'][:70]}")

    # Written only when there is something to send, so the workflow can test the file.
    if reports:
        with open(args.output, "w") as f:
            json.dump(reports, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
