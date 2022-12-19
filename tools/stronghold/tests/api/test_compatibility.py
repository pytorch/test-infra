import pathlib
import textwrap
from typing import Any

import pytest

import api.compatibility

from testing import git
from testing import source


def test_deleted_function(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    after = source.make_file(tmp_path, lambda: None)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'function deleted', line=1)
    ]


def test_renamed_function(tmp_path: pathlib.Path) -> None:
    """Tests that a renamed function is just flagged as a deleted function."""

    def rose(a: int, /, b: int = 2, *args: int, c: int, **kwargs: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, rose)

    def rose_by_any_other_name(
        a: int, /, b: int = 2, *args: int, c: int, **kwargs: int
    ) -> None:
        pass  # pragma: no cover

    after = source.make_file(tmp_path, rose_by_any_other_name)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('rose', 'function deleted', line=1)
    ]


def test_deleted_method(tmp_path: pathlib.Path) -> None:
    class Class:
        def func(self, /) -> None:
            pass  # pragma: no cover

    before = source.make_file(tmp_path, Class)

    after = source.make_file(tmp_path, lambda: None)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('Class.func', 'function deleted', line=1)
    ]


def test_deleted_variadic_args(tmp_path: pathlib.Path) -> None:
    def func(*args: Any) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'removed *varargs', line=1)
    ]


def test_deleted_variadic_kwargs(tmp_path: pathlib.Path) -> None:
    def func(**kwargs: Any) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'removed **kwargs', line=1)
    ]


def test_unchanged_function(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    assert (
        api.compatibility.check(
            source.make_file(tmp_path, func), source.make_file(tmp_path, func)
        )
        == []
    )


def test_new_renamed_positional_parameter(tmp_path: pathlib.Path) -> None:
    def func(x: int, /) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(y: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was renamed to y', line=1),
    ]


def test_removed_positional_parameter(tmp_path: pathlib.Path) -> None:
    def func(x: int, /) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was removed', line=1)
    ]


def test_removed_flexible_parameter(tmp_path: pathlib.Path) -> None:
    def func(x: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was removed', line=1)
    ]


def test_removed_keyword_parameter(tmp_path: pathlib.Path) -> None:
    def func(*, x: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was removed', line=1)
    ]


def test_new_required_positional_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was added and is required', line=1)
    ]


def test_new_required_flexible_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was added and is required', line=1)
    ]


def test_new_required_keyword_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(*, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x was added and is required', line=1)
    ]


def test_new_optional_positional_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int = 0, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


def test_new_optional_flexible_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int = 0) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


def test_new_optional_keyword_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(*, x: int = 0) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


def test_positional_parameter_becomes_required(tmp_path: pathlib.Path) -> None:
    def func(x: int = 0, /) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x became required', line=1)
    ]


def test_flexible_parameter_becomes_required(tmp_path: pathlib.Path) -> None:
    def func(x: int = 0) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x became required', line=1)
    ]


def test_keyword_parameter_becomes_required(tmp_path: pathlib.Path) -> None:
    def func(*, x: int = 0) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(*, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation('func', 'x became required', line=1)
    ]


def test_positional_parameters_reordered(tmp_path: pathlib.Path) -> None:
    def func(x: int, y: int, /) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(y: int, x: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation(
            'func', 'positional parameters were reordered', line=1
        ),
    ]


def test_flexible_parameters_reordered(tmp_path: pathlib.Path) -> None:
    def func(x: int, y: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(y: int, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation(
            'func', 'positional parameters were reordered', line=1
        ),
    ]


def test_keyword_parameters_reordered(tmp_path: pathlib.Path) -> None:
    def func(*, x: int, y: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(*, y: int, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


def test_ignores_internal_func(tmp_path: pathlib.Path) -> None:
    def _func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, _func)
    after = source.make_file(tmp_path, lambda: None)

    # _func was deleted but it's not a violation because it's
    # internal.
    assert api.compatibility.check(before, after) == []


def test_ignores_internal_class(tmp_path: pathlib.Path) -> None:
    class _Class:
        def func(self, /) -> None:
            pass  # pragma: no cover

    before = source.make_file(tmp_path, _Class)
    after = source.make_file(tmp_path, lambda: None)

    # _Class was deleted but it's not a violation because it's
    # internal.
    assert api.compatibility.check(before, after) == []


def test_multiple_params(tmp_path: pathlib.Path) -> None:
    def func(
        b: int,
        c: int,
        /,
        d: int,
        e: int,
        *args: int,
        f: int,
        **kwds: int,
    ) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(  # type: ignore[no-redef]
        a: int,
        b: int,
        c: int,
        /,
        d: int,
        e: int,
        *args: int,
        f: int,
        **kwds: int,
    ) -> None:
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.compatibility.Violation(
            'func',
            'a was added and is required',
            line=2,
        ),
    ]


@pytest.mark.parametrize(
    'path',
    [
        'python.cpp',
        '_internal/module.py',
        '_module.py',
        'test/module.py',
        'test_module.py',
        'module_test.py',
    ],
)
def test_check_range_skips(path: str, git_repo: api.git.Repository) -> None:
    git.commit_file(
        git_repo,
        pathlib.Path(path),
        textwrap.dedent(
            '''
            def will_be_deleted():
              pass
            '''
        ),
    )
    git.commit_file(git_repo, pathlib.Path(path), '')
    violations = api.compatibility.check_range(git_repo, head='HEAD', base='HEAD~')
    assert violations == {}


def test_check_range(git_repo: api.git.Repository) -> None:
    git.commit_file(
        git_repo,
        pathlib.Path('module.py'),
        textwrap.dedent(
            '''
            def will_be_deleted():
              pass
            '''
        ),
    )
    git.commit_file(git_repo, pathlib.Path('module.py'), '')

    violations = api.compatibility.check_range(git_repo, head='HEAD', base='HEAD~')

    assert violations == {
        pathlib.Path('module.py'): [
            api.compatibility.Violation('will_be_deleted', 'function deleted', line=1)
        ],
    }
