"""Tests the api.ast module."""

import inspect
import pathlib
import tempfile
import textwrap
from typing import Any

import api
import api.ast


def test_extract_empty(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(_to_source_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[], variadic_args=False, variadic_kwargs=False
        )
    }


def test_extract_positional(tmp_path: pathlib.Path) -> None:
    def func(x: int, /) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(_to_source_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(name='x', position=0, keyword=False, required=True)
            ],
            variadic_args=False,
            variadic_kwargs=False,
        )
    }


def test_extract_positional_with_default(tmp_path: pathlib.Path) -> None:
    def func(x: int = 0, /) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(_to_source_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(name='x', position=0, keyword=False, required=False)
            ],
            variadic_args=False,
            variadic_kwargs=False,
        )
    }


def test_extract_flexible(tmp_path: pathlib.Path) -> None:
    def func(x: int) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(_to_source_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(name='x', position=0, keyword=True, required=True)
            ],
            variadic_args=False,
            variadic_kwargs=False,
        )
    }


def test_extract_flexible_with_default(tmp_path: pathlib.Path) -> None:
    def func(x: int = 0) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(_to_source_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(name='x', position=0, keyword=True, required=False)
            ],
            variadic_args=False,
            variadic_kwargs=False,
        )
    }


def test_extract_keyword(tmp_path: pathlib.Path) -> None:
    def func(*, x: int) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(_to_source_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(name='x', position=None, keyword=True, required=True)
            ],
            variadic_args=False,
            variadic_kwargs=False,
        )
    }


def test_extract_keyword_with_default(tmp_path: pathlib.Path) -> None:
    def func(*, x: int = 0) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(_to_source_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(name='x', position=None, keyword=True, required=False)
            ],
            variadic_args=False,
            variadic_kwargs=False,
        )
    }


def test_extract_variadic_args(tmp_path: pathlib.Path) -> None:
    def func(*args: int) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(_to_source_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(parameters=[], variadic_args=True, variadic_kwargs=False)
    }


def test_extract_variadic_kwargs(tmp_path: pathlib.Path) -> None:
    def func(**kwargs: int) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(_to_source_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(parameters=[], variadic_args=False, variadic_kwargs=True)
    }


def test_extract_class_method(tmp_path: pathlib.Path) -> None:
    class Class:
        def func(self, /) -> None:
            pass  # pragma: no cover

    funcs = api.ast.extract(_to_source_file(tmp_path, Class))
    assert funcs == {
        'Class.func': api.Parameters(
            parameters=[
                api.Parameter(
                    name='self',
                    position=0,
                    keyword=False,
                    required=True,
                ),
            ],
            variadic_args=False,
            variadic_kwargs=False,
        )
    }


def test_extract_comprehensive(tmp_path: pathlib.Path) -> None:
    class Class:
        def func(
            self, a: int, /, b: int = 2, *args: int, c: int, **kwargs: int
        ) -> None:
            pass  # pragma: no cover

    funcs = api.ast.extract(_to_source_file(tmp_path, Class))
    assert funcs == {
        'Class.func': api.Parameters(
            parameters=[
                api.Parameter(
                    name='self',
                    position=0,
                    keyword=False,
                    required=True,
                ),
                api.Parameter(
                    name='a',
                    position=1,
                    keyword=False,
                    required=True,
                ),
                api.Parameter(
                    name='b',
                    position=2,
                    keyword=True,
                    required=False,
                ),
                api.Parameter(
                    name='c',
                    position=None,
                    keyword=True,
                    required=True,
                ),
            ],
            variadic_args=True,
            variadic_kwargs=True,
        )
    }


def _to_source_file(tmp_path: pathlib.Path, object: Any) -> pathlib.Path:
    """Takes source and writes it into a temporary file, returning the path."""
    path = pathlib.Path(tempfile.mkstemp(dir=tmp_path)[1])
    path.write_text(textwrap.dedent(inspect.getsource(object)))
    return path
