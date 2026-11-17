from __future__ import annotations

import copy
from typing import Any

import pytest

from greenlight import constants, gate_rules
from greenlight.gate_rules import GateRules, assess, read_gate_rules

_PIN = "0123456789abcdef0123456789abcdef01234567"
_REPO = "pytorch/vision"

# Trimmed from `gh api repos/pytorch/test-infra/rules/branches/main` (2026-11-17), plus the pinned gate.
_GATE_RULE: dict[str, Any] = {
    "type": "workflows",
    "parameters": {
        "do_not_enforce_on_create": False,
        "workflows": [
            {"path": ".github/workflows/lint.yml", "repository_id": 1, "ref": "refs/heads/main"},
            {
                "path": constants.GATE_WORKFLOW_PATH,
                "repository_id": constants.GATE_SOURCE_REPO_ID,
                "ref": None,
                "sha": _PIN,
            },
        ],
    },
    "ruleset_source_type": "Organization",
    "ruleset_source": "pytorch",
    "ruleset_id": 1,
}
_PULL_REQUEST_RULE: dict[str, Any] = {
    "type": "pull_request",
    "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": False,
        "require_code_owner_review": True,
        "dismissal_restriction": {"enabled": False, "allowed_actors": []},
        "require_last_push_approval": False,
    },
    "ruleset_source_type": "Repository",
    "ruleset_source": _REPO,
    "ruleset_id": 25119933,
}
_DELETION_RULE: dict[str, Any] = {"type": "deletion", "ruleset_source_type": "Repository", "ruleset_id": 25119933}
# `gh api repos/pytorch/test-infra/branches/main`: rulesets only, classic protection off.
_BRANCH: dict[str, Any] = {
    "name": "main",
    "protected": True,
    "protection": {"enabled": False, "required_status_checks": {"enforcement_level": "off", "contexts": []}},
}
# `gh api repos/pytorch/executorch/branches/main`: classic protection on.
_PROTECTED_BRANCH: dict[str, Any] = {
    "name": "main",
    "protected": True,
    "protection": {"enabled": True, "required_status_checks": {"enforcement_level": "non_admins"}},
}


def _rules() -> list[dict[str, Any]]:
    return copy.deepcopy([_DELETION_RULE, _GATE_RULE, _PULL_REQUEST_RULE])


def _gate_entry(rules: list[dict[str, Any]]) -> dict[str, Any]:
    entry: dict[str, Any] = rules[1]["parameters"]["workflows"][1]
    return entry


def test_the_rules_that_pin_the_gate_and_require_an_approval_enforce_it():
    assert assess(_rules(), copy.deepcopy(_BRANCH)) == GateRules(enforced=True, problems=())


@pytest.mark.parametrize("ref", [None, "", _PIN], ids=["null", "empty", "the-sha"])
def test_a_ref_beside_the_sha_is_fine_only_when_absent_empty_or_the_sha_itself(ref):
    rules = _rules()
    _gate_entry(rules)["ref"] = ref

    assert assess(rules, _BRANCH).enforced is True


def test_an_absent_ref_pins_the_gate():
    rules = _rules()
    del _gate_entry(rules)["ref"]

    assert assess(rules, _BRANCH).enforced is True


def test_an_uppercase_sha_pins_the_gate():
    rules = _rules()
    _gate_entry(rules)["sha"] = _PIN.upper()

    assert assess(rules, _BRANCH).enforced is True


@pytest.mark.parametrize(
    "change",
    [
        pytest.param({"ref": "refs/heads/main"}, id="ref-beside-the-sha"),
        pytest.param({"sha": None}, id="no-sha"),
        pytest.param({"sha": _PIN[:39]}, id="short-sha"),
        pytest.param({"sha": "g" * 40}, id="not-hex"),
        pytest.param({"repository_id": 1}, id="another-repository"),
        pytest.param({"repository_id": str(constants.GATE_SOURCE_REPO_ID)}, id="repository-id-as-text"),
        pytest.param({"path": ".github/workflows/other.yml"}, id="another-path"),
    ],
)
def test_a_gate_workflow_that_is_not_pinned_from_test_infra_is_not_enforced(change):
    rules = _rules()
    _gate_entry(rules).update(change)

    assert assess(rules, _BRANCH) == GateRules(enforced=False, problems=(gate_rules.NO_PINNED_GATE,))


def test_no_workflows_rule_is_not_enforced():
    rules = [rule for rule in _rules() if rule["type"] != "workflows"]

    assert assess(rules, _BRANCH).problems == (gate_rules.NO_PINNED_GATE,)


def test_a_pull_request_rule_requiring_no_approval_is_not_enforced():
    rules = _rules()
    rules[2]["parameters"]["required_approving_review_count"] = 0

    assert assess(rules, _BRANCH).problems == (gate_rules.NO_REQUIRED_APPROVAL,)


def test_no_pull_request_rule_is_not_enforced():
    rules = [rule for rule in _rules() if rule["type"] != "pull_request"]

    assert assess(rules, _BRANCH).problems == (gate_rules.NO_REQUIRED_APPROVAL,)


def test_any_pull_request_rule_requiring_an_approval_is_enough():
    lenient = copy.deepcopy(_PULL_REQUEST_RULE)
    lenient["parameters"]["required_approving_review_count"] = 0

    assert assess([lenient, *_rules()], _BRANCH).enforced is True


def test_a_dismissal_restriction_on_any_pull_request_rule_is_not_enforced():
    restricted = copy.deepcopy(_PULL_REQUEST_RULE)
    restricted["parameters"]["required_approving_review_count"] = 0
    restricted["parameters"]["dismissal_restriction"] = {"enabled": True, "allowed_actors": [{"id": 1, "type": "Team"}]}

    assert assess([*_rules(), restricted], _BRANCH).problems == (gate_rules.DISMISSAL_RESTRICTED,)


def test_a_pull_request_rule_with_no_dismissal_restriction_field_restricts_nothing():
    rules = _rules()
    del rules[2]["parameters"]["dismissal_restriction"]

    assert assess(rules, _BRANCH).enforced is True


def test_a_merge_queue_is_not_enforced():
    rules = [*_rules(), {"type": "merge_queue", "parameters": {"merge_method": "MERGE"}}]

    assert assess(rules, _BRANCH).problems == (gate_rules.MERGE_QUEUE,)


def test_classic_branch_protection_is_not_enforced():
    assert assess(_rules(), copy.deepcopy(_PROTECTED_BRANCH)).problems == (gate_rules.CLASSIC_PROTECTION,)


def test_every_failing_condition_names_its_own_problem():
    rules = [_DELETION_RULE, {"type": "merge_queue", "parameters": {}}]

    assert assess(rules, _PROTECTED_BRANCH) == GateRules(
        enforced=False,
        problems=(
            gate_rules.NO_PINNED_GATE,
            gate_rules.NO_REQUIRED_APPROVAL,
            gate_rules.MERGE_QUEUE,
            gate_rules.CLASSIC_PROTECTION,
        ),
    )


@pytest.mark.parametrize(
    ("rules", "branch"),
    [
        pytest.param(["deletion"], _BRANCH, id="rule-not-an-object"),
        pytest.param([{"ruleset_id": 1}], _BRANCH, id="rule-without-a-type"),
        pytest.param([{"type": "workflows"}], _BRANCH, id="workflows-without-parameters"),
        pytest.param([{"type": "workflows", "parameters": {"workflows": {}}}], _BRANCH, id="workflows-not-a-list"),
        pytest.param([{"type": "workflows", "parameters": {"workflows": ["x"]}}], _BRANCH, id="workflow-not-an-object"),
        pytest.param([{"type": "pull_request", "parameters": {}}], _BRANCH, id="no-review-count"),
        pytest.param(
            [{"type": "pull_request", "parameters": {"required_approving_review_count": True}}],
            _BRANCH,
            id="review-count-a-boolean",
        ),
        pytest.param(
            [
                {
                    "type": "pull_request",
                    "parameters": {"required_approving_review_count": 1, "dismissal_restriction": []},
                }
            ],
            _BRANCH,
            id="dismissal-restriction-not-an-object",
        ),
        pytest.param(
            [
                {
                    "type": "pull_request",
                    "parameters": {"required_approving_review_count": 1, "dismissal_restriction": {"enabled": "no"}},
                }
            ],
            _BRANCH,
            id="dismissal-restriction-enabled-not-a-boolean",
        ),
        pytest.param([], {"name": "main", "protected": True}, id="branch-without-protection"),
        pytest.param([], {"protection": {"enabled": None}}, id="protection-enabled-not-a-boolean"),
    ],
)
def test_an_unexpected_shape_raises(rules, branch):
    with pytest.raises(ValueError):
        assess(rules, branch)


def test_a_shape_error_in_a_later_rule_raises_even_when_an_earlier_one_already_decides():
    rules = [*_rules(), {"type": "workflows", "parameters": {}}]

    with pytest.raises(ValueError, match="workflows rule parameters"):
        assess(rules, _BRANCH)


class _FakeRequester:
    def __init__(self, pages: list[object], branch: object) -> None:
        self.pages = pages
        self.branch = branch
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def requestJsonAndCheck(
        self,
        verb: str,
        url: str,
        parameters: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        input: Any | None = None,
    ) -> tuple[dict[str, Any], Any]:
        self.calls.append((verb, url, parameters))
        if "/rules/" in url:
            assert parameters is not None
            return {}, self.pages[parameters["page"] - 1]
        return {}, self.branch


class _FakeClient:
    def __init__(self, requester: _FakeRequester) -> None:
        self.requester = requester


def test_read_gate_rules_reads_every_rules_page_then_the_branch():
    filler = [copy.deepcopy(_DELETION_RULE) for _ in range(gate_rules.RULES_PER_PAGE - 1)]
    pages: list[object] = [[*filler, copy.deepcopy(_GATE_RULE)], [copy.deepcopy(_PULL_REQUEST_RULE)]]
    requester = _FakeRequester(pages, copy.deepcopy(_BRANCH))

    assert read_gate_rules(_FakeClient(requester), _REPO) == GateRules(enforced=True)
    assert requester.calls == [
        ("GET", f"/repos/{_REPO}/rules/branches/main", {"per_page": 100, "page": 1}),
        ("GET", f"/repos/{_REPO}/rules/branches/main", {"per_page": 100, "page": 2}),
        ("GET", f"/repos/{_REPO}/branches/main", None),
    ]


def test_read_gate_rules_stops_at_a_short_first_page():
    requester = _FakeRequester([_rules()], copy.deepcopy(_PROTECTED_BRANCH))

    assert read_gate_rules(_FakeClient(requester), _REPO).problems == (gate_rules.CLASSIC_PROTECTION,)
    assert [url for _verb, url, _parameters in requester.calls] == [
        f"/repos/{_REPO}/rules/branches/main",
        f"/repos/{_REPO}/branches/main",
    ]


@pytest.mark.parametrize(
    ("pages", "branch"),
    [
        pytest.param([{"message": "Not Found"}], _BRANCH, id="rules-page-not-a-list"),
        pytest.param([[]], ["main"], id="branch-not-an-object"),
    ],
)
def test_read_gate_rules_raises_on_an_unexpected_payload(pages, branch):
    with pytest.raises(ValueError):
        read_gate_rules(_FakeClient(_FakeRequester(pages, branch)), _REPO)


def test_read_gate_rules_propagates_a_read_failure():
    class _Failing(_FakeRequester):
        def requestJsonAndCheck(
            self,
            verb: str,
            url: str,
            parameters: dict[str, Any] | None = None,
            headers: dict[str, str] | None = None,
            input: Any | None = None,
        ) -> tuple[dict[str, Any], Any]:
            raise RuntimeError("502")

    with pytest.raises(RuntimeError, match="502"):
        read_gate_rules(_FakeClient(_Failing([], {})), _REPO)
