"""GitHub integration for the API compatibility checker."""

import pathlib

import api.compatibility


def render_violation(file: pathlib.Path, violation: api.compatibility.Violation) -> str:
    return (
        f'::warning file={file},line={violation.line}::'
        f'Function {violation.func}: {violation.message}'
    )
