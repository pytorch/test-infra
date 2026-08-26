"""File vLLM torch-nightly triage findings as issues in pytorch/test-infra.

Consumes the structured output of the triage pipeline and files one umbrella issue
per torch minor version, with one child issue per high-confidence torch root cause.

Deliberately a script rather than part of the analysis agent: the agent reads
untrusted Buildkite logs, so it must never hold `issues: write`. It emits data; this
files it.

Re-runs are idempotent. Every child issue carries a fingerprint comment
(``<!-- vllm-triage-key: ... -->``); a cause already filed gets a recurrence line on
the existing issue instead of a duplicate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


API = "https://api.github.com"
UMBRELLA_LABEL = "vllm-torch-nightly-umbrella"
CHILD_LABEL = "vllm-torch-nightly"
KEY_PREFIX = "vllm-triage-key"


def _req(method: str, path: str, token: str, body: Optional[dict] = None) -> Any:
    url = path if path.startswith("http") else f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read() or "null")


def fingerprint(repo: str, cause: Dict[str, Any]) -> str:
    """Stable across runs: the cause identity, not the build it was seen in.

    Cluster names are included because the same exception in a different job is
    usually a different bug; build numbers and dates are excluded so a recurrence
    matches rather than files anew.
    """
    basis = "\n".join(
        [
            repo,
            (cause.get("signature") or cause.get("title") or "").strip(),
            *sorted(c.strip() for c in cause.get("clusters") or []),
        ]
    )
    return hashlib.sha256(basis.encode()).hexdigest()[:16]


def search_issue_by_key(token: str, repo: str, key: str) -> Optional[Dict]:
    q = urllib.parse.quote(f'repo:{repo} in:body "{KEY_PREFIX}: {key}"')
    res = _req("GET", f"/search/issues?q={q}&per_page=5", token)
    for item in res.get("items", []):
        if f"{KEY_PREFIX}: {key}" in (item.get("body") or ""):
            return item
    return None


def find_umbrella(token: str, repo: str, minor: str) -> Optional[Dict]:
    q = urllib.parse.quote(
        f"repo:{repo} is:issue is:open label:{UMBRELLA_LABEL} "
        f'"[torch {minor}]" in:title'
    )
    res = _req("GET", f"/search/issues?q={q}&per_page=5", token)
    items = res.get("items", [])
    return items[0] if items else None


def latest_open_umbrella(token: str, repo: str) -> Optional[Dict]:
    """Any open umbrella, newest first -- used to recover the torch minor version.

    The version is only detectable when a fetched log happens to include the pip
    install line, which is far from guaranteed. Reusing the version already on an
    open umbrella is correct in every case except the first run of a new cycle,
    because the minor version turns over roughly once a quarter.
    """
    q = urllib.parse.quote(f"repo:{repo} is:issue is:open label:{UMBRELLA_LABEL}")
    res = _req("GET", f"/search/issues?q={q}&sort=created&order=desc&per_page=5", token)
    items = res.get("items", [])
    return items[0] if items else None


def umbrella_body(minor: str, report: Dict[str, Any]) -> str:
    return (
        f"## torch {minor} nightly - vLLM CI regressions\n\n"
        "Filed automatically by "
        "[`vllm-torch-nightly-triage`]"
        "(https://github.com/pytorch/test-infra/blob/main/.github/workflows/"
        "vllm-torch-nightly-triage.yml). Tracked here rather than in "
        "pytorch/pytorch while the pipeline is being validated.\n\n"
        "### Method\n\n"
        "Each vLLM `Full CI run torch nightly` build has a `Full CI run - nightly` "
        "twin from the same commit in the same cron slot. A job is only reported "
        "when it fails on the nightly build **and passes on that same-commit "
        "baseline**, so vLLM-side breakage and flaky infrastructure are excluded "
        "by construction.\n\n"
        f"Most recent pair: torch-nightly "
        f"[#{report.get('torch_nightly_build')}]"
        f"(https://buildkite.com/vllm/ci/builds/{report.get('torch_nightly_build')})"
        f" vs baseline "
        f"[#{report.get('baseline_build')}]"
        f"(https://buildkite.com/vllm/ci/builds/{report.get('baseline_build')})"
        f" on commit `{str(report.get('commit') or '')[:12]}`.\n\n"
        "### Confirmed regressions\n\n"
        "<!-- checklist: appended automatically, one entry per root cause -->\n"
    )


def append_to_umbrella(token: str, repo: str, umbrella: Dict, line: str) -> None:
    fresh = _req("GET", f"/repos/{repo}/issues/{umbrella['number']}", token)
    body = fresh.get("body") or ""
    if line.strip() in body:
        return
    _req(
        "PATCH",
        f"/repos/{repo}/issues/{umbrella['number']}",
        token,
        {"body": body.rstrip() + "\n" + line + "\n"},
    )


def child_body(cause: Dict[str, Any], report: Dict[str, Any], key: str) -> str:
    clusters = "\n".join(f"- `{c}`" for c in cause.get("clusters") or [])
    jobs = "\n".join(f"- {u}" for u in (cause.get("job_urls") or [])[:10])
    tn = report.get("torch_nightly_build")
    base = report.get("baseline_build")
    commit = str(report.get("commit") or "")[:12]

    sections = [
        f"## Summary\n\n{cause.get('summary', '').strip()}",
        f"## Signature\n\n```\n{cause.get('signature', '').strip()}\n```",
        f"## Affected job clusters\n\n{clusters or '- (none recorded)'}",
        (
            "## Evidence it is torch-nightly specific\n\n"
            f"Fails on torch-nightly build "
            f"[#{tn}](https://buildkite.com/vllm/ci/builds/{tn}) and passes on "
            f"the same-commit baseline "
            f"[#{base}](https://buildkite.com/vllm/ci/builds/{base}) "
            f"(commit `{commit}`)."
        ),
    ]
    if jobs:
        sections.append(f"## Representative jobs\n\n{jobs}")
    sections.append(
        f"## Suggested routing\n\n{cause.get('routing', 'undetermined')} "
        f"(agent confidence: classification "
        f"{classification_confidence(cause) or 'unknown'}, new-failure "
        f"{new_failure_confidence(cause) or 'unknown'})"
    )
    sections.append(
        "---\n\n"
        "Filed automatically by the vLLM torch-nightly triage workflow. The root "
        "cause above was produced by an automated analysis of the Buildkite log "
        "tail and has not been human-verified.\n\n"
        f"<!-- {KEY_PREFIX}: {key} -->"
    )
    return "\n\n".join(sections) + "\n"


def _level(value: Any) -> str:
    """Normalise a confidence level. ``med`` and ``medium`` are both in use."""
    level = str(value or "").strip().lower()
    return "medium" if level == "med" else level


def classification_confidence(cause: Dict[str, Any]) -> str:
    """How sure the agent is that the routing is right.

    The agent's schema renamed the original ``confidence`` to
    ``classification_confidence`` and added ``new_failure_confidence``; the old
    name is still read so archived findings.json artifacts keep gating correctly.
    """
    return _level(cause.get("classification_confidence") or cause.get("confidence"))


def new_failure_confidence(cause: Dict[str, Any]) -> str:
    """How sure the agent is that this is a new regression, not a known variant.

    Absent in the pre-rename schema, where "" reads as "not stated" and does not
    disqualify a cause.
    """
    return _level(cause.get("new_failure_confidence"))


def eligible(cause: Dict[str, Any]) -> bool:
    """High-confidence torch/triton causes only.

    Infra-looking clusters and anything the agent could not root-cause stay out of
    the tracker: at three runs a week, filing uncertain causes would bury the real
    ones. They remain visible in the run summary and the umbrella's context section.

    ``new_failure_confidence: low`` means "likely a variant of an existing known
    issue", so filing it would duplicate a child issue that already exists.
    """
    return (
        bool(cause.get("determined"))
        and classification_confidence(cause) == "high"
        and new_failure_confidence(cause) != "low"
        and str(cause.get("routing", "")).strip().lower() == "pytorch/pytorch"
    )


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--findings", required=True, help="findings.json from the agent")
    p.add_argument("--report", required=True, help="report.json from the triage job")
    p.add_argument("--repo", default="pytorch/test-infra")
    p.add_argument("--max-issues", type=int, default=5)
    p.add_argument(
        "--torch-version-override",
        default="",
        help="minor version (e.g. 2.14) to use when detection fails",
    )
    p.add_argument(
        "--execute",
        action="store_true",
        help="actually create/patch issues; default is a dry run",
    )
    args = p.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        print("GITHUB_TOKEN unset", file=sys.stderr)
        return 1

    report = json.load(open(args.report))
    findings = json.load(open(args.findings))
    causes = findings.get("causes") or []

    minor = (
        args.torch_version_override.strip()
        or str(report.get("torch_version_minor") or "").strip()
    )
    if not minor:
        prior = latest_open_umbrella(token, args.repo)
        if prior:
            import re as _re

            m = _re.search(r"\[torch (\d+\.\d+)\]", prior.get("title") or "")
            if m:
                minor = m.group(1)
                print(f"version not detected; reusing {minor} from #{prior['number']}")
    if not minor:
        # Guessing here would create a mistitled umbrella that every later run
        # appends to. Better to file nothing and say why.
        print(
            "Could not determine the torch minor version and no open umbrella to "
            "inherit it from. Skipping filing; pass --torch-version-override to "
            "bootstrap the first umbrella of a cycle.",
            file=sys.stderr,
        )
        return 0

    # A schema change on the agent side silently zeroes out the gate, which reads
    # as a quiet "nothing to file" run. Say so instead.
    unscored = [c for c in causes if not classification_confidence(c)]
    if unscored:
        print(
            f"WARNING: {len(unscored)} of {len(causes)} cause(s) carry no "
            "classification_confidence (nor legacy confidence) field. No cause can "
            "be eligible without it -- the agent's findings schema may have changed.",
            file=sys.stderr,
        )

    selected = [c for c in causes if eligible(c)]
    skipped = [c for c in causes if not eligible(c)]
    print(f"{len(causes)} cause(s): {len(selected)} eligible, {len(skipped)} skipped")
    for c in skipped:
        print(
            f"  skip: {c.get('title', '<untitled>')!r} "
            f"(determined={c.get('determined')}, "
            f"classification_confidence={classification_confidence(c) or None}, "
            f"new_failure_confidence={new_failure_confidence(c) or None}, "
            f"routing={c.get('routing')})"
        )
    if len(selected) > args.max_issues:
        print(
            f"capping at --max-issues={args.max_issues} "
            f"({len(selected) - args.max_issues} not filed this run)"
        )
        selected = selected[: args.max_issues]

    if not args.execute:
        print("\n=== DRY RUN (pass --execute to file) ===")
        print(f"umbrella: [torch {minor}] vLLM CI failures - torch nightly triage")
        for c in selected:
            print(f"  child: {c.get('title')}  key={fingerprint(args.repo, c)}")
        return 0

    umbrella = find_umbrella(token, args.repo, minor)
    if umbrella is None:
        umbrella = _req(
            "POST",
            f"/repos/{args.repo}/issues",
            token,
            {
                "title": f"[torch {minor}] vLLM CI failures - torch nightly triage",
                "body": umbrella_body(minor, report),
                "labels": [UMBRELLA_LABEL],
            },
        )
        print(f"created umbrella #{umbrella['number']}")
    else:
        print(f"reusing umbrella #{umbrella['number']}")

    for c in selected:
        key = fingerprint(args.repo, c)
        existing = search_issue_by_key(token, args.repo, key)
        if existing:
            _req(
                "POST",
                f"/repos/{args.repo}/issues/{existing['number']}/comments",
                token,
                {
                    "body": f"Still reproducing on torch-nightly build "
                    f"[#{report.get('torch_nightly_build')}]"
                    f"(https://buildkite.com/vllm/ci/builds/"
                    f"{report.get('torch_nightly_build')})."
                },
            )
            print(f"  recurrence -> #{existing['number']}")
            continue
        issue = _req(
            "POST",
            f"/repos/{args.repo}/issues",
            token,
            {
                "title": f"[vllm][torch {minor}] {c.get('title')}",
                "body": child_body(c, report, key),
                "labels": [CHILD_LABEL],
            },
        )
        print(f"  created #{issue['number']}: {c.get('title')}")
        append_to_umbrella(
            token,
            args.repo,
            umbrella,
            f"- [ ] #{issue['number']} - {c.get('title')}",
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
