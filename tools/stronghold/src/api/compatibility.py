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
        if any(dir.name == 'test' for dir in file.parents):
            # Ignore tests (not part of PyTorch package).
            continue
        if any(dir.name == 'benchmarks' for dir in file.parents):
            # Ignore benchmarks (not part of PyTorch package).
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
        if not _check_type_compatibility(
            before_param.type_annotation, after_param.type_annotation
        ):
            yield api.violations.ParameterTypeChanged(
                func=func,
                parameter=name,
                line=after.line,
                type_before=str(before_param.type_annotation),
                type_after=str(after_param.type_annotation),
            )
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
        for p_before, p_after in zip(before_params, after_params):
            if not _check_type_compatibility(
                p_before.type_annotation, p_after.type_annotation
            ):
                yield api.violations.ParameterTypeChanged(
                    func=func,
                    parameter=p_before.name,
                    line=p_after.line,
                    type_before=str(p_before.type_annotation),
                    type_after=str(p_after.type_annotation),
                )
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


def _check_type_compatibility(
    type_before: api.types.TypeHint, type_after: api.types.TypeHint
) -> bool:
    """Checks that the type annotations are compatible.
    Returns True if compatible.
    """
    # If annotations are identical, they are compatible
    if type_before == type_after:
        return True

    # If either of the annotations is None, then we can't make a compatibility judgement
    # because Python allows functions to have untyped parameters.
    if type_before is None or type_after is None:
        return True

    # if either of the types is Unknown, then we can't make a compatibility judgement
    if isinstance(type_before, api.types.Unknown) or isinstance(
        type_after, api.types.Unknown
    ):
        return True

    # Checks compatibility if one types is Constant
    if isinstance(type_before, api.types.Constant) or isinstance(
        type_after, api.types.Constant
    ):
        # optimistically allow for type expansion: was constant, now is not constant
        if isinstance(type_before, api.types.Constant) and not isinstance(
            type_after, api.types.Constant
        ):
            return True

        # fail if the type was not constant before, but became constant now,
        # or if the constant value changed
        return False

    # Checks compatibility if one types is simple (e.g. int, str, etc.)
    # or Attribute (e.g. api.types.FooBar)
    if (
        isinstance(type_before, api.types.TypeName)
        or isinstance(type_after, api.types.TypeName)
        or isinstance(type_before, api.types.Attribute)
        or isinstance(type_after, api.types.Attribute)
    ):
        # fail (the equality is checked earlier)
        return False

    # Checks compatibility if both annotations are generic types
    # (like List[int], Dict[str, int], etc.)
    if isinstance(type_before, api.types.Generic) or isinstance(
        type_after, api.types.Generic
    ):
        if not isinstance(type_before, api.types.Generic) or not isinstance(
            type_after, api.types.Generic
        ):
            # fail if one of the types is generic, but the other is not
            return False

        # fail if the generic type changed or generic type arguments changed
        if type_before.base != type_after.base or len(type_before.arguments) != len(
            type_after.arguments
        ):
            return False

        for type_before_arg, type_after_arg in zip(
            type_before.arguments, type_after.arguments
        ):
            if not _check_type_compatibility(type_before_arg, type_after_arg):
                return False

    return True
