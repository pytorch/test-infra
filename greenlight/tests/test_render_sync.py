"""Pins the values Dr. CI's TypeScript renderer re-declares from greenlight's Python source.

``torchci/lib/greenlight/greenlightRender.ts`` renders the same greenlight state the Python
comment writer does, but re-declares the shared vocabulary as its own constants -- its own and
``torchci/lib/greenlight/greenlightSweep.ts``'s, which holds the part both TypeScript renderers
use -- and nothing at build time links any of it to Python. Python is the source of truth: these
tests fail when the TypeScript stops matching it, in either direction.
"""

import re
from urllib.parse import urlparse

import pytest

from greenlight import comment_format, constants, verdict_outline
from tests import ts_source

_TS_RENDER = "torchci/lib/greenlight/greenlightRender.ts"
_TS_SWEEP = "torchci/lib/greenlight/greenlightSweep.ts"
_TS_CONFIG = "torchci/lib/greenlight/greenlightConfig.ts"
_PY_RENDER = "greenlight/src/greenlight/comment_format.py"
_PY_CONSTANTS = "greenlight/src/greenlight/constants.py"
_PY_OUTLINE = "greenlight/src/greenlight/verdict_outline.py"

assert (ts_source.ROOT / _TS_RENDER).is_file()
assert (ts_source.ROOT / _TS_SWEEP).is_file()
assert (ts_source.ROOT / _TS_CONFIG).is_file()

_TS_STATUS_RE = re.compile(r'^export const GREENLIGHT_STATUS_(\w+) =\s*"([^"]*)";$', re.MULTILINE)
_TS_REPOS_RE = re.compile(r"^export const GREENLIGHT_REPOS: string\[\] =\s*\[([^\]]*)\]", re.MULTILINE)
_TS_QUOTED_RE = re.compile(r'"([^"]*)"')
_TS_JOB_LINK_RE = re.compile(r"\[([^\]]+)\]\(\$\{\w+\}\)")
_TS_REASON_PREFIX_RE = re.compile(r"`([^`$]*)\$\{inlineCode\(")

_PROBE_JOB_URL = "https://example.invalid/probe-job"
_PROBE_REASON = "probe-reason"


def _ts_statuses() -> dict[str, str]:
    statuses: dict[str, str] = {m.group(1): m.group(2) for m in _TS_STATUS_RE.finditer(ts_source.read(_TS_RENDER))}
    assert statuses, f"no `GREENLIGHT_STATUS_*` constants in {_TS_RENDER}: {ts_source.RESTRUCTURED}"
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
    m = _TS_REPOS_RE.search(ts_source.read(_TS_CONFIG))
    assert m is not None, f"no `GREENLIGHT_REPOS: string[] = [...]` in {_TS_CONFIG}: {ts_source.RESTRUCTURED}"
    # The TypeScript folds its entries through normalizeRepoFullName at construction; fold the
    # extracted literals the same way so the comparison is against what that module computes.
    repos = frozenset(constants.normalize_repo(repo) for repo in _TS_QUOTED_RE.findall(m.group(1)))
    assert repos, f"`GREENLIGHT_REPOS` in {_TS_CONFIG} holds no entries: {ts_source.RESTRUCTURED}"
    return repos


def _ts_job_link_labels() -> set[str]:
    labels: set[str] = set(_TS_JOB_LINK_RE.findall(ts_source.read(_TS_RENDER)))
    assert labels, f"no `[label](${{url}})` markdown link in {_TS_RENDER}: {ts_source.RESTRUCTURED}"
    return labels


def _ts_reason_prefixes() -> set[str]:
    prefixes: set[str] = set(_TS_REASON_PREFIX_RE.findall(ts_source.read(_TS_RENDER)))
    assert prefixes, f"no `...${{inlineCode(...)}}` template in {_TS_RENDER}: {ts_source.RESTRUCTURED}"
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
    assert extracted == canonical, ts_source.drift(
        _TS_RENDER, _PY_CONSTANTS, f"entries on one side only: {sorted(extracted.items() ^ canonical.items())}"
    )


def test_every_status_is_branched_on_by_typescript() -> None:
    source = ts_source.read(_TS_RENDER)
    # A branched status names its constant at least once past the declaration line.
    unwired = sorted(
        name for name in _ts_statuses() if len(re.findall(rf"\bGREENLIGHT_STATUS_{re.escape(name)}\b", source)) < 2
    )
    assert not unwired, ts_source.drift(
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
    extracted = ts_source.ts_string(_TS_RENDER, ts_name)
    assert extracted == canonical, ts_source.drift(
        _TS_RENDER, _PY_RENDER, f"{ts_name} is {extracted!r}, Python has {canonical!r}"
    )


def test_reviewing_body_matches_python() -> None:
    extracted = ts_source.ts_string(_TS_RENDER, "GREENLIGHT_REVIEWING_BODY")
    rendered = comment_format.reviewing_body("", None).splitlines()
    assert extracted in rendered, ts_source.drift(
        _TS_RENDER, _PY_RENDER, f"GREENLIGHT_REVIEWING_BODY is {extracted!r}, absent from reviewing_body(): {rendered}"
    )


def test_message_cap_matches_python() -> None:
    extracted = ts_source.ts_number(_TS_RENDER, "GREENLIGHT_MESSAGE_CAP")
    assert extracted == comment_format._MESSAGE_CAP, ts_source.drift(
        _TS_RENDER, _PY_RENDER, f"GREENLIGHT_MESSAGE_CAP is {extracted}, _MESSAGE_CAP is {comment_format._MESSAGE_CAP}"
    )


def test_zero_width_space_matches_python() -> None:
    extracted = ts_source.ts_string(_TS_SWEEP, "ZERO_WIDTH_SPACE")
    assert extracted == comment_format._ZERO_WIDTH_SPACE, ts_source.drift(
        _TS_SWEEP,
        _PY_RENDER,
        f"ZERO_WIDTH_SPACE is {extracted!r}, _ZERO_WIDTH_SPACE is {comment_format._ZERO_WIDTH_SPACE!r}",
    )


def test_sweep_pending_word_matches_the_outline_renderer() -> None:
    extracted = ts_source.ts_string(_TS_SWEEP, "SWEEP_PENDING_WORD")
    assert extracted == verdict_outline.SWEEP_PENDING_WORD, ts_source.drift(
        _TS_SWEEP,
        _PY_OUTLINE,
        f"SWEEP_PENDING_WORD is {extracted!r}, Python has {verdict_outline.SWEEP_PENDING_WORD!r}. Both message "
        f"routes write into the same Dr. CI comment and break the sweep's `[0-9] Pending` predicate against "
        f"this one word, so a drift leaves both of them defusing a word the sweep no longer looks for -- and "
        f"a verdict that mentions a pending job count pins its PR into every sweep forever.",
    )


def test_job_link_label_matches_python() -> None:
    extracted = _ts_job_link_labels()
    canonical = _py_job_link_label()
    assert extracted == {canonical}, ts_source.drift(
        _TS_RENDER, _PY_RENDER, f"job link labels are {sorted(extracted)}, Python renders {canonical!r}"
    )


def test_reason_prefix_matches_python() -> None:
    extracted = _ts_reason_prefixes()
    canonical = _py_reason_prefix()
    assert extracted == {canonical}, ts_source.drift(
        _TS_RENDER, _PY_RENDER, f"reason line prefixes are {sorted(extracted)}, Python renders {canonical!r}"
    )


def test_repo_allowlist_matches_python() -> None:
    extracted = _ts_repos()
    assert extracted == constants.DRCI_STATUS_COMMENT_REPOS, ts_source.drift(
        _TS_CONFIG,
        _PY_CONSTANTS,
        f"symmetric difference: {sorted(extracted ^ constants.DRCI_STATUS_COMMENT_REPOS)}",
    )


def test_drci_endpoint_matches_hud_route() -> None:
    route_path = urlparse(constants.DRCI_ENDPOINT).path.lstrip("/")
    root = ts_source.ROOT
    route = root / "torchci/pages" / f"{route_path}.ts"
    assert route.is_file(), (
        f"{_PY_CONSTANTS} points DRCI_ENDPOINT at /{route_path}, but {route.relative_to(root)} does not exist. "
        f"The HUD route is the source of truth for its own URL; drci_poke.poke never raises, so a moved route "
        f"turns into a silently swallowed 404 and a PR whose status only refreshes on the 15-minute sweep."
    )
