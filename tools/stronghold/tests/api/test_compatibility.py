import inspect
import pathlib
import tempfile
import textwrap
from typing import Any

import api.compatibility


def test_deleted_function(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    after = _to_source_file(tmp_path, lambda: None)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'function deleted')
    ]


def test_renamed_function(tmp_path: pathlib.Path) -> None:
    """Tests that a renamed function is just flagged as a deleted function."""

    def rose(a: int, /, b: int = 2, *args, c: int, **kwwargs) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, rose)

    def rose_by_any_other_name(a: int, /, b: int = 2, *args, c: int, **kwwargs) -> None:
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, rose_by_any_other_name)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('rose', 'function deleted')
    ]


def test_deleted_method(tmp_path: pathlib.Path) -> None:
    class Class:
        def func(self, /) -> None:
            pass  # pragma: no cover

    before = _to_source_file(tmp_path, Class)

    after = _to_source_file(tmp_path, lambda: None)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('Class.func', 'function deleted')
    ]


def test_deleted_variadic_args(tmp_path: pathlib.Path) -> None:
    def func(*args: Any) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'removed *varargs')
    ]


def test_deleted_variadic_kwargs(tmp_path: pathlib.Path) -> None:
    def func(**kwargs: Any) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'removed **kwargs')
    ]


def test_unchanged_function(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    assert (
        api.compatibility.check(
            _to_source_file(tmp_path, func), _to_source_file(tmp_path, func)
        )
        == []
    )


def test_new_renamed_positional_parameter(tmp_path: pathlib.Path) -> None:
    def func(x: int, /) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func(y: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was renamed to y')
    ]


def test_removed_positional_parameter(tmp_path: pathlib.Path) -> None:
    def func(x: int, /) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was removed')
    ]


def test_removed_flexible_parameter(tmp_path: pathlib.Path) -> None:
    def func(x: int) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was removed')
    ]


def test_removed_keyword_parameter(tmp_path: pathlib.Path) -> None:
    def func(*, x: int) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was removed')
    ]


def test_new_required_positional_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func(x: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was added and is required')
    ]


def test_new_required_flexible_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func(x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was added and is required')
    ]


def test_new_required_keyword_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func(*, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was added and is required')
    ]


def test_positional_parameter_becomes_required(tmp_path: pathlib.Path) -> None:
    def func(x: int = 0, /) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func(x: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x became required')
    ]


def test_flexible_parameter_becomes_required(tmp_path: pathlib.Path) -> None:
    def func(x: int = 0) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func(x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x became required')
    ]


def test_keyword_parameter_becomes_required(tmp_path: pathlib.Path) -> None:
    def func(*, x: int = 0) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func(*, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x became required')
    ]


def test_positional_parameters_reordered(tmp_path: pathlib.Path) -> None:
    def func(x: int, y: int, /) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func(y: int, x: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was renamed to y'),
        api.compatibility.Violation('func', 'y was renamed to x'),
    ]


def test_flexible_parameters_reordered(tmp_path: pathlib.Path) -> None:
    def func(x: int, y: int) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func(y: int, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'the position of x moved from 0 to 1'),
        api.compatibility.Violation('func', 'the position of y moved from 1 to 0'),
    ]


def test_keyword_parameters_reordered(tmp_path: pathlib.Path) -> None:
    def func(*, x: int, y: int) -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, func)

    def func(*, y: int, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = _to_source_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


def test_ignores_internal_func(tmp_path: pathlib.Path) -> None:
    def _func() -> None:
        pass  # pragma: no cover

    before = _to_source_file(tmp_path, _func)
    after = _to_source_file(tmp_path, lambda: None)

    # _func was deleted but it's not a violation because it's
    # internal.
    assert api.compatibility.check(before, after) == []


def test_ignores_internal_class(tmp_path: pathlib.Path) -> None:
    class _Class:
        def func(self, /) -> None:
            pass  # pragma: no cover

    before = _to_source_file(tmp_path, _Class)
    after = _to_source_file(tmp_path, lambda: None)

    # _Class was deleted but it's not a violation because it's
    # internal.
    assert api.compatibility.check(before, after) == []


def _to_source_file(tmp_path: pathlib.Path, object: Any) -> pathlib.Path:
    """Takes source and writes it into a temporary file, returning the path."""
    path = pathlib.Path(tempfile.mkstemp(dir=tmp_path)[1])
    path.write_text(textwrap.dedent(inspect.getsource(object)))
    return path
