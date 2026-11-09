#!/usr/bin/env python3
"""Load, merge and validate the PyTorch Release Portal config.

The config is a shared file, release/portal/config/steps.yml, that defines the phases
and steps of a release, and one file per release, release/portal/config/releases/
<version>.yml, that changes them for that release. The portal collector and the
release API read the *resolved* config: the shared steps with the release's `remove`,
`override` and `add` applied. See release/portal/README.md for the schema.

Run from tools/:

    python3 -m torchci.release_portal_config                  # validate everything
    python3 -m torchci.release_portal_config --release 2.16.0 --print   # resolved JSON
    python3 -m torchci.release_portal_config --release 2.16.0 --discover  # find its GitHub objects

The milestone, tracker issue and validation issue of a release are not written in its
file: the rules under `discovery` in steps.yml find them (see discover_links).
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO_ROOT / "release" / "portal" / "config"
SHARED_FILE = CONFIG_DIR / "steps.yml"
RELEASES_DIR = CONFIG_DIR / "releases"

TIERS = ("A", "S", "K", "M")
ANCHORS = ("branch_cut", "final_rc", "ga")
RELEASE_TYPES = ("minor", "patch")
STEP_ID = re.compile(r"^(?P<phase>\d+)\.(?P<n>\d+)$")
VERSION = re.compile(r"^\d+\.\d+\.\d+$")
TEMPLATE_VARIABLES = (
    "version",
    "minor",
    "branch",
    "rc",
    "tracker_issue",
    "validation_issue",
    "milestone",
    "tracker_issue_url",
    "validation_issue_url",
)
_PLACEHOLDER = re.compile(r"\{([^{}]*)\}")

# Check types: the parameters each takes. "required" must be present; "optional" may be;
# nothing else is allowed. A check type without parameters has empty sets.
CHECK_TYPES: Dict[str, Dict[str, Set[str]]] = {
    "manual_link": {"required": {"what_to_check", "link"}, "optional": set()},
    "url_exists": {"required": {"url"}, "optional": set()},
    "github_issue_state": {
        "required": {"repo", "issue", "expect"},
        "optional": set(),
    },
    "milestone_outstanding_items": {
        "required": {"repo", "milestone", "max_outstanding"},
        "optional": set(),
    },
    "reverts_missing_from_branch": {
        "required": {"repo", "branch"},
        "optional": set(),
    },
    "github_ref_exists": {
        "required": {"repos", "ref", "kind"},
        "optional": set(),
    },
    "github_workflow_run": {
        "required": {"repo", "workflow", "ref"},
        "optional": set(),
    },
    "index_listing": {
        "required": {"index", "channel", "package_types"},
        "optional": set(),
    },
    "crcr_summary": {"required": set(), "optional": set()},
}
ISSUE_EXPECT = ("open", "closed")
REF_KINDS = ("branch", "tag")
INDEXES = ("download.pytorch.org", "pypi", "dockerhub")
CHANNELS = ("test", "release")
PACKAGE_TYPES = ("wheel", "libtorch", "docker")

WINDOW_OPENS = ("branch_cut",)
WINDOW_CLOSES = ("ga",)

STEP_FIELDS = {
    "id",
    "phase",
    "name",
    "tier",
    "owner",
    "check",
    "rc_scoped",
    "depends_on",
    "due",
    "runbook",
    "types",
    "window",
}
REQUIRED_STEP_FIELDS = ("id", "phase", "name", "tier", "owner", "check")
RUNBOOK_KEYS = ("script", "skill", "url")

DISCOVERY_KINDS = ("milestone", "tracker_issue", "validation_issue")
LINK_KEYS = DISCOVERY_KINDS
DISCOVERY_VARIABLES = ("version", "minor")


class ConfigError(Exception):
    """The config is invalid; the message names the file and the step."""

    def __init__(self, errors: List[str]):
        super().__init__("\n".join(errors))
        self.errors = errors


def _load(path: Path) -> Any:
    with open(path) as f:
        return yaml.safe_load(f)


def _placeholders(value: Any) -> Set[str]:
    """Every {name} in a string, or in the strings of a list or map."""
    if isinstance(value, str):
        return set(_PLACEHOLDER.findall(value))
    if isinstance(value, list):
        return set().union(*(_placeholders(v) for v in value)) if value else set()
    if isinstance(value, dict):
        return (
            set().union(*(_placeholders(v) for v in value.values())) if value else set()
        )
    return set()


def _check_errors(where: str, check: Any) -> List[str]:
    if not isinstance(check, dict) or "type" not in check:
        return [f"{where}: check must be a map with a `type`"]
    ctype = check["type"]
    if ctype not in CHECK_TYPES:
        return [f"{where}: unknown check type {ctype!r}; one of {sorted(CHECK_TYPES)}"]
    spec = CHECK_TYPES[ctype]
    params = set(check) - {"type"}
    errors = []
    missing = spec["required"] - params
    extra = params - spec["required"] - spec["optional"]
    if missing:
        errors.append(f"{where}: check {ctype} is missing {sorted(missing)}")
    if extra:
        errors.append(f"{where}: check {ctype} does not take {sorted(extra)}")

    def one_of(key: str, allowed: tuple) -> None:
        if key in check and check[key] not in allowed:
            errors.append(
                f"{where}: check {ctype} `{key}` must be one of {list(allowed)}"
            )

    if ctype == "github_issue_state":
        one_of("expect", ISSUE_EXPECT)
    elif ctype == "github_ref_exists":
        one_of("kind", REF_KINDS)
        repos = check.get("repos")
        if "repos" in check and (
            not isinstance(repos, list)
            or not repos
            or not all(isinstance(r, str) and "/" in r for r in repos)
        ):
            errors.append(
                f"{where}: check github_ref_exists `repos` must be a list of owner/name"
            )
    elif ctype == "index_listing":
        one_of("index", INDEXES)
        one_of("channel", CHANNELS)
        types = check.get("package_types")
        if "package_types" in check and (
            not isinstance(types, list)
            or not types
            or not all(t in PACKAGE_TYPES for t in types)
        ):
            errors.append(
                f"{where}: check index_listing `package_types` must be a non-empty list from {list(PACKAGE_TYPES)}"
            )
    elif ctype == "milestone_outstanding_items":
        if "max_outstanding" in check and (
            not isinstance(check["max_outstanding"], int)
            or isinstance(check["max_outstanding"], bool)
            or check["max_outstanding"] < 0
        ):
            errors.append(
                f"{where}: check milestone_outstanding_items `max_outstanding` must be a non-negative integer"
            )

    unknown = _placeholders({k: v for k, v in check.items() if k != "type"}) - set(
        TEMPLATE_VARIABLES
    )
    if unknown:
        errors.append(
            f"{where}: unknown template variable(s) {sorted(unknown)}; one of {list(TEMPLATE_VARIABLES)}"
        )
    return errors


def _step_errors(where: str, step: Any) -> List[str]:
    if not isinstance(step, dict):
        return [f"{where}: a step must be a map"]
    errors = []
    missing = [f for f in REQUIRED_STEP_FIELDS if f not in step]
    if missing:
        errors.append(f"{where}: missing {missing}")
    extra = set(step) - STEP_FIELDS
    if extra:
        errors.append(f"{where}: unknown field(s) {sorted(extra)}")
    sid = step.get("id")
    if "id" in step:
        match = STEP_ID.match(sid) if isinstance(sid, str) else None
        if not match:
            errors.append(f'{where}: id {sid!r} must be a string like "2.3"')
        elif "phase" in step and int(match["phase"]) != step["phase"]:
            errors.append(f"{where}: id {sid} does not belong to phase {step['phase']}")
    if "tier" in step and step["tier"] not in TIERS:
        errors.append(f"{where}: tier {step['tier']!r} must be one of {list(TIERS)}")
    for key in ("name", "owner"):
        if key in step and not (isinstance(step[key], str) and step[key].strip()):
            errors.append(f"{where}: {key} must be a non-empty string")
    if "rc_scoped" in step and not isinstance(step["rc_scoped"], bool):
        errors.append(f"{where}: rc_scoped must be true or false")
    if "depends_on" in step and not (
        isinstance(step["depends_on"], list)
        and all(isinstance(d, str) for d in step["depends_on"])
    ):
        errors.append(f"{where}: depends_on must be a list of step ids")
    if "due" in step:
        due = step["due"]
        if not (
            isinstance(due, dict)
            and set(due) == {"anchor", "offset_days"}
            and due["anchor"] in ANCHORS
            and isinstance(due["offset_days"], int)
            and not isinstance(due["offset_days"], bool)
        ):
            errors.append(
                f"{where}: due must be {{anchor: one of {list(ANCHORS)}, offset_days: integer}}"
            )
    if "types" in step:
        types = step["types"]
        if not (
            isinstance(types, list)
            and types
            and len(set(types)) == len(types)
            and all(t in RELEASE_TYPES for t in types)
        ):
            errors.append(
                f"{where}: types must be a non-empty list from {list(RELEASE_TYPES)}"
            )
    if "window" in step:
        window = step["window"]
        if not (
            isinstance(window, dict)
            and window
            and set(window) <= {"opens", "closes"}
            and window.get("opens", WINDOW_OPENS[0]) in WINDOW_OPENS
            and window.get("closes", WINDOW_CLOSES[0]) in WINDOW_CLOSES
        ):
            errors.append(
                f"{where}: window must have `opens` ({list(WINDOW_OPENS)}) and/or `closes` ({list(WINDOW_CLOSES)})"
            )
    if "runbook" in step:
        runbook = step["runbook"]
        if not (
            isinstance(runbook, dict)
            and len(runbook) == 1
            and next(iter(runbook)) in RUNBOOK_KEYS
            and isinstance(next(iter(runbook.values())), str)
        ):
            errors.append(
                f"{where}: runbook must have exactly one of {list(RUNBOOK_KEYS)}"
            )
    if "check" in step:
        errors.extend(_check_errors(where, step["check"]))
    return errors


def validate_shared(shared: Any, name: str = "steps.yml") -> List[str]:
    if not isinstance(shared, dict):
        return [f"{name}: must be a map"]
    errors = []
    if shared.get("version") != 1:
        errors.append(f"{name}: version must be 1")
    phases = shared.get("phases")
    phase_ids: Set[int] = set()
    if not isinstance(phases, list) or not phases:
        errors.append(f"{name}: phases must be a non-empty list")
    else:
        for phase in phases:
            ok = (
                isinstance(phase, dict)
                and set(phase) == {"id", "name"}
                and isinstance(phase["id"], int)
                and isinstance(phase["name"], str)
                and phase["name"].strip()
            )
            if not ok:
                errors.append(
                    f"{name}: a phase must be {{id: integer, name: string}}, got {phase!r}"
                )
            elif phase["id"] in phase_ids:
                errors.append(f"{name}: duplicate phase id {phase['id']}")
            else:
                phase_ids.add(phase["id"])
    errors.extend(_discovery_errors(name, shared.get("discovery")))
    errors.extend(_resources_errors(name, shared.get("resources")))
    steps = shared.get("steps")
    if not isinstance(steps, list) or not steps:
        errors.append(f"{name}: steps must be a non-empty list")
        return errors
    errors.extend(_steps_errors(name, steps, phase_ids))
    return errors


RESOURCE_NAME = re.compile(r"^[a-z][a-z_]*$")
RESOURCE_VARIABLES = ("version", "minor", "branch")


def _resources_errors(name: str, resources: Any) -> List[str]:
    if not isinstance(resources, dict) or not resources:
        return [f"{name}: resources must be a non-empty map of link name to URL"]
    errors = []
    for key, value in resources.items():
        where = f"{name}: resources.{key}"
        if not (isinstance(key, str) and RESOURCE_NAME.match(key)):
            errors.append(
                f"{where}: a link name must be lower-case letters and underscores"
            )
        urls = (
            list(value.values())
            if isinstance(value, dict) and set(value) == {"test", "release"}
            else [value]
        )
        if isinstance(value, dict) and set(value) != {"test", "release"}:
            errors.append(f"{where}: a map needs exactly `test` and `release`")
            continue
        for url in urls:
            if not (isinstance(url, str) and url.startswith("https://")):
                errors.append(f"{where}: a URL must be a string starting with https://")
                continue
            unknown = _placeholders(url) - set(RESOURCE_VARIABLES)
            if unknown:
                errors.append(
                    f"{where}: unknown variable(s) {sorted(unknown)}; one of {list(RESOURCE_VARIABLES)}"
                )
    return errors


def _discovery_errors(name: str, discovery: Any) -> List[str]:
    if not isinstance(discovery, dict) or set(discovery) != set(DISCOVERY_KINDS):
        return [f"{name}: discovery must have exactly {list(DISCOVERY_KINDS)}"]
    errors = []
    for kind, rule in discovery.items():
        where = f"{name}: discovery.{kind}"
        if not isinstance(rule, dict):
            errors.append(f"{where} must be a map")
            continue
        required = (
            {"repo", "title"}
            if kind == "milestone"
            else {"repo", "query", "title_regex"}
        )
        if set(rule) != required:
            errors.append(f"{where} must have exactly {sorted(required)}")
            continue
        if not (isinstance(rule["repo"], str) and "/" in rule["repo"]):
            errors.append(f"{where}: repo must be owner/name")
        patterns = rule["title"] if kind == "milestone" else rule["title_regex"]
        if isinstance(patterns, dict):
            if kind == "milestone" or set(patterns) != set(RELEASE_TYPES):
                errors.append(
                    f"{where}: a title_regex map needs exactly {list(RELEASE_TYPES)}"
                )
                continue
            patterns = list(patterns.values())
        else:
            patterns = [patterns]
        for pattern in patterns:
            if not (isinstance(pattern, str) and pattern):
                errors.append(f"{where}: the title pattern must be a non-empty string")
                continue
            unknown = _placeholders(pattern) - set(DISCOVERY_VARIABLES)
            if unknown:
                errors.append(
                    f"{where}: unknown variable(s) {sorted(unknown)}; one of {list(DISCOVERY_VARIABLES)}"
                )
            elif kind != "milestone":
                try:
                    re.compile(_fill(pattern, "2.16.0", escape=True))
                except re.error as e:
                    errors.append(f"{where}: title_regex is not a valid regex: {e}")
    return errors


def _steps_errors(name: str, steps: List[Any], phase_ids: Set[int]) -> List[str]:
    errors: List[str] = []
    seen: Set[str] = set()
    for i, step in enumerate(steps):
        sid = step.get("id") if isinstance(step, dict) else None
        where = f"{name}: step {sid}" if sid else f"{name}: step #{i + 1}"
        errors.extend(_step_errors(where, step))
        if isinstance(step, dict):
            if sid in seen:
                errors.append(f"{where}: duplicate id")
            seen.add(sid)
            if "phase" in step and phase_ids and step["phase"] not in phase_ids:
                errors.append(f"{where}: phase {step['phase']} is not defined")
    errors.extend(_dependency_errors(name, steps))
    return errors


def _dependency_errors(name: str, steps: List[Any]) -> List[str]:
    deps = {
        s["id"]: s.get("depends_on", [])
        for s in steps
        if isinstance(s, dict)
        and isinstance(s.get("id"), str)
        and isinstance(s.get("depends_on", []), list)
    }
    errors = []
    for sid, ds in deps.items():
        for d in ds:
            if d not in deps:
                errors.append(f"{name}: step {sid} depends on unknown step {d}")
            elif d == sid:
                errors.append(f"{name}: step {sid} depends on itself")
    # a cycle shows up as a node that cannot be ordered
    remaining = {
        sid: {d for d in ds if d in deps and d != sid} for sid, ds in deps.items()
    }
    while remaining:
        ready = [sid for sid, ds in remaining.items() if not ds]
        if not ready:
            errors.append(f"{name}: dependency cycle among steps {sorted(remaining)}")
            break
        for sid in ready:
            del remaining[sid]
        for ds in remaining.values():
            ds.difference_update(ready)
    return errors


def _release_type(version: str) -> str:
    """A release X.Y.0 is a minor release; X.Y.Z with Z > 0 is a patch release."""
    return "minor" if version.endswith(".0") else "patch"


def _branch(version: str) -> str:
    return "release/" + ".".join(version.split(".")[:2])


def _fill(template: str, version: str, escape: bool = False) -> str:
    minor = ".".join(version.split(".")[:2])
    values = {"version": version, "minor": minor}
    if escape:
        values = {k: re.escape(v) for k, v in values.items()}
    return _PLACEHOLDER.sub(lambda m: values[m.group(1)], template)


def validate_release_file(release: Any, name: str) -> List[str]:
    if not isinstance(release, dict):
        return [f"{name}: must be a map"]
    errors = []
    allowed = {
        "release",
        "type",
        "branch",
        "dates",
        "links",
        "remove",
        "override",
        "add",
    }
    extra = set(release) - allowed
    if extra:
        errors.append(f"{name}: unknown field(s) {sorted(extra)}")
    version = release.get("release")
    if not (isinstance(version, str) and VERSION.match(version)):
        errors.append(f'{name}: release must be a string like "2.16.0"')
    elif Path(name).stem != version:
        errors.append(f"{name}: release {version} does not match the file name")
    version_ok = isinstance(version, str) and VERSION.match(version)
    if "type" in release and release["type"] != _release_type(
        version if version_ok else ""
    ):
        errors.append(
            f"{name}: type {release['type']!r} does not follow from the version"
        )
    if "branch" in release and version_ok and release["branch"] != _branch(version):
        errors.append(
            f"{name}: branch {release['branch']!r} should be {_branch(version)}"
        )
    dates = release.get("dates") or {}
    if not isinstance(dates, dict) or set(dates) - set(ANCHORS):
        errors.append(f"{name}: dates may only have {list(ANCHORS)}")
    else:
        for key, value in dates.items():
            if value is not None and not (
                isinstance(value, str) or hasattr(value, "isoformat")
            ):
                errors.append(f"{name}: dates.{key} must be a date or null")
            elif isinstance(value, str) and not re.match(r"^\d{4}-\d{2}-\d{2}$", value):
                errors.append(f"{name}: dates.{key} must be YYYY-MM-DD")
    links = release.get("links") or {}
    if not isinstance(links, dict) or set(links) - set(LINK_KEYS):
        errors.append(f"{name}: links may only have {sorted(LINK_KEYS)}")
    elif any(v is not None and not isinstance(v, (str, int)) for v in links.values()):
        errors.append(f"{name}: a link must be a number, a string or null")
    for key in ("remove", "add"):
        if key in release and not isinstance(release[key] or [], list):
            errors.append(f"{name}: {key} must be a list")
    if "override" in release and not isinstance(release["override"] or {}, dict):
        errors.append(f"{name}: override must be a map of step id to fields")
    return errors


def resolve(
    shared: Dict[str, Any], release: Dict[str, Any], name: Optional[str] = None
) -> Dict[str, Any]:
    """The shared steps with the release's changes applied.

    Order: `remove` drops steps, `override` replaces fields of a step (a field set to
    null is dropped from it), `add` appends new steps, which must be complete.
    Raises ConfigError if the release names a step that does not exist or the result is
    invalid.
    """
    if name is None:
        name = f"{release.get('release')}.yml"
    errors = validate_release_file(release, name)
    steps = copy.deepcopy(shared["steps"])
    by_id = {s["id"]: s for s in steps}

    for sid in release.get("remove") or []:
        if sid not in by_id:
            errors.append(f"{name}: remove names unknown step {sid}")
    for sid, fields in (release.get("override") or {}).items():
        if sid not in by_id:
            errors.append(f"{name}: override names unknown step {sid}")
        elif not isinstance(fields, dict):
            errors.append(f"{name}: override of step {sid} must be a map")
        elif set(fields) & {"id", "phase"}:
            errors.append(f"{name}: override of step {sid} cannot change id or phase")
    if errors:
        raise ConfigError(errors)

    removed = set(release.get("remove") or [])
    resolved = [s for s in steps if s["id"] not in removed]
    for s in resolved:
        for key, value in ((release.get("override") or {}).get(s["id"]) or {}).items():
            if value is None:
                s.pop(key, None)
            else:
                s[key] = value
    resolved.extend(copy.deepcopy(release.get("add") or []))

    phase_ids = {p["id"] for p in shared["phases"]}
    errors = _steps_errors(name, resolved, phase_ids)
    if errors:
        raise ConfigError(errors)

    links = release.get("links") or {}
    version = release["release"]
    release_type = release.get("type", _release_type(version))
    resolved = _applicable_steps(resolved, release_type)
    return {
        "version": shared["version"],
        "release": version,
        "type": release_type,
        "branch": release.get("branch", _branch(version)),
        "dates": {
            k: (str(v) if v is not None else None)
            for k, v in (release.get("dates") or {}).items()
        },
        # a link set in the release file; None means "found by discovery"
        "links": {k: links.get(k) for k in LINK_KEYS},
        "discovery": copy.deepcopy(shared["discovery"]),
        "resources": copy.deepcopy(shared["resources"]),
        "phases": copy.deepcopy(shared["phases"]),
        "steps": resolved,
    }


def _applicable_steps(
    steps: List[Dict[str, Any]], release_type: str
) -> List[Dict[str, Any]]:
    """The steps that apply to a release type. A step that does not apply cannot hold up
    another one, so dependencies on it are dropped."""
    kept = [s for s in steps if release_type in s.get("types", RELEASE_TYPES)]
    kept_ids = {s["id"] for s in kept}
    for step in kept:
        if "depends_on" in step:
            step["depends_on"] = [d for d in step["depends_on"] if d in kept_ids]
    return kept


def load_resolved(release_version: str) -> Dict[str, Any]:
    shared = _load(SHARED_FILE)
    errors = validate_shared(shared)
    if errors:
        raise ConfigError(errors)
    path = RELEASES_DIR / f"{release_version}.yml"
    return resolve(shared, _load(path), path.name)


def validate_all(release_version: Optional[str] = None) -> List[str]:
    errors: List[str] = []
    shared = _load(SHARED_FILE)
    errors.extend(validate_shared(shared))
    if errors:
        return errors
    paths = sorted(RELEASES_DIR.glob("*.yml"))
    if release_version:
        paths = [RELEASES_DIR / f"{release_version}.yml"]
    for path in paths:
        if not path.exists():
            errors.append(f"{path.name}: no such release file")
            continue
        try:
            resolve(shared, _load(path), path.name)
        except ConfigError as e:
            errors.extend(e.errors)
    return errors


# ---------------------------------------------------------------- discovery


def _rule_pattern(rule: Dict[str, Any], release_type: str) -> str:
    pattern = rule["title_regex"]
    return pattern[release_type] if isinstance(pattern, dict) else pattern


def match_milestone(
    milestones: List[Dict[str, Any]], rule: Dict[str, Any], version: str
) -> Optional[Dict[str, Any]]:
    """The milestone titled with the version (exact match), or None."""
    title = _fill(rule["title"], version)
    for milestone in milestones:
        if milestone.get("title") == title:
            return milestone
    return None


def match_issue(
    issues: List[Dict[str, Any]],
    rule: Dict[str, Any],
    version: str,
    release_type: str,
) -> Optional[Dict[str, Any]]:
    """The newest issue (highest number) whose title matches the rule, or None."""
    regex = re.compile(_fill(_rule_pattern(rule, release_type), version, escape=True))
    matches = [
        i
        for i in issues
        if "pull_request" not in i and regex.search(i.get("title", ""))
    ]
    return max(matches, key=lambda i: i["number"]) if matches else None


def _get(url: str) -> Any:
    request = urllib.request.Request(
        url, headers={"Accept": "application/vnd.github+json"}
    )
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def fetch_milestones(repo: str) -> List[Dict[str, Any]]:
    return _get(
        f"https://api.github.com/repos/{repo}/milestones?state=all&per_page=100"
    )


def search_issues(repo: str, query: str) -> List[Dict[str, Any]]:
    q = urllib.parse.quote(f"repo:{repo} is:issue {query}")
    return _get(
        f"https://api.github.com/search/issues?q={q}&sort=created&order=desc&per_page=100"
    )["items"]


def _link(found: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if found is None:
        return None
    return {
        "number": found["number"],
        "title": found["title"],
        "url": found["html_url"],
    }


def discover_links(
    resolved: Dict[str, Any], milestones=fetch_milestones, search=search_issues
) -> Dict[str, Any]:
    """The milestone, tracker issue and validation issue of a resolved release.

    A link set in the release file is used as is. The others are found by the rules in
    resolved["discovery"]; one that finds nothing is None. `milestones` and `search`
    fetch from GitHub and are parameters so that tests can supply data.
    """
    version, release_type = resolved["release"], resolved["type"]
    rules = resolved["discovery"]
    found: Dict[str, Any] = dict(resolved["links"])
    if found["milestone"] is None:
        rule = rules["milestone"]
        found["milestone"] = _link(
            match_milestone(milestones(rule["repo"]), rule, version)
        )
    for kind in ("tracker_issue", "validation_issue"):
        if found[kind] is None:
            rule = rules[kind]
            found[kind] = _link(
                match_issue(
                    search(rule["repo"], rule["query"]), rule, version, release_type
                )
            )
    return found


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--release", help="only this release, e.g. 2.16.0")
    p.add_argument(
        "--print",
        action="store_true",
        help="print the resolved config as JSON (needs --release)",
    )
    p.add_argument(
        "--discover",
        action="store_true",
        help="find the release's milestone and issues on GitHub (needs --release)",
    )
    args = p.parse_args(argv)

    if args.discover:
        if not args.release:
            p.error("--discover needs --release")
        try:
            print(json.dumps(discover_links(load_resolved(args.release)), indent=2))
        except ConfigError as e:
            print("\n".join(e.errors), file=sys.stderr)
            return 1
        return 0

    if args.print:
        if not args.release:
            p.error("--print needs --release")
        try:
            print(json.dumps(load_resolved(args.release), indent=2))
        except ConfigError as e:
            print("\n".join(e.errors), file=sys.stderr)
            return 1
        return 0

    errors = validate_all(args.release)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    shared = _load(SHARED_FILE)
    print(
        f"ok: {len(shared['steps'])} shared steps, {len(list(RELEASES_DIR.glob('*.yml')))} release file(s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
