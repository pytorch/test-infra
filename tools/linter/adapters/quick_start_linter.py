"""
QUICK_START: Checks that the generated files in tools/quick_start are up to date.

The files are generated from the build matrix in tools/scripts/generate_binary_build_matrix.py,
the hand-written inputs in tools/quick_start and the generator scripts in
tools/quick_start/scripts. Run `lintrunner --take QUICK_START -a` to regenerate them.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
from enum import Enum
from pathlib import Path
from typing import NamedTuple


LINTER_CODE = "QUICK_START"
REPO_ROOT = Path(__file__).absolute().parents[3]
QUICK_START = REPO_ROOT / "tools" / "quick_start"
MATRIX_SCRIPT = REPO_ROOT / "tools" / "scripts" / "generate_binary_build_matrix.py"

# Generated files, relative to tools/quick_start.
GENERATED_FILES = [
    "published_versions.json",
    "releases.json",
    "assets/quick-start-module.js",
    "additional-platforms.json",
    "assets/quick-start-additional-platforms.js",
]

# The inputs of the getting-started matrices, the same ones the reusable
# generate_binary_build_matrix.yml workflow passes to the script. Anything else that the script reads
# from the environment is dropped so the result does not depend on the caller.
MATRIX_ENV = {
    "PACKAGE_TYPE": "all",
    "WITH_CUDA": "enable",
    "WITH_ROCM": "enable",
    "WITH_CPU": "enable",
    "WITH_XPU": "disable",
    "RUNNER_FLEET": "ec2",
    "LIMIT_PR_BUILDS": "false",
    "USE_ONLY_DL_PYTORCH_ORG": "false",
    "BUILD_PYTHON_ONLY": "disable",
    "GETTING_STARTED": "true",
    "PYTHON_VERSIONS": "[]",
    "PYTHON_ABI3": "disable",
}
MATRIX_VARIANTS = [
    (os_name, channel)
    for channel in ("nightly", "release")
    for os_name in ("linux", "windows", "macos-arm64")
]
# additional-platforms.json is a bundle for external consumers that records when
# and from which commit it was generated. Those two fields change on every run, so
# they are not compared; they are refreshed whenever the rest of the file changes.
VOLATILE_JSON_FIELDS = ("generated_at", "generator_commit")


class LintSeverity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    ADVICE = "advice"
    DISABLED = "disabled"


class LintMessage(NamedTuple):
    path: str | None
    line: int | None
    char: int | None
    code: str
    severity: LintSeverity
    name: str
    original: str | None
    replacement: str | None
    description: str | None


def _clean_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in MATRIX_ENV}
    # Recorded in additional-platforms.json; must not depend on where this runs.
    env.pop("GITHUB_SHA", None)
    return env


def _run(cmd: list[str], cwd: Path, env: dict[str, str]) -> str:
    result = subprocess.run(
        cmd, cwd=cwd, env=env, capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"`{' '.join(cmd)}` failed with exit code {result.returncode}:\n"
            f"{result.stderr.strip()}"
        )
    return result.stdout


def generate(workdir: Path) -> dict[str, str]:
    """Regenerate the generated files in a scratch copy and return their contents."""
    module = workdir / "tools" / "quick_start"
    shutil.copytree(QUICK_START, module)
    env = _clean_env()
    for os_name, channel in MATRIX_VARIANTS:
        matrix = _run(
            [sys.executable, str(MATRIX_SCRIPT)],
            cwd=REPO_ROOT,
            env={**env, **MATRIX_ENV, "OS": os_name, "CHANNEL": channel},
        )
        # gen_quick_start_module.py reads macos-arm64 as "macos"
        (module / f"{os_name.replace('-arm64', '')}_{channel}_matrix.json").write_text(
            matrix
        )
    js = _run(
        [sys.executable, "scripts/gen_quick_start_module.py", "--autogenerate"],
        cwd=module,
        env=env,
    )
    (module / "assets" / "quick-start-module.js").write_text(js)
    _run([sys.executable, "scripts/gen_additional_platforms.py"], cwd=module, env=env)
    return {name: (module / name).read_text() for name in GENERATED_FILES}


def _without_volatile_fields(text: str) -> object:
    data = json.loads(text)
    for field in VOLATILE_JSON_FIELDS:
        data.pop(field, None)
    return data


def is_up_to_date(name: str, original: str, expected: str) -> bool:
    if name == "additional-platforms.json":
        try:
            return _without_volatile_fields(original) == _without_volatile_fields(
                expected
            )
        except json.JSONDecodeError:
            return False
    return original == expected


def check() -> list[LintMessage]:
    with tempfile.TemporaryDirectory() as tmp:
        try:
            expected = generate(Path(tmp))
        except (RuntimeError, OSError) as err:
            return [
                LintMessage(
                    path=None,
                    line=None,
                    char=None,
                    code=LINTER_CODE,
                    severity=LintSeverity.ERROR,
                    name="generator-failed",
                    original=None,
                    replacement=None,
                    description=f"Could not regenerate tools/quick_start:\n{err}",
                )
            ]

    messages = []
    for name in GENERATED_FILES:
        path = QUICK_START / name
        original = path.read_text() if path.exists() else ""
        if is_up_to_date(name, original, expected[name]):
            continue
        messages.append(
            LintMessage(
                path=str(path.relative_to(REPO_ROOT)),
                line=None,
                char=None,
                code=LINTER_CODE,
                severity=LintSeverity.ERROR,
                name="generated-file-out-of-date",
                original=original,
                replacement=expected[name],
                description=(
                    "This file is generated from tools/scripts/generate_binary_build_matrix.py "
                    "and the inputs in tools/quick_start. "
                    "Run `lintrunner --take QUICK_START -a` to regenerate it."
                ),
            )
        )
    return messages


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Check that the generated files in tools/quick_start are up to date.",
        fromfile_prefix_chars="@",
    )
    parser.add_argument("--verbose", action="store_true")
    # lintrunner passes the matching files; the whole module is checked at once.
    parser.add_argument("filenames", nargs="*")
    args = parser.parse_args()
    logging.basicConfig(
        format="<%(threadName)s:%(levelname)s> %(message)s",
        level=logging.DEBUG if args.verbose else logging.INFO,
        stream=sys.stderr,
    )

    start = time.monotonic()
    for message in check():
        print(json.dumps(message._asdict()), flush=True)
    logging.debug("Checked tools/quick_start in %.1fs", time.monotonic() - start)


if __name__ == "__main__":
    main()
