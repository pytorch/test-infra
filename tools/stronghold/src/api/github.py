"""GitHub integration for the API compatibility checker."""

import pathlib

import api.compatibility


def render_violation(
    level: str, file: pathlib.Path, violation: api.compatibility.Violation
) -> str:
    return (
        f'::{level} file={file},line={violation.line}::'
        f'Function {violation.func}: {violation.message}'
    )
