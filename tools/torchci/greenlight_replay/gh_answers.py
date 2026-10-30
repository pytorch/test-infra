"""GitHub's answers to the replay's ``gh`` calls, recorded once and answered from disk.

CI replays one sample in several jobs at once, one per arm and replicate. Each fetching
every sampled pull request's diff, metadata and stack context itself multiplies those
reads by the number of jobs, all against one workflow token's rate limit. So the collect
job asks GitHub and records each answer, and every replay job is answered from that
record. ``inputs._run`` is where every one of those reads leaves the process, and it
hands each to ``run``, which works in one of three ways:

- With ``ANSWERS_ENV`` naming a directory, a call is answered from it or not at all. One
  never recorded fails as a gh failure does, exit 1 and the reason on stderr, and nothing
  runs: a replay job never falls back to asking GitHub.
- After ``record_into``, a call recorded before is answered from the record, so one that
  both policies make reaches GitHub once. Anything else runs, and its answer is kept only
  when gh exits 0. A replay of a call that failed therefore fails as well, as it did live.
- Otherwise gh runs and nothing is kept.

One JSON file per call, named by a hash of its argv. The file holds the argv too, so a
lookup confirms it answers this call. The collect job's threads share the directory, so
each file is written beside its destination and renamed into place: a reader finds a
whole answer or none.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path


__all__ = [
    "ANSWERS_ENV",
    "record_into",
    "run",
]

ANSWERS_ENV = "GREENLIGHT_REPLAY_GITHUB_ANSWERS"

_recording: Path | None = None


def record_into(directory: Path) -> None:
    """Record in ``directory`` what gh answers this process from now on."""
    global _recording
    directory.mkdir(parents=True, exist_ok=True)
    _recording = directory


def run(argv: list[str], timeout_s: int) -> subprocess.CompletedProcess[bytes]:
    """Run ``argv``, or answer it from a record, as the module docstring says."""
    replaying = os.environ.get(ANSWERS_ENV)
    if replaying:
        answer = _recorded(Path(replaying), argv)
        if answer is None:
            reason = (
                f"collect recorded no answer to this call in {replaying}, and "
                f"{ANSWERS_ENV} answers only from there, so nothing was run"
            )
            return subprocess.CompletedProcess(argv, 1, b"", reason.encode("utf-8"))
        return answer
    if _recording is not None:
        answer = _recorded(_recording, argv)
        if answer is not None:
            return answer
    completed = subprocess.run(
        argv, capture_output=True, check=False, timeout=timeout_s
    )
    if _recording is not None and completed.returncode == 0:
        _store(_recording, argv, completed)
    return completed


def _path(directory: Path, argv: list[str]) -> Path:
    digest = hashlib.sha256(json.dumps(argv).encode("utf-8")).hexdigest()
    return directory / f"{digest}.json"


def _recorded(
    directory: Path, argv: list[str]
) -> subprocess.CompletedProcess[bytes] | None:
    try:
        document = json.loads(_path(directory, argv).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    if document["argv"] != argv:
        return None
    return subprocess.CompletedProcess(
        argv,
        document["returncode"],
        base64.b64decode(document["stdout"]),
        base64.b64decode(document["stderr"]),
    )


def _store(
    directory: Path, argv: list[str], completed: subprocess.CompletedProcess[bytes]
) -> None:
    document = {
        "argv": argv,
        "returncode": completed.returncode,
        "stdout": base64.b64encode(completed.stdout).decode("ascii"),
        "stderr": base64.b64encode(completed.stderr).decode("ascii"),
    }
    descriptor, staged = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle)
        os.replace(staged, _path(directory, argv))
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(staged)
        raise
