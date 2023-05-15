"""Understands compatibility of APIs."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
import difflib
import pathlib
import tempfile

import api
import api.ast
import api.git
import api.violations


def check_range(
    repo: api.git.Repository, *, head: str, base: str
) -> Mapping[pathlib.Path, Sequence[api.violations.Violation]]:
    result = {}
    for file in repo.get_files_in_range(f'{base}..{head}'):
        # Someday, we'll want to customize the filters we use to
        # ignore files.
        if file.suffix != '.py':
            # Only consider Python files.
            continue
        if any(dir.name.startswith('_') for dir in file.parents):
            # Ignore any internal packages.
            continue
         if any(dir.name.startswith('.') for dir in file.parents):
            # Ignore any internal packages and ci modules
            continue
        if file.name.startswith('_'):
            # Ignore internal modules.
            continue
        if any(dir.name.startswith('test') for dir in file.parents):
            # Ignore test packages.
            continue
        if file.name.startswith('test_') or file.stem.endswith('_test'):
            # Ignore test files.
            continue


        # Get the contents before and after the diff.
        #
        # Note that if the file doesn't exist, it is equivalent to it
        # being empty.
        after = repo.get_contents(file, commit_id=head) or ''
        before = repo.get_contents(file, commit_id=base) or ''

        with (
            tempfile.NamedTemporaryFile() as before_file,
            tempfile.NamedTemporaryFile() as after_file,
        ):
            before_path = pathlib.Path(before_file.name)
            after_path = pathlib.Path(after_file.name)
            before_path.write_text(before)
            after_path.write_text(after)

            violations = api.compatibility.check(before_path, after_path)
            if len(violations) > 0:
                result[file] = violations

    return result


def check(
    before: pathlib.Path, after: pathlib.Path
) -> Sequence[api.violations.Violation]:
    """Identifies API compatibility issues between two files."""
    before_api = api.ast.extract(before)
    after_api = api.ast.extract(after)

    violations: list[api.violations.Violation] = []
    for name, before_def in before_api.items():
        if any(token.startswith('_') for token in name.split('.')):
            continue

        after_def = after_api.get(name)
        if after_def is None:
            violations.append(api.violations.FunctionDeleted(func=name, line=1))
            continue

        # Let's refine some terminology. Parameters come in three flavors:
        #  * positional only
        #  * keyword only
        #  * flexible: may be provided positionally or via keyword
        #
        # Required parameter: a parameter that must be provided as an
        # argument by callers. In other words, the function does not
        # have a default value.
        #
        # Variadic parameters: additional arguments that may only be
        # provided positionally, traditionally specified as *args in a
        # function definition.
        #
        # Variadic keywords: additional arguments that may only be
        # provided by name, traditionally specified as **kwargs in a
        # function definition.

        violations += _check_by_name(name, before_def, after_def)
        violations += _check_by_position(name, before_def, after_def)
        violations += _check_by_requiredness(name, before_def, after_def)
        violations += _check_variadic_parameters(name, before_def, after_def)

    return violations


def _check_by_name(
    func: str, before: api.Parameters, after: api.Parameters
) -> Iterable[api.violations.Violation]:
    """Checks for violations among the named parameters."""
    for name, before_param in _keyword_only_parameters(before).items():
        assert before_param.name == name
        after_param = _keyword_only_parameters(after).get(name)
        if after_param is None:
            yield api.violations.ParameterRemoved(
                func=func, parameter=name, line=after.line
            )
            continue
        assert after_param.name == name

    for name, after_param in _keyword_only_parameters(after).items():
        assert after_param.name == name
        if after_param.required and name not in _keyword_only_parameters(before):
            yield api.violations.ParameterNowRequired(
                func=func, parameter=name, line=after.line
            )


def _keyword_only_parameters(params: api.Parameters) -> Mapping[str, api.Parameter]:
    """Extracts the parameters that can be passed by name."""
    return (
        {param.name: param for param in params.parameters if not param.positional}
        if len(params.parameters) > 0
        else {}
    )


def _check_by_position(
    func: str, before: api.Parameters, after: api.Parameters
) -> Iterable[api.violations.Violation]:
    """Checks for violations among the positional parameters."""

    before_params = [param for param in before.parameters if param.positional]
    after_params = [param for param in after.parameters if param.positional]

    before_param_names = [param.name for param in before_params]
    after_param_names = [param.name for param in after_params]

    if before_param_names == after_param_names:
        return

    if set(before_param_names) == set(after_param_names):
        yield api.violations.ParameterReordered(
            func=func,
            line=after.line,
        )
        return

    matcher = difflib.SequenceMatcher(a=before_param_names, b=after_param_names)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            continue
        if tag == 'replace':
            yield api.violations.ParameterRenamed(
                func=func,
                parameter=before_param_names[i1],
                parameter_after=after_param_names[j1],
                line=after.line,
            )
            continue
        if tag == 'insert':
            after_param = after_params[j1]
            if after_param.required:
                yield api.violations.ParameterNowRequired(
                    func=func,
                    parameter=after_param.name,
                    line=after_param.line,
                )
            continue
        if tag == 'delete':
            yield api.violations.ParameterRemoved(
                func=func,
                parameter=before_params[i1].name,
                line=after.line,
            )

    # TODO support renaming parameters.
    # Positional parameters may be renamed, but may not be
    # reordered. For example, f(x, y) may be changed to f(x, z) but
    # may not be changed to f(y, x). The idea here is that if an
    # argument is renamed, it could theoretically have the same
    # semantics as before, but if it is reordered, we expect that the
    # semantics would remain bound to the names.


def _check_by_requiredness(
    func: str, before: api.Parameters, after: api.Parameters
) -> Iterable[api.violations.Violation]:
    """Checks for parameters that were made required."""
    before_params = _parameters_by_name(before)
    after_params = _parameters_by_name(after)
    if before_params == after_params:
        return []

    for name, before_param in before_params.items():
        after_param = after_params.get(name)
        if after_param is None:
            continue
        if not before_param.required and after_param.required:
            yield api.violations.ParameterBecameRequired(
                func=func, parameter=before_param.name, line=after.line
            )


def _parameters_by_name(params: api.Parameters) -> Mapping[str, api.Parameter]:
    """Indexes the parameters by their name."""
    return {param.name: param for param in params.parameters}


def _check_variadic_parameters(
    func: str, before: api.Parameters, after: api.Parameters
) -> Iterable[api.violations.Violation]:
    """Checks that support for variadic parameters is not removed."""
    if before.variadic_args and not after.variadic_args:
        yield api.violations.VarArgsDeleted(func=func, line=after.line)
    if before.variadic_kwargs and not after.variadic_kwargs:
        yield api.violations.KwArgsDeleted(func, line=after.line)
