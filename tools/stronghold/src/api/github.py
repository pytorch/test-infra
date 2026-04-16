"""GitHub integration for the API compatibility checker."""

import pathlib

import api.compatibility
import api.violations


def render_violation(
    level: str, file: pathlib.Path, violation: api.violations.Violation
) -> str:
    return (
        f"::{level} file={file},line={violation.line}::"
        f"Function {violation.func}: {violation.message}"
    )
