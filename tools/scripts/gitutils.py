#!/usr/bin/env python3

from typing import List


def check_output(items: List[str], encoding: str = "utf-8") -> str:
    """
    The logic was taken from the pytorch/pytroch repo -
    https://github.com/pytorch/pytorch/blob/master/.github/scripts/gitutils.py
    """
    from subprocess import CalledProcessError, check_output, STDOUT

    try:
        return check_output(items, stderr=STDOUT).decode(encoding)
    except CalledProcessError as e:
        msg = f"Command `{' '.join(e.cmd)}` returned non-zero exit code {e.returncode}"
        stdout = e.stdout.decode(encoding) if e.stdout is not None else ""
        stderr = e.stderr.decode(encoding) if e.stderr is not None else ""
        if len(stderr) == 0:
            msg += f"\n```\n{stdout}```"
        else:
            msg += f"\nstdout:\n```\n{stdout}```\nstderr:\n```\n{stderr}```"
        raise RuntimeError(msg) from e
