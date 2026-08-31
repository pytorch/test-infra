"""Pins the values Dr. CI's TypeScript renderer re-declares from greenlight's Python source.

``torchci/lib/greenlight/greenlightRender.ts`` renders the same greenlight state the Python
comment writer does, but re-declares the shared vocabulary as its own constants and nothing at
build time links the two. Python is the source of truth: these tests fail when the TypeScript
stops matching it, in either direction.
"""

import re
from pathlib import Path
from urllib.parse import urlparse

import pytest

from greenlight import comment_format, constants

ROOT = Path(__file__).resolve().parents[2]

_TS_RENDER = "torchci/lib/greenlight/greenlightRender.ts"
_TS_CONFIG = "torchci/lib/greenlight/greenlightConfig.ts"
_PY_RENDER = "greenlight/src/greenlight/comment_format.py"
_PY_CONSTANTS = "greenlight/src/greenlight/constants.py"

assert (ROOT / _TS_RENDER).is_file()
assert (ROOT / _TS_CONFIG).is_file()

_TS_UNICODE_ESCAPE_RE = re.compile(r"\\u([0-9a-fA-F]{4})")
_TS_STATUS_RE = re.compile(r'^export const GREENLIGHT_STATUS_(\w+) =\s*"([^"]*)";$', re.MULTILINE)
_TS_REPOS_RE = re.compile(r"^export const GREENLIGHT_REPOS: string\[\] =\s*\[([^\]]*)\]", re.MULTILINE)
_TS_QUOTED_RE = re.compile(r'"([^"]*)"')
_TS_JOB_LINK_RE = re.compile(r"\[([^\]]+)\]\(\$\{\w+\}\)")
_TS_REASON_PREFIX_RE = re.compile(r"`([^`$]*)\$\{inlineCode\(")

_PROBE_JOB_URL = "https://example.invalid/probe-job"
_PROBE_REASON = "probe-reason"

_RESTRUCTURED = "the TypeScript was restructured; re-target this test's regex at the new shape"


def _drift(ts_file: str, py_file: str, detail: str) -> str:
    return (
        f"{ts_file} drifted from {py_file}, which is the source of truth: "
        f"change the TypeScript to match it, or change both together. {detail}"
    )


def _read(ts_file: str) -> str:
    return (ROOT / ts_file).read_text()


def _unescape(literal: str) -> str:
    return _TS_UNICODE_ESCAPE_RE.sub(lambda m: chr(int(m.group(1), 16)), literal)


def _ts_string(ts_file: str, name: str) -> str:
    pattern = rf'^(?:export )?const {re.escape(name)} =\s*"([^"]*)";$'
    m = re.search(pattern, _read(ts_file), re.MULTILINE)
    assert m is not None, f'no `const {name} = "..."` in {ts_file}: {_RESTRUCTURED}'
    return _unescape(m.group(1))


def _ts_number(ts_file: str, name: str) -> int:
    pattern = rf"^(?:export )?const {re.escape(name)} =\s*(\d+);$"
    m = re.search(pattern, _read(ts_file), re.MULTILINE)
    assert m is not None, f"no `const {name} = <number>;` in {ts_file}: {_RESTRUCTURED}"
    return int(m.group(1))


def _ts_statuses() -> dict[str, str]:
    statuses: dict[str, str] = {m.group(1): m.group(2) for m in _TS_STATUS_RE.finditer(_read(_TS_RENDER))}
    assert statuses, f"no `GREENLIGHT_STATUS_*` constants in {_TS_RENDER}: {_RESTRUCTURED}"
    return statuses


def _py_statuses() -> dict[str, str]:
    statuses: dict[str, str] = {
        name.removeprefix("STATUS_"): value
        for name, value in vars(constants).items()
        if name.startswith("STATUS_") and isinstance(value, str)
    }
    assert statuses
    return statuses


def _ts_repos() -> frozenset[str]:
    m = _TS_REPOS_RE.search(_read(_TS_CONFIG))
    assert m is not None, f"no `GREENLIGHT_REPOS: string[] = [...]` in {_TS_CONFIG}: {_RESTRUCTURED}"
    # The TypeScript folds its entries through normalizeRepoFullName at construction; fold the
    # extracted literals the same way so the comparison is against what that module computes.
    repos = frozenset(constants.normalize_repo(repo) for repo in _TS_QUOTED_RE.findall(m.group(1)))
    assert repos, f"`GREENLIGHT_REPOS` in {_TS_CONFIG} holds no entries: {_RESTRUCTURED}"
    return repos


def _ts_job_link_labels() -> set[str]:
    labels: set[str] = set(_TS_JOB_LINK_RE.findall(_read(_TS_RENDER)))
    assert labels, f"no `[label](${{url}})` markdown link in {_TS_RENDER}: {_RESTRUCTURED}"
    return labels


def _ts_reason_prefixes() -> set[str]:
    prefixes: set[str] = set(_TS_REASON_PREFIX_RE.findall(_read(_TS_RENDER)))
    assert prefixes, f"no `...${{inlineCode(...)}}` template in {_TS_RENDER}: {_RESTRUCTURED}"
    return prefixes


def _py_job_link_label() -> str:
    rendered = comment_format.reviewing_body(_PROBE_JOB_URL, None)
    m = re.search(rf"^\[([^\]]+)\]\({re.escape(_PROBE_JOB_URL)}\)$", rendered, re.MULTILINE)
    assert m is not None, f"{_PY_RENDER} no longer renders a job link: {rendered!r}"
    return m.group(1)


def _py_reason_prefix() -> str:
    rendered = comment_format.incomplete_body(_PROBE_REASON, "", None)
    m = re.search(rf"^(.*)`{re.escape(_PROBE_REASON)}`$", rendered, re.MULTILINE)
    assert m is not None, f"{_PY_RENDER} no longer renders a reason line: {rendered!r}"
    return m.group(1)


def test_status_constants_match_python() -> None:
    extracted = _ts_statuses()
    canonical = _py_statuses()
    assert extracted == canonical, _drift(
        _TS_RENDER, _PY_CONSTANTS, f"entries on one side only: {sorted(extracted.items() ^ canonical.items())}"
    )


def test_every_status_is_branched_on_by_typescript() -> None:
    source = _read(_TS_RENDER)
    # A branched status names its constant at least once past the declaration line.
    unwired = sorted(
        name for name in _ts_statuses() if len(re.findall(rf"\bGREENLIGHT_STATUS_{re.escape(name)}\b", source)) < 2
    )
    assert not unwired, _drift(
        _TS_RENDER,
        _PY_CONSTANTS,
        f"declared but never branched on: {unwired}. Declaring the constant is all "
        f"test_status_constants_match_python asks for, so a status can satisfy it and still fall "
        f'through renderGreenlightSection to "" -- which buildGreenlightSections drops, taking '
        f"the whole GREEN LIGHT section out of the Dr. CI comment rather than showing the state.",
    )


_HEADLINES = {
    "GREENLIGHT_LAND_HEADLINE": comment_format.LAND_HEADLINE,
    "GREENLIGHT_NO_LAND_HEADLINE": comment_format.NO_LAND_HEADLINE,
    "GREENLIGHT_REVIEWING_HEADLINE": comment_format.REVIEWING_HEADLINE,
    "GREENLIGHT_INCOMPLETE_HEADLINE": comment_format.INCOMPLETE_HEADLINE,
}


@pytest.mark.parametrize(("ts_name", "canonical"), sorted(_HEADLINES.items()))
def test_headline_matches_python(ts_name: str, canonical: str) -> None:
    extracted = _ts_string(_TS_RENDER, ts_name)
    assert extracted == canonical, _drift(
        _TS_RENDER, _PY_RENDER, f"{ts_name} is {extracted!r}, Python has {canonical!r}"
    )


def test_reviewing_body_matches_python() -> None:
    extracted = _ts_string(_TS_RENDER, "GREENLIGHT_REVIEWING_BODY")
    rendered = comment_format.reviewing_body("", None).splitlines()
    assert extracted in rendered, _drift(
        _TS_RENDER, _PY_RENDER, f"GREENLIGHT_REVIEWING_BODY is {extracted!r}, absent from reviewing_body(): {rendered}"
    )


def test_message_cap_matches_python() -> None:
    extracted = _ts_number(_TS_RENDER, "GREENLIGHT_MESSAGE_CAP")
    assert extracted == comment_format._MESSAGE_CAP, _drift(
        _TS_RENDER, _PY_RENDER, f"GREENLIGHT_MESSAGE_CAP is {extracted}, _MESSAGE_CAP is {comment_format._MESSAGE_CAP}"
    )


def test_zero_width_space_matches_python() -> None:
    extracted = _ts_string(_TS_RENDER, "ZERO_WIDTH_SPACE")
    assert extracted == comment_format._ZERO_WIDTH_SPACE, _drift(
        _TS_RENDER,
        _PY_RENDER,
        f"ZERO_WIDTH_SPACE is {extracted!r}, _ZERO_WIDTH_SPACE is {comment_format._ZERO_WIDTH_SPACE!r}",
    )


def test_job_link_label_matches_python() -> None:
    extracted = _ts_job_link_labels()
    canonical = _py_job_link_label()
    assert extracted == {canonical}, _drift(
        _TS_RENDER, _PY_RENDER, f"job link labels are {sorted(extracted)}, Python renders {canonical!r}"
    )


def test_reason_prefix_matches_python() -> None:
    extracted = _ts_reason_prefixes()
    canonical = _py_reason_prefix()
    assert extracted == {canonical}, _drift(
        _TS_RENDER, _PY_RENDER, f"reason line prefixes are {sorted(extracted)}, Python renders {canonical!r}"
    )


def test_repo_allowlist_matches_python() -> None:
    extracted = _ts_repos()
    assert extracted == constants.DRCI_STATUS_COMMENT_REPOS, _drift(
        _TS_CONFIG,
        _PY_CONSTANTS,
        f"symmetric difference: {sorted(extracted ^ constants.DRCI_STATUS_COMMENT_REPOS)}",
    )


def test_drci_endpoint_matches_hud_route() -> None:
    route_path = urlparse(constants.DRCI_ENDPOINT).path.lstrip("/")
    route = ROOT / "torchci/pages" / f"{route_path}.ts"
    assert route.is_file(), (
        f"{_PY_CONSTANTS} points DRCI_ENDPOINT at /{route_path}, but {route.relative_to(ROOT)} does not exist. "
        f"The HUD route is the source of truth for its own URL; drci_poke.poke never raises, so a moved route "
        f"turns into a silently swallowed 404 and a PR whose status only refreshes on the 15-minute sweep."
    )
