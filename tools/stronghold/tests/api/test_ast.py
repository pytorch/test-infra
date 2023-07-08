"""Tests the api.ast module."""

import pathlib

import api
import api.ast
import api.types

from testing import source


def test_extract_empty(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(source.make_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[], variadic_args=False, variadic_kwargs=False, line=1
        )
    }


def test_extract_positional(tmp_path: pathlib.Path) -> None:
    def func(x: int, /) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(source.make_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(
                    name='x',
                    positional=True,
                    keyword=False,
                    required=True,
                    line=1,
                    type_annotation=api.types.TypeName('int'),
                )
            ],
            variadic_args=False,
            variadic_kwargs=False,
            line=1,
        )
    }


def test_extract_positional_with_default(tmp_path: pathlib.Path) -> None:
    def func(x: int = 0, /) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(source.make_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(
                    name='x',
                    positional=True,
                    keyword=False,
                    required=False,
                    line=1,
                    type_annotation=api.types.TypeName('int'),
                )
            ],
            variadic_args=False,
            variadic_kwargs=False,
            line=1,
        )
    }


def test_extract_flexible(tmp_path: pathlib.Path) -> None:
    def func(x: int) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(source.make_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(
                    name='x',
                    positional=True,
                    keyword=True,
                    required=True,
                    line=1,
                    type_annotation=api.types.TypeName('int'),
                )
            ],
            variadic_args=False,
            variadic_kwargs=False,
            line=1,
        )
    }


def test_extract_flexible_with_default(tmp_path: pathlib.Path) -> None:
    def func(x: int = 0) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(source.make_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(
                    name='x',
                    positional=True,
                    keyword=True,
                    required=False,
                    line=1,
                    type_annotation=api.types.TypeName('int'),
                )
            ],
            variadic_args=False,
            variadic_kwargs=False,
            line=1,
        )
    }


def test_extract_keyword(tmp_path: pathlib.Path) -> None:
    def func(*, x: int) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(source.make_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(
                    name='x',
                    positional=False,
                    keyword=True,
                    required=True,
                    line=1,
                    type_annotation=api.types.TypeName('int'),
                )
            ],
            variadic_args=False,
            variadic_kwargs=False,
            line=1,
        )
    }


def test_extract_keyword_with_default(tmp_path: pathlib.Path) -> None:
    def func(*, x: int = 0) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(source.make_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[
                api.Parameter(
                    name='x',
                    positional=False,
                    keyword=True,
                    required=False,
                    line=1,
                    type_annotation=api.types.TypeName('int'),
                )
            ],
            variadic_args=False,
            variadic_kwargs=False,
            line=1,
        )
    }


def test_extract_variadic_args(tmp_path: pathlib.Path) -> None:
    def func(*args: int) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(source.make_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[], variadic_args=True, variadic_kwargs=False, line=1
        )
    }


def test_extract_variadic_kwargs(tmp_path: pathlib.Path) -> None:
    def func(**kwargs: int) -> None:
        pass  # pragma: no cover

    funcs = api.ast.extract(source.make_file(tmp_path, func))
    assert funcs == {
        'func': api.Parameters(
            parameters=[], variadic_args=False, variadic_kwargs=True, line=1
        )
    }


def test_extract_class_method(tmp_path: pathlib.Path) -> None:
    class Class:
        def func(self, /) -> None:
            pass  # pragma: no cover

    funcs = api.ast.extract(source.make_file(tmp_path, Class))
    assert funcs == {
        'Class.func': api.Parameters(
            parameters=[
                api.Parameter(
                    name='self',
                    positional=True,
                    keyword=False,
                    required=True,
                    line=2,
                ),
            ],
            variadic_args=False,
            variadic_kwargs=False,
            line=2,
        )
    }


def test_extract_comprehensive(tmp_path: pathlib.Path) -> None:
    class Class:
        def func(
            self, a: int, /, b: float = 2, *args: int, c: int, **kwargs: int
        ) -> None:
            pass  # pragma: no cover

    funcs = api.ast.extract(source.make_file(tmp_path, Class))
    assert funcs == {
        'Class.func': api.Parameters(
            parameters=[
                api.Parameter(
                    name='self',
                    positional=True,
                    keyword=False,
                    required=True,
                    line=3,
                ),
                api.Parameter(
                    name='a',
                    positional=True,
                    keyword=False,
                    required=True,
                    line=3,
                    type_annotation=api.types.TypeName('int'),
                ),
                api.Parameter(
                    name='b',
                    positional=True,
                    keyword=True,
                    required=False,
                    line=3,
                    type_annotation=api.types.TypeName('float'),
                ),
                api.Parameter(
                    name='c',
                    positional=False,
                    keyword=True,
                    required=True,
                    line=3,
                    type_annotation=api.types.TypeName('int'),
                ),
            ],
            variadic_args=True,
            variadic_kwargs=True,
            line=2,
        )
    }
