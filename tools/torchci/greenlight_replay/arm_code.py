"""Run the arm's own code rather than a copy of it: its target and its record checks.

Where the live workflow decides something by running greenlight's code or a step of its
own, the replay runs that same code out of the materialized policy tree: ``greenlight
target`` for which repo and checkout a review gets, and the record job's validation step
and ``greenlight verdict --dry-run`` for whether a verdict is recorded. The
instruction-loading detector (:mod:`.detector`) and the policy staging script
(:mod:`.workspace`, through :func:`run_script`) are run the same way. A copy kept in the
harness would replay the harness's idea of the policy rather than the policy.

Every call runs in a subprocess whose environment is built from nothing -- the reviewer's
pinned ``PATH``, an empty ``HOME``, a UTF-8 locale -- so none of the harness's environment
variables reach it. That is all it confines: the child runs as the operator, with the
operator's files and network, and every materialize -- a sweep, a dry run and
``collect`` alike -- executes the greenlight code of the policy ref it was given.
greenlight's code runs under the interpreter running the harness with ``-I``, so neither
the environment nor the working directory adds to its import path, and ``-B``, so nothing
is written into the tree; the arm's ``greenlight/src`` is the first entry on that path.
The CLI subcommands used here import only the standard library and PyYAML, the heavy
dependencies being imported lazily.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from torchci.greenlight_replay.checkout import (
    CHECKOUT_DIRNAMES,
    DEFAULT_REPO,
    PRIMARY_CHECKOUT,
    require_repo,
)
from torchci.greenlight_replay.reviewer_env import SUBPROCESS_PATH
from torchci.greenlight_replay.workflow_steps import record_verdict_line, RecordStep


__all__ = [
    "BOT_LOGIN",
    "PROBE_EVAL_HASH",
    "PROBE_HEAD_SHA",
    "PROBE_PR",
    "Target",
    "accept_verdict",
    "canned_verdict",
    "resolve_target",
    "run_script",
]

logger = logging.getLogger(__name__)

ARM_SRC_RELPATH = "greenlight/src"
WORKFLOW_TARGET_RELPATH = "greenlight/src/greenlight/workflow_target.py"

# What the record job hands ``greenlight verdict``, bar the row's own PR and head. The eval
# hash is a placeholder of the validated shape; the bot login is the App the workflow mints.
PROBE_PR = 1
PROBE_HEAD_SHA = "0" * 40
PROBE_EVAL_HASH = "0" * 64
BOT_LOGIN = "pytorchgreenlight[bot]"

ARM_TIMEOUT_S = 120

_TARGET_KEYS = ("repo", "checkout")

_CLI_DRIVER = (
    "import sys\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "from greenlight import cli\n"
    "sys.exit(cli.main(sys.argv[2:]))\n"
)

# The verdict command logs to stdout, so stdout is handed to stderr for the call. Its
# ``_run_full`` receives a LAND or NO_LAND's status, reason and message once the command
# has resolved, scrubbed and validated them, and acts on them -- in a dry run, by logging
# alone; those three are what is printed. A verdict that never reaches it, such as a
# marker status, is refused.
_VERDICT_DRIVER = (
    "import json, sys\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "verdict_file = sys.argv[2]\n"
    "stdout, sys.stdout = sys.stdout, sys.stderr\n"
    "from greenlight import cli, verdict\n"
    "captured = []\n"
    "run_full = verdict._run_full\n"
    "def capture(request, config, status, reason, message, *args, **kwargs):\n"
    "    captured.append({'status': status, 'reason': reason, 'message': message})\n"
    "    return run_full(request, config, status, reason, message, *args, **kwargs)\n"
    "verdict._run_full = capture\n"
    "code = cli.main([*sys.argv[3:], '--verdict-file', verdict_file, '--dry-run'])\n"
    "if code:\n"
    "    sys.exit(code)\n"
    "if len(captured) != 1:\n"
    "    sys.exit('greenlight verdict did not record it as a LAND or NO_LAND verdict')\n"
    "stdout.write(json.dumps(captured[0]))\n"
)

# The command GitHub runs a ``run:`` step with, by the step's shell; ``-x`` is the
# replay's, a trace on stderr that changes nothing else: a check such as
# `jq -e ... >/dev/null` fails without a word, and the trace names it.
_RECORD_SHELLS = {
    None: ("bash", "-e", "-x"),
    "bash": ("bash", "--noprofile", "--norc", "-eo", "pipefail", "-x"),
}


@dataclass(frozen=True)
class Target:
    """What the arm's ``greenlight target`` names for the reviewed repo."""

    repo: str
    checkout: str


def resolve_target(root: Path, repo: str) -> Target:
    """Run the arm's ``greenlight target`` for ``repo`` and read what it prints.

    pytorch/pytorch is resolved as the review job resolves it: ``--strict`` with an
    empty ``--repo``, the only spelling it accepts, which reads nothing. For any other
    repo ``--strict`` reads the repo's identity and GreenLight config from GitHub with a
    token, which no arm code is handed here, so the repo is checked as ``--from-review``
    checks the review job's output: offline, its name and the checkout it gets, without
    those live checks. A tree with no target step reviews pytorch/pytorch alone, in
    ``pytorch``.
    """
    require_repo(repo)
    if not (Path(root) / WORKFLOW_TARGET_RELPATH).is_file():
        if repo != DEFAULT_REPO:
            raise ValueError(
                f"the policy has no {WORKFLOW_TARGET_RELPATH}, so it reviews "
                f"{DEFAULT_REPO} alone, not {repo}"
            )
        return Target(DEFAULT_REPO, PRIMARY_CHECKOUT)
    mode = (
        ("--strict", "--repo", "")
        if repo == DEFAULT_REPO
        else (
            "--from-review",
            "--input-repo",
            repo,
            "--repo",
            repo,
            "--drci-poke",
            "false",
        )
    )
    completed = _python(
        root,
        _CLI_DRIVER,
        "target",
        *mode,
        "--pr",
        str(PROBE_PR),
        "--head-sha",
        PROBE_HEAD_SHA,
    )
    if completed.returncode != 0:
        raise ValueError(
            f"the policy's greenlight target refuses {repo} (exit "
            f"{completed.returncode}): {_tail(completed)}"
        )
    return _target(completed.stdout, repo)


def _target(stdout: str, repo: str) -> Target:
    values: dict[str, str] = {}
    for line in stdout.splitlines():
        key, separator, value = line.partition("=")
        if not separator:
            raise ValueError(f"greenlight target printed {line!r}, not key=value")
        values[key] = value
    missing = [key for key in _TARGET_KEYS if key not in values]
    if missing:
        raise ValueError(f"greenlight target printed no {', '.join(missing)}")
    if values["repo"] != repo:
        raise ValueError(f"greenlight target named {values['repo']!r}, not {repo!r}")
    if values["checkout"] not in CHECKOUT_DIRNAMES:
        raise ValueError(
            f"greenlight target named checkout {values['checkout']!r}, not one of "
            f"{CHECKOUT_DIRNAMES}"
        )
    return Target(repo=repo, checkout=values["checkout"])


def accept_verdict(
    root: Path,
    record: RecordStep,
    verdict_file: Path,
    *,
    repo: str,
    pr_number: int,
    head_sha: str,
) -> tuple[dict[str, str] | None, str | None]:
    """The processed verdict the record path would record, or why it would not.

    Both of the record path's checks must pass: the record job's own validation step,
    then the arm's ``greenlight verdict --dry-run``. The returned verdict is what that
    command acts on, its message scrubbed as every sink of the record path receives it.
    """
    verdict_file = Path(os.path.abspath(verdict_file))
    rejection = _record_step_rejection(root, record, verdict_file)
    if rejection is not None:
        return None, f"the record job's validation step rejects it: {rejection}"
    return _dry_run(root, verdict_file, repo, pr_number, head_sha)


def canned_verdict(
    root: Path, record: RecordStep, verdict_file: Path, target: Target
) -> dict[str, str]:
    """A verdict the workflow emits with no model, held to the record path's checks."""
    verdict, rejection = accept_verdict(
        root,
        record,
        verdict_file,
        repo=target.repo,
        pr_number=PROBE_PR,
        head_sha=PROBE_HEAD_SHA,
    )
    if verdict is None:
        raise ValueError(f"the canned verdict {verdict_file} is refused: {rejection}")
    return verdict


def _record_step_rejection(
    root: Path, record: RecordStep, verdict_file: Path
) -> str | None:
    """Run the record step as the record job does, in its checkout of the tree."""
    lines = record.run.split("\n")
    index = record_verdict_line(record.run)
    indent = lines[index][: len(lines[index]) - len(lines[index].lstrip())]
    lines[index] = f"{indent}verdict={shlex.quote(str(verdict_file))}"
    with tempfile.TemporaryDirectory(prefix="greenlight-record-") as name:
        scratch = Path(name)
        script = scratch / "record-step.sh"
        script.write_text("\n".join(lines), encoding="utf-8")
        completed = _run(
            [*_RECORD_SHELLS[record.shell], str(script)],
            scratch,
            cwd=Path(os.path.abspath(root)),
            EVAL_HASH=PROBE_EVAL_HASH,
        )
    if completed.returncode == 0:
        return None
    return f"exit {completed.returncode}: {_tail(completed)}"


def _dry_run(
    root: Path, verdict_file: Path, repo: str, pr_number: int, head_sha: str
) -> tuple[dict[str, str] | None, str | None]:
    completed = _python(
        root,
        _VERDICT_DRIVER,
        str(verdict_file),
        "verdict",
        "--repo",
        repo,
        "--pr",
        str(int(pr_number)),
        "--head-sha",
        head_sha,
        "--eval-hash",
        PROBE_EVAL_HASH,
        "--bot-login",
        BOT_LOGIN,
    )
    if completed.returncode != 0:
        return None, (
            f"greenlight verdict --dry-run rejects it (exit {completed.returncode}): "
            f"{_tail(completed)}"
        )
    processed = json.loads(completed.stdout)
    if not isinstance(processed, dict) or not all(
        isinstance(processed.get(key), str) for key in ("status", "reason", "message")
    ):
        raise RuntimeError(f"the verdict driver printed {completed.stdout[:200]!r}")
    return processed, None


def run_script(script: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Run a standard-library script of the arm's tree, such as ``repo-policy.py``.

    It runs as greenlight's code does here: ``-I -B``, with an environment built from
    nothing. Its working directory is a scratch one, so every path in ``args`` must be
    absolute.
    """
    with tempfile.TemporaryDirectory(prefix="greenlight-arm-") as home:
        return _run(
            [sys.executable, "-I", "-B", os.path.abspath(script), *args], Path(home)
        )


def _python(root: Path, driver: str, *args: str) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory(prefix="greenlight-arm-") as home:
        return _run(
            [
                sys.executable,
                "-I",
                "-B",
                "-c",
                driver,
                os.path.abspath(Path(root) / ARM_SRC_RELPATH),
                *args,
            ],
            Path(home),
        )


def _run(
    argv: Sequence[str], scratch: Path, cwd: Path | None = None, **env: str
) -> subprocess.CompletedProcess[str]:
    """One call whose environment holds nothing of the harness's but ``env``.

    It runs in ``cwd``, by default the scratch ``HOME`` it is given, as the operator.
    """
    home = scratch / "home"
    home.mkdir(exist_ok=True)
    base: Mapping[str, str] = {
        "PATH": SUBPROCESS_PATH,
        "HOME": str(home),
        "LC_ALL": "C.UTF-8",
    }
    try:
        return subprocess.run(
            list(argv),
            cwd=str(home if cwd is None else cwd),
            env={**base, **env},
            capture_output=True,
            text=True,
            timeout=ARM_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{argv[0]} ran past {ARM_TIMEOUT_S} s") from exc


def _tail(completed: subprocess.CompletedProcess[str]) -> str:
    return (completed.stderr or completed.stdout).strip()[-400:]
