"""Spec tests for the LAND-implies-`clean` constraint at the two Stop-hook validation layers.

Every reason but `clean` names a reason not to land, and the land-time guard on pytorch/pytorch
gates on the recorded status alone -- so a LAND carrying one of them authorizes exactly the merge
its reason objects to. Two layers reject the pairing here: ``verdict-schema.json`` on the Stop
hook's check-jsonschema path, and the jq fallback in ``validate-on-stop.sh``, the path the reviewer
workflow actually takes since it installs no check-jsonschema. The third layer -- greenlight's own
validation, the only one that runs in the privileged record job rather than in the untrusted review
job -- is covered beside the rest of the verdict path in ``test_verdict.py``.

The Stop hook reads one fixed path, so every end-to-end case against it runs inside a single test:
``just test`` passes ``-n auto``, and two tests writing that path would race across xdist workers.
Whatever was already there is restored afterwards. The hook is invoked as a subprocess the way
Claude Code runs it, under a PATH holding only the commands it needs, which is what makes the
absence of check-jsonschema -- and so the fallback path -- deterministic rather than a property of
the machine.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

import jsonschema
import pytest

from greenlight.constants import LAND_REASON, STATUS_LAND, STATUS_NO_LAND

if TYPE_CHECKING:
    from collections.abc import Iterator

ROOT = Path(__file__).resolve().parents[2]
_HOOK = ROOT / ".claude" / "hooks" / "greenlight" / "validate-on-stop.sh"
_SCHEMA = ROOT / ".claude" / "hooks" / "greenlight" / "verdict-schema.json"
_BASH = shutil.which("bash") or "/bin/bash"

# The path the Stop hook validates, hardcoded in the hook and written by the reviewer workflow.
_VERDICT_PATH = Path("/tmp/greenlight-verdict.json")  # noqa: S108

# External commands the hook runs; anything else on the developer's PATH is kept out so the
# check-jsonschema probe resolves the same way here as under `uv sync`, which installs none.
_HOOK_COMMANDS = ("cat", "dirname", "jq", "tr")

_STOP_EVENT = json.dumps({"stop_hook_active": False})
_OTHER_REASON = "not_trivial"


def _load_schema() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(_SCHEMA.read_text(encoding="utf-8"))
    return data


@pytest.mark.parametrize(
    ("document", "valid"),
    [
        ({"status": STATUS_LAND, "reason": LAND_REASON, "message": "x"}, True),
        ({"status": STATUS_LAND, "reason": _OTHER_REASON, "message": "x"}, False),
        ({"status": STATUS_NO_LAND, "reason": _OTHER_REASON, "message": "x"}, True),
        ({"status": STATUS_NO_LAND, "reason": LAND_REASON, "message": "x"}, True),
        # A status-less document fails the top-level `required` either way, so the LAND branch's
        # own `required: ["status"]` decides only which error is reported, never whether the
        # document is accepted.
        ({"reason": _OTHER_REASON, "message": "x"}, False),
    ],
    ids=["land-clean", "land-other", "no-land-other", "no-land-clean", "no-status"],
)
def test_schema_accepts_only_clean_beside_land(document: dict[str, str], valid: bool) -> None:
    schema = _load_schema()
    if valid:
        jsonschema.validate(instance=document, schema=schema)
        return
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=document, schema=schema)


@pytest.fixture
def hook_bin(tmp_path: Path) -> Path:
    """A PATH directory holding only the commands the hook needs."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    for name in _HOOK_COMMANDS:
        found = shutil.which(name)
        assert found is not None, f"the Stop hook needs {name} and it is not on PATH"
        (bindir / name).symlink_to(found)
    return bindir


@pytest.fixture
def stop_hook_verdict() -> Iterator[Path]:
    """The one fixed path the Stop hook reads, with any pre-existing file restored afterwards."""
    saved = _VERDICT_PATH.read_bytes() if _VERDICT_PATH.exists() else None
    try:
        yield _VERDICT_PATH
    finally:
        if saved is None:
            _VERDICT_PATH.unlink(missing_ok=True)
        else:
            _VERDICT_PATH.write_bytes(saved)


def _run_hook(bindir: Path) -> subprocess.CompletedProcess[str]:
    assert _HOOK.is_file(), f"Stop hook not found at {_HOOK}"
    return subprocess.run(  # noqa: S603
        [_BASH, str(_HOOK)],
        input=_STOP_EVENT,
        capture_output=True,
        text=True,
        check=False,
        env={"PATH": str(bindir)},
    )


def test_the_stop_hook_rejects_a_land_carrying_another_reason(stop_hook_verdict: Path, hook_bin: Path) -> None:
    cases = [
        ((STATUS_LAND, LAND_REASON), 0),
        ((STATUS_LAND, _OTHER_REASON), 2),
        ((STATUS_NO_LAND, _OTHER_REASON), 0),
    ]
    for (status, reason), expected in cases:
        stop_hook_verdict.write_text(json.dumps({"status": status, "reason": reason, "message": "x"}), encoding="utf-8")
        result = _run_hook(hook_bin)
        case = f"{status}/{reason}"
        # Only exit 2 blocks a Stop hook, so a wrong-but-nonzero code fails open.
        assert result.returncode == expected, f"{case}: exit {result.returncode}, stderr: {result.stderr}"
        # Proves the jq fallback ran rather than check-jsonschema, which reports differently.
        assert "check-jsonschema" not in result.stderr, f"{case}: {result.stderr}"
        if expected == 0:
            # Exact, not a substring: a command missing from the PATH above reports itself here and
            # nowhere else, and the checks it silently skips would still exit 0.
            assert result.stderr.strip() == f"Valid verdict: status={status} reason={reason}", case
        else:
            assert f"must have reason '{LAND_REASON}'" in result.stderr, case
            assert "before stopping" in result.stderr, f"{case}: the block does not say what to do"
