"""Run the policy's instruction-loading detector after a session, as the review job does.

The review job's hooks leave a sentinel when the session starts and append each loaded
instruction file to a manifest, both in ``$RUNNER_TEMP``; its "Assert no untrusted
instructions were loaded" step then runs ``assert-loaded-instructions.py`` over them. The
replay runs the policy tree's own copy of that script over the run directory, which
``reviewer_env`` makes the reviewer's ``RUNNER_TEMP``, with the slot's checkout as the
untrusted root. It runs like the rest of the arm's code, in an environment built from
nothing (:func:`.arm_code.run_script`).

The detector fails for two reasons that mean different things to a sweep. A missing
sentinel says the hooks never loaded, which no pull request causes and every run would
repeat; an instruction file loaded from the checkout is that one pull request's doing.
"""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path

from torchci.greenlight_replay.arm_code import output_tail, run_script
from torchci.greenlight_replay.workflow_steps import (
    MANIFEST_BASENAME,
    SENTINEL_BASENAME,
)


__all__ = ["DetectorFailure", "clear_detector_files", "run_detector"]


@dataclass(frozen=True)
class DetectorFailure:
    """Why the detector failed, and whether the hooks ran at all.

    ``hooks_ran`` False means no sentinel: the hooks never loaded. True means they ran
    and an instruction file loaded from the untrusted checkout.
    """

    message: str
    hooks_ran: bool


def clear_detector_files(run_dir: Path) -> None:
    """Remove the manifest and sentinel an earlier attempt left in ``run_dir``.

    ``os.unlink`` removes a symlink rather than what it names. A directory in either
    place is refused: the hooks could not write there, and the detector would read it.
    """
    for basename in (MANIFEST_BASENAME, SENTINEL_BASENAME):
        path = Path(run_dir) / basename
        try:
            mode = os.lstat(path).st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISDIR(mode):
            raise ValueError(f"refusing to replay with a directory at {path}")
        os.unlink(path)


def run_detector(
    script: Path, run_dir: Path, untrusted_root: Path
) -> DetectorFailure | None:
    """Run the policy's detector as the workflow does; why it failed, or None.

    Which of its two failures it was is told apart by the sentinel, tested as the
    detector itself tests it.
    """
    run_dir = Path(os.path.abspath(run_dir))
    sentinel = run_dir / SENTINEL_BASENAME
    completed = run_script(
        script,
        "--manifest",
        str(run_dir / MANIFEST_BASENAME),
        "--sentinel",
        str(sentinel),
        "--untrusted-root",
        os.path.abspath(untrusted_root),
    )
    if completed.returncode == 0:
        return None
    return DetectorFailure(
        message=f"the detector exited {completed.returncode}: {output_tail(completed)}",
        hooks_ran=os.path.exists(sentinel),
    )
