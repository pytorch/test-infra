"""Whether a ``gate`` repo's ``main`` enforces what GreenLight's approvals rely on there.

GitHub's rules API reports every active rule on the branch, whatever ruleset (repository or organization)
configured it. The gate is enforced only when all of these hold:

- a ``workflows`` rule requires ``constants.GATE_WORKFLOW_PATH`` from ``constants.GATE_SOURCE_REPO_ID``,
  pinned to a full commit sha (its ``ref``, when set, is that sha), so the gate cannot be swapped for a
  workflow the target repo controls;
- a ``pull_request`` rule requires at least one approving review, so an approval is what a merge needs;
- no ``pull_request`` rule restricts who may dismiss reviews, which would keep GreenLight from dismissing its own;
- no ``merge_queue`` rule applies, since a queued merge lands a commit the gate never judged;
- classic branch protection is off, as its settings sit outside the rules API.

A read failure or a payload of an unexpected shape raises: the caller decides what an unknown answer means.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from greenlight import constants
from greenlight.approvals import payload_is, payload_mapping, payload_required

if TYPE_CHECKING:
    from greenlight.github_types import JsonRequester

RULES_PER_PAGE = 100

_SHA = re.compile(r"[0-9a-fA-F]{40}")
_RULE_WORKFLOWS = "workflows"
_RULE_PULL_REQUEST = "pull_request"
_RULE_MERGE_QUEUE = "merge_queue"

NO_PINNED_GATE = (
    f"no workflows rule requires {constants.GATE_WORKFLOW_PATH} from repository {constants.GATE_SOURCE_REPO_ID} "
    "pinned to a commit sha"
)
NO_REQUIRED_APPROVAL = "no pull_request rule requires an approving review"
DISMISSAL_RESTRICTED = "a pull_request rule restricts who may dismiss reviews"
MERGE_QUEUE = "a merge_queue rule applies"
CLASSIC_PROTECTION = f"classic branch protection is enabled on {constants.TARGET_BRANCH}"


class _RequesterClient(Protocol):
    @property
    def requester(self) -> JsonRequester: ...


@dataclass(frozen=True)
class GateRules:
    enforced: bool
    problems: tuple[str, ...] = ()


def _parameters(rule: dict[str, Any]) -> dict[str, Any]:
    return payload_mapping(rule.get("parameters"), f"{rule['type']} rule parameters")


def _pins_gate(workflow: object) -> bool:
    entry = payload_mapping(workflow, "workflows rule entry")
    sha = entry.get("sha")
    repository_id = entry.get("repository_id")
    return (
        payload_is(repository_id, int)
        and repository_id == constants.GATE_SOURCE_REPO_ID
        and entry.get("path") == constants.GATE_WORKFLOW_PATH
        and isinstance(sha, str)
        and _SHA.fullmatch(sha) is not None
        and entry.get("ref") in (None, "", sha)
    )


def _requires_gate(rule: dict[str, Any]) -> bool:
    workflows = _parameters(rule).get("workflows")
    if not isinstance(workflows, list):
        raise ValueError(f"workflows rule parameters carry no workflows list: {workflows!r}")
    pins = [_pins_gate(workflow) for workflow in workflows]
    return any(pins)


def _requires_approval(rule: dict[str, Any]) -> bool:
    return (
        payload_required(_parameters(rule), "required_approving_review_count", int, "pull_request rule parameters") >= 1
    )


def _restricts_dismissal(rule: dict[str, Any]) -> bool:
    restriction = _parameters(rule).get("dismissal_restriction")
    if restriction is None:
        return False
    enabled = payload_mapping(restriction, "pull_request rule dismissal_restriction").get("enabled", False)
    if not isinstance(enabled, bool):
        raise ValueError(f"pull_request rule dismissal_restriction.enabled is not a boolean: {enabled!r}")
    return enabled


def _protection_enabled(branch: dict[str, Any]) -> bool:
    enabled = payload_mapping(branch.get("protection"), "branch protection").get("enabled")
    if not isinstance(enabled, bool):
        raise ValueError(f"branch protection.enabled is not a boolean: {enabled!r}")
    return enabled


def assess(rules: list[Any], branch: dict[str, Any]) -> GateRules:
    """Judge the branch's active ``rules`` and its ``branch`` payload; raises ``ValueError`` on an unexpected shape."""
    by_type: dict[str, list[dict[str, Any]]] = {}
    for item in rules:
        rule = payload_mapping(item, "rule")
        kind = rule.get("type")
        if not isinstance(kind, str):
            raise ValueError(f"rule type is not a string: {kind!r}")
        by_type.setdefault(kind, []).append(rule)
    pull_request = by_type.get(_RULE_PULL_REQUEST, [])
    gates = [_requires_gate(rule) for rule in by_type.get(_RULE_WORKFLOWS, [])]
    approvals = [_requires_approval(rule) for rule in pull_request]
    restrictions = [_restricts_dismissal(rule) for rule in pull_request]
    checks = (
        (not any(gates), NO_PINNED_GATE),
        (not any(approvals), NO_REQUIRED_APPROVAL),
        (any(restrictions), DISMISSAL_RESTRICTED),
        (_RULE_MERGE_QUEUE in by_type, MERGE_QUEUE),
        (_protection_enabled(branch), CLASSIC_PROTECTION),
    )
    problems = tuple(problem for failed, problem in checks if failed)
    return GateRules(enforced=not problems, problems=problems)


def read_gate_rules(client: _RequesterClient, repo: str) -> GateRules:
    """Read ``repo``'s active rules on ``TARGET_BRANCH`` (every page) and the branch itself, and ``assess`` them."""
    requester = client.requester
    rules: list[Any] = []
    page = 1
    while True:
        _headers, data = requester.requestJsonAndCheck(
            "GET",
            f"/repos/{repo}/rules/branches/{constants.TARGET_BRANCH}",
            parameters={"per_page": RULES_PER_PAGE, "page": page},
        )
        if not isinstance(data, list):
            raise ValueError(f"rules page {page} of {repo} is not a list: {type(data).__name__}")
        rules.extend(data)
        if len(data) < RULES_PER_PAGE:
            break
        page += 1
    _headers, branch = requester.requestJsonAndCheck("GET", f"/repos/{repo}/branches/{constants.TARGET_BRANCH}")
    return assess(rules, payload_mapping(branch, f"branch {constants.TARGET_BRANCH} of {repo}"))
