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
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


API = "https://api.github.com"
UMBRELLA_LABEL = "vllm-torch-nightly-umbrella"
CHILD_LABEL = "vllm-torch-nightly"
# Extra label on causes whose fix belongs in vLLM, so they can be listed or
# filtered apart from the torch regressions without reading each body.
VLLM_SIDE_LABEL = "vllm-side"
KEY_PREFIX = "vllm-triage-key"

TORCH_ROUTING = "pytorch/pytorch"
VLLM_ROUTING = "vllm-project/vllm"
FILED_ROUTINGS = (TORCH_ROUTING, VLLM_ROUTING)

# Umbrella section each routing is listed under.
SECTIONS = {
    TORCH_ROUTING: "### Confirmed regressions",
    VLLM_ROUTING: "### Regression on vLLM side",
}


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


# pytest prints an assertion, then explains it on continuation lines:
#
#     AssertionError: assert 2 == 0
#      +  where 2 = op_count(<OpOverload(op='aten.slice_scatter', ...)>)
#
# How much of that tail reaches `signature` depends on where the agent cut the
# log, so the same failure can arrive with or without the `+` lines. Hashing
# them split one cause across two issues (#8761 and #8783: same test, same
# `assert 2 == 0`, same cluster, two keys). They are derived from the assertion
# above them, so they carry no identity of their own -- drop them.
_PYTEST_CONTINUATION = re.compile(r"^(?:E\s+)?\+")

# The same tail also arrives folded onto the assertion line, because the agent
# quotes the log with its own line breaks. Anchoring on `^` alone missed that
# and split one cause again (#8761 kept the tail on its own line, #8838 joined
# it onto the assert -- same test, same cluster, two keys). Cut at the ` + `
# that introduces pytest's introspection keywords, wherever it appears.
_PYTEST_INLINE_TAIL = re.compile(r"\s\+\s+(?=where\b|and\b|assert\b)")

# ...and sometimes without the `+` at all, having rewritten the tail in its own
# words: #8875 wrote "assert 2 == 0 where 2 = op_count(aten.slice_scatter.default)"
# for what #8761 logged as "assert 2 == 0\n +  where 2 = op_count(<OpOverload(
# op='aten.slice_scatter', overload='default')>)". Anchored on an assertion so a
# message that merely contains the word "where" keeps it.
_BARE_WHERE_TAIL = re.compile(r"(\bassert\b.*?)\s+where\b.*$")


def normalize_signature(signature: str) -> str:
    """Reduce a signature to the part that identifies the cause.

    Whitespace is collapsed and pytest's assertion-introspection tail is
    dropped -- whether on its own line or folded onto the assertion -- so a
    signature truncated at a different point still fingerprints the same.
    Deliberately conservative: nothing that could distinguish two genuine
    causes (exception type, message text, numbers) is touched, because
    over-normalizing silently merges distinct regressions, which is worse than
    filing a duplicate.
    """
    lines = []
    for raw in (signature or "").splitlines():
        line = " ".join(raw.split())
        if not line or _PYTEST_CONTINUATION.match(line):
            continue
        line = _PYTEST_INLINE_TAIL.split(line, 1)[0].strip()
        line = _BARE_WHERE_TAIL.sub(r"\1", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _basis(repo: str, cause: Dict[str, Any], signature: str) -> str:
    return "\n".join(
        [
            repo,
            signature,
            *sorted(c.strip() for c in cause.get("clusters") or []),
        ]
    )


def fingerprint(repo: str, cause: Dict[str, Any]) -> str:
    """Stable across runs: the cause identity, not the build it was seen in.

    Keyed on the normalized signature alone. Cluster names used to be part of
    the key, on the theory that the same exception in a different job is
    usually a different bug. In practice the opposite dominated: one cause
    reaching a second accelerator minted a second issue (#8786 on MI355 and
    #8839 on B200 -- byte-identical GSM8K assertion, two issues), as did a
    cause whose cluster list simply grew (#8745 at three clusters, #8869 at
    four). Clusters are accumulated onto the matched issue instead, which is
    also the more useful record: it shows the spread.

    Build numbers and dates stay out so a recurrence matches rather than files
    anew.
    """
    raw = cause.get("signature") or cause.get("title") or ""
    return hashlib.sha256(
        "\n".join([repo, normalize_signature(raw)]).encode()
    ).hexdigest()[:16]


def cluster_fingerprint(repo: str, cause: Dict[str, Any]) -> str:
    """The signature+clusters key, for issues filed before clusters were dropped.

    Every child issue currently open carries one of these. Looked up as a
    fallback so they keep matching; a hit is migrated to the current key.
    """
    raw = cause.get("signature") or cause.get("title") or ""
    return hashlib.sha256(
        _basis(repo, cause, normalize_signature(raw)).encode()
    ).hexdigest()[:16]


def legacy_fingerprint(repo: str, cause: Dict[str, Any]) -> str:
    """The pre-normalization key, for issues filed before that change.

    Without this every open child issue would miss its lookup on the next run
    and be re-filed as new. Looked up only as a fallback; a hit is migrated to
    the current key so the fallback stops being needed.
    """
    raw = (cause.get("signature") or cause.get("title") or "").strip()
    return hashlib.sha256(_basis(repo, cause, raw).encode()).hexdigest()[:16]


def search_issue_by_key(token: str, repo: str, key: str) -> Optional[Dict]:
    q = urllib.parse.quote(f'repo:{repo} in:body "{KEY_PREFIX}: {key}"')
    res = _req("GET", f"/search/issues?q={q}&per_page=5", token)
    for item in res.get("items", []):
        if f"{KEY_PREFIX}: {key}" in (item.get("body") or ""):
            return item
    return None


# Parsers for the child-issue template written by child_body(), so a later run
# can read back what an earlier one recorded.
_CLUSTERS_SECTION = re.compile(r"(## Affected job clusters\n\n)(.*?)(?=\n## |\Z)", re.S)
_SIGNATURE_SECTION = re.compile(r"## Signature\n\n```\n(.*?)\n```", re.S)
_EXCEPTION_TYPE = re.compile(r"([A-Za-z_][\w.]*(?:Error|Exception|Warning|Failure))\b")

# Cluster overlap at or above this, with a matching exception type, is treated
# as one cause. 0.5 keeps a two-cluster issue matching when it gains a third,
# while a single shared cluster out of four stays distinct.
NEAR_DUP_JACCARD = 0.5


def issue_signature(body: str) -> str:
    m = _SIGNATURE_SECTION.search(body or "")
    return m.group(1).strip() if m else ""


def issue_clusters(body: str) -> List[str]:
    m = _CLUSTERS_SECTION.search(body or "")
    return re.findall(r"^- `([^`]+)`", m.group(2), re.M) if m else []


def exception_type(signature: str) -> str:
    """The exception class a signature reports, or "" if it names none.

    Only the first line is considered: that is where the raised type appears,
    and later lines may quote unrelated types from a traceback.
    """
    first = (normalize_signature(signature).splitlines() or [""])[0]
    m = _EXCEPTION_TYPE.search(first)
    return m.group(1) if m else ""


def jaccard(a: List[str], b: List[str]) -> float:
    sa, sb = {x.strip() for x in a}, {x.strip() for x in b}
    union = sa | sb
    return len(sa & sb) / len(union) if union else 0.0


def merge_clusters(body: str, clusters: List[str]) -> tuple:
    """Add unseen clusters to the issue's list. Returns (new_body, added)."""
    if not _CLUSTERS_SECTION.search(body or ""):
        return body, []
    existing = issue_clusters(body)
    added = [c.strip() for c in clusters if c.strip() and c.strip() not in existing]
    if not added:
        return body, []
    listing = "\n".join(f"- `{c}`" for c in existing + added)
    return _CLUSTERS_SECTION.sub(lambda m: m.group(1) + listing, body, count=1), added


def open_children(token: str, repo: str, minor: str = "") -> List[Dict]:
    """Open child issues, restricted to one torch minor when given.

    Children of a previous cycle stay open for a while after the version turns
    over, and near_duplicate() matches on exception type and cluster overlap
    alone -- enough for a fresh cause to land on last version's issue and never
    reach the current umbrella. Scope the candidates instead of teaching every
    matcher about versions.
    """
    q = urllib.parse.quote(f"repo:{repo} is:issue is:open label:{CHILD_LABEL}")
    res = _req("GET", f"/search/issues?q={q}&per_page=100", token)
    items = res.get("items", [])
    if not minor:
        return items
    return [i for i in items if f"[torch {minor}]" in (i.get("title") or "")]


def near_duplicate(cause: Dict[str, Any], children: List[Dict]) -> Optional[Dict]:
    """An open child that is the same cause described in different words.

    The key cannot catch this: the agent re-words a cause between runs and the
    hash moves with it. #8808 called it "DeepEPv2 communicator properties query
    failed", #8817 called it "Failed to determine NCCL GIN support" -- the same
    two B200 clusters, one bug, two issues.

    Matching is on exception type plus cluster overlap, deliberately not on
    message text: those two strings share only "RuntimeError" and "failed", so
    any text-similarity threshold loose enough to pair them would pair most
    unrelated RuntimeErrors too.

    Returns the best-overlapping match, or None.
    """
    et = exception_type(cause.get("signature") or "")
    mine = [c.strip() for c in cause.get("clusters") or [] if c.strip()]
    if not et or not mine:
        return None
    best, best_j = None, 0.0
    for child in children:
        body = child.get("body") or ""
        if exception_type(issue_signature(body)) != et:
            continue
        j = jaccard(mine, issue_clusters(body))
        if j >= NEAR_DUP_JACCARD and j > best_j:
            best, best_j = child, j
    return best


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
        f"{SECTIONS[VLLM_ROUTING]}\n\n"
        "<!-- Causes whose fix belongs in vLLM, not torch. Filed here so the\n"
        "     failing jobs are not re-triaged every run; link the upstream\n"
        "     vllm-project/vllm issue, or promote to pytorch/pytorch, by hand. -->\n\n"
        f"{SECTIONS[TORCH_ROUTING]}\n\n"
        "<!-- checklist: appended automatically, one entry per root cause -->\n"
    )


def insert_in_section(body: str, section: str, line: str) -> str:
    """Put ``line`` at the end of ``section``, creating the section if absent.

    Appending to the end of the body would file everything under whichever
    section happens to be last, which is how a vLLM-side cause would end up
    listed as a confirmed torch regression.
    """
    if line.strip() in body:
        return body
    if section not in body:
        return body.rstrip() + f"\n\n{section}\n\n{line}\n"
    head, _, rest = body.partition(section)
    # The section runs until the next heading of the same level.
    nxt = re.search(r"^### ", rest, re.M)
    if nxt:
        inner, tail = rest[: nxt.start()], rest[nxt.start() :]
        return head + section + inner.rstrip() + "\n" + line + "\n\n" + tail
    return head + section + rest.rstrip() + "\n" + line + "\n"


def append_to_umbrella(
    token: str, repo: str, umbrella: Dict, line: str, section: str
) -> None:
    fresh = _req("GET", f"/repos/{repo}/issues/{umbrella['number']}", token)
    body = fresh.get("body") or ""
    new = insert_in_section(body, section, line)
    if new == body:
        return
    _req("PATCH", f"/repos/{repo}/issues/{umbrella['number']}", token, {"body": new})


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
    routing = cause.get("routing", "undetermined")
    sections.append(
        f"## Suggested routing\n\n{routing} "
        f"(agent confidence: classification "
        f"{classification_confidence(cause) or 'unknown'}, new-failure "
        f"{new_failure_confidence(cause) or 'unknown'})"
    )
    if routing_of(cause) == VLLM_ROUTING:
        sections.append(
            "The fix for this one looks like it belongs in vLLM rather than "
            "torch. It is tracked here so the failing jobs are not re-triaged "
            "every run -- **the next step is a human one**: link the upstream "
            "`vllm-project/vllm` issue if it exists, open one if it does not, "
            "or re-route to `pytorch/pytorch` if this turns out to be a torch "
            "regression after all."
        )
    sections.append(
        "---\n\n"
        "Filed automatically by the vLLM torch-nightly triage workflow. The root "
        "cause above was produced by an automated analysis of the Buildkite log "
        "tail and has not been human-verified.\n\n"
        f"<!-- {KEY_PREFIX}: {key} -->"
    )
    return "\n\n".join(sections) + "\n"


def recurrence_comment(
    report: Dict[str, Any],
    cause: Dict[str, Any],
    added: List[str],
    all_clusters: List[str],
    matched_by: str,
) -> str:
    """The comment left on an already-filed cause.

    Says which clusters are new, because that is the part a reader cannot get
    from the issue body: the body shows the accumulated list, not that this run
    extended it. A cause spreading to a second accelerator or a second job
    family is evidence about the cause -- it rules out anything vendor- or
    job-specific -- so it is worth stating rather than silently merging.
    """
    build = report.get("torch_nightly_build")
    out = [
        f"Still reproducing on torch-nightly build "
        f"[#{build}](https://buildkite.com/vllm/ci/builds/{build})."
    ]
    if added:
        out += [
            "",
            "**Same signature on a new cluster.** This cause is not specific to "
            "the clusters already listed; newly seen on:",
            "",
            *(f"- `{c}`" for c in added),
            "",
            f"Affected job clusters in the body updated to {len(all_clusters)}.",
        ]
    if matched_by == "near-duplicate":
        out += [
            "",
            "Matched to this issue by exception type and overlapping clusters "
            "rather than by signature text -- this run's wording was:",
            "",
            "```",
            (cause.get("signature") or "").strip(),
            "```",
            "",
            "Filed here instead of as a new issue. If this is in fact a "
            "different cause, split it and the next run will track them apart.",
        ]
    return "\n".join(out)


SILENT_PREFIX = "vllm-triage-silent"
# Stop repeating after this many consecutive quiet runs. By then the issue says
# what it needs to; further runs would just add a comment a week.
SILENT_COMMENT_LIMIT = 3


def silent_streak(token: str, repo: str, number: int) -> int:
    """How many consecutive runs this cause has already been quiet for.

    Read back off the issue rather than held in state: the workflow keeps
    nothing between runs, and a comment that survives an edit to the body is
    the only durable record. A recurrence comment resets the count, so a cause
    that comes back and goes quiet again is announced again.
    """
    streak = 0
    try:
        comments = _req(
            "GET", f"/repos/{repo}/issues/{number}/comments?per_page=100", token
        )
    except urllib.error.URLError:
        return 0
    for c in comments or []:
        body = c.get("body") or ""
        m = re.search(rf"<!-- {SILENT_PREFIX}: (\d+) -->", body)
        if m:
            streak = int(m.group(1))
        elif "Still reproducing on torch-nightly build" in body:
            streak = 0
    return streak


def silence_comment(report: Dict[str, Any], clusters: List[str], streak: int) -> str:
    """Told the cause did not reproduce, and how far that is from proof."""
    build = report.get("torch_nightly_build")
    base = report.get("baseline_build")
    out = [
        f"Did not reproduce on torch-nightly build "
        f"[#{build}](https://buildkite.com/vllm/ci/builds/{build})"
        f" (baseline [#{base}](https://buildkite.com/vllm/ci/builds/{base})).",
        "",
        "Every cluster on this issue ran and passed on the nightly build:",
        "",
        *(f"- `{c}`" for c in clusters),
        "",
    ]
    if streak == 1:
        out.append(
            "First quiet run. Not closing yet -- one pass is also what a "
            "flaky cause looks like."
        )
    else:
        out.append(
            f"Quiet for {streak} consecutive runs. Candidate for closing; "
            "reopen automatically if the signature returns."
        )
    out += ["", f"<!-- {SILENT_PREFIX}: {streak} -->"]
    return "\n".join(out)


def report_silences(
    token: str,
    repo: str,
    report: Dict[str, Any],
    children: List[Dict],
    matched: set,
    minor: str,
) -> None:
    """Comment on tracked causes that did not come back this run.

    Silence is only reported when every cluster the issue names is in the
    run's ``passed`` set. A cluster that appears in no bucket at all did not
    run -- infrastructure killed it, or the pipeline dropped it -- and saying
    "did not reproduce" there would turn missing coverage into a false fix.
    """
    passed = {c.strip() for c in report.get("passed") or []}
    if not passed:
        print("  no passed-cluster data in report.json; skipping silence check")
        return
    for child in children:
        number = child["number"]
        if number in matched:
            continue
        if f"[torch {minor}]" not in (child.get("title") or ""):
            continue
        clusters = issue_clusters(child.get("body") or "")
        if not clusters:
            continue
        missing = [c for c in clusters if c not in passed]
        if missing:
            print(f"  #{number}: no coverage for {len(missing)} cluster(s); silent")
            continue
        streak = silent_streak(token, repo, number) + 1
        if streak > SILENT_COMMENT_LIMIT:
            print(f"  #{number}: quiet for {streak} runs, already said so")
            continue
        _req(
            "POST",
            f"/repos/{repo}/issues/{number}/comments",
            token,
            {"body": silence_comment(report, clusters, streak)},
        )
        print(f"  not reproducing -> #{number} (run {streak} of quiet)")


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


def routing_of(cause: Dict[str, Any]) -> str:
    return str(cause.get("routing", "")).strip().lower()


def eligible(cause: Dict[str, Any]) -> bool:
    """Medium-confidence causes with a repo to fix them in.

    Infra-looking clusters and anything the agent could not root-cause stay out of
    the tracker: at three runs a week, filing uncertain causes would bury the real
    ones. They remain visible in the run summary and the umbrella's context section.

    ``new_failure_confidence: low`` means "likely a variant of an existing known
    issue", so filing it would duplicate a child issue that already exists.

    Routing selects the umbrella section, not whether to file. It used to gate
    filing on ``pytorch/pytorch``, which silently dropped every vLLM-side cause
    however well evidenced -- the cuda-bindings 13.4 ``cudaIpcMemHandle_t``
    breakage was emitted with ``new_failure_confidence: high`` on three
    consecutive runs and discarded each time, and was eventually filed by hand as
    vllm-project/vllm#58599. Routing is a destination; confidence is the quality
    bar, and the fields above already carry it.
    """
    return (
        bool(cause.get("determined"))  # type: ignore[return-value]
        and classification_confidence(cause) != "low"
        and classification_confidence(cause)
        and new_failure_confidence(cause) != "low"
        and routing_of(cause) in FILED_ROUTINGS
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
            print(
                f"  child [{routing_of(c)}]: {c.get('title')}  "
                f"key={fingerprint(args.repo, c)}"
            )
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

    children = open_children(token, args.repo, minor)

    # Keyed by fingerprint, for causes filed earlier in this same run. The
    # search API is not read-your-writes, so two causes that normalize to one
    # key in a single run would otherwise both be filed.
    filed_this_run: Dict[str, Dict] = {}
    matched: set = set()

    for c in selected:
        key = fingerprint(args.repo, c)
        existing = filed_this_run.get(key) or search_issue_by_key(token, args.repo, key)
        matched_by = "key"
        if existing is None:
            # Older keys, newest scheme first. A hit is rewritten to the
            # current key so the fallback stops being needed.
            for stale in (
                cluster_fingerprint(args.repo, c),
                legacy_fingerprint(args.repo, c),
            ):
                if stale == key:
                    continue
                existing = search_issue_by_key(token, args.repo, stale)
                if existing:
                    _req(
                        "PATCH",
                        f"/repos/{args.repo}/issues/{existing['number']}",
                        token,
                        {
                            "body": (existing.get("body") or "").replace(
                                f"{KEY_PREFIX}: {stale}", f"{KEY_PREFIX}: {key}"
                            )
                        },
                    )
                    print(f"  migrated key {stale} -> {key}")
                    break
        if existing is None:
            candidate = near_duplicate(c, children)
            if candidate is not None:
                existing = _req(
                    "GET", f"/repos/{args.repo}/issues/{candidate['number']}", token
                )
                matched_by = "near-duplicate"
                print(
                    f"  near-duplicate of #{existing['number']} "
                    f"(same {exception_type(c.get('signature') or '')}, "
                    f"overlapping clusters): commenting instead of filing"
                )
        if existing:
            fresh = _req(
                "GET", f"/repos/{args.repo}/issues/{existing['number']}", token
            )
            body = fresh.get("body") or ""
            merged, added = merge_clusters(body, c.get("clusters") or [])
            if added:
                _req(
                    "PATCH",
                    f"/repos/{args.repo}/issues/{existing['number']}",
                    token,
                    {"body": merged},
                )
            _req(
                "POST",
                f"/repos/{args.repo}/issues/{existing['number']}/comments",
                token,
                {
                    "body": recurrence_comment(
                        report, c, added, issue_clusters(merged), matched_by
                    )
                },
            )
            matched.add(existing["number"])
            print(f"  recurrence -> #{existing['number']} ({matched_by})")
            continue
        routing = routing_of(c)
        vllm_side = routing == VLLM_ROUTING
        labels = [CHILD_LABEL] + ([VLLM_SIDE_LABEL] if vllm_side else [])
        prefix = "[vllm-side]" if vllm_side else ""
        issue = _req(
            "POST",
            f"/repos/{args.repo}/issues",
            token,
            {
                "title": f"[vllm][torch {minor}]{prefix} {c.get('title')}",
                "body": child_body(c, report, key),
                "labels": labels,
            },
        )
        print(f"  created #{issue['number']} [{routing}]: {c.get('title')}")
        # Visible to the rest of this run, by key and to the near-duplicate scan.
        filed_this_run[key] = issue
        children.append(issue)
        matched.add(issue["number"])
        append_to_umbrella(
            token,
            args.repo,
            umbrella,
            f"- [ ] #{issue['number']} - {c.get('title')}",
            SECTIONS[routing],
        )

    report_silences(token, args.repo, report, children, matched, minor)
    return 0


if __name__ == "__main__":
    sys.exit(main())
