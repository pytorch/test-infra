"""Tests the api.ast module, specific to parameter types."""

import pathlib
from typing import List, Optional, Dict, Tuple, Union

import api
import api.ast
import api.types

from testing import source


def extractParameterTypes(tmp_path: pathlib.Path) -> List[Optional[api.types.TypeHint]]:
    """Extracts the parameter types from a function definition."""
    funcs = api.ast.extract(tmp_path)
    if not funcs:
        return []
    return [param.annotation for func in funcs.values() for param in func.parameters]


def test_none(tmp_path: pathlib.Path) -> None:
    def func(a, /):
        pass  # pragma: no cover

    params = extractParameterTypes(source.make_file(tmp_path, func))
    assert params == [None]

def test_named_types(tmp_path: pathlib.Path) -> None:
    def func(a: int, b: float, c: List, /):
        pass  # pragma: no cover

    params = extractParameterTypes(source.make_file(tmp_path, func))
    assert params == [
        api.types.TypeName('int'),
        api.types.TypeName('float'),
        api.types.TypeName('List'),
    ]

def test_constant_types(tmp_path: pathlib.Path) -> None:
    def func(a: None, b: True, c: False, /):
        pass  # pragma: no cover

    params = extractParameterTypes(source.make_file(tmp_path, func))
    assert params == [
        api.types.Constant('None'),
        api.types.Constant('True'),
        api.types.Constant('False'),
    ]


def test_generic_types(tmp_path: pathlib.Path) -> None:
    def func(a: List[int], b: Dict[str, int], c: Tuple[int, str], d: List[Dict[str, int]], /):
        pass

    params = extractParameterTypes(source.make_file(tmp_path, func))
    assert params == [
        api.types.Generic(
            base=api.types.TypeName('List'),
            arguments=[api.types.TypeName('int')],
        ),
        api.types.Generic(
            base=api.types.TypeName('Dict'),
            arguments=[api.types.TypeName('str'), api.types.TypeName('int')],
        ),
        api.types.Generic(
            base=api.types.TypeName('Tuple'),
            arguments=[api.types.TypeName('int'), api.types.TypeName('str')],
        ),
        api.types.Generic(
            base=api.types.TypeName('List'),
            arguments=[
                api.types.Generic(
                    base=api.types.TypeName('Dict'),
                    arguments=[api.types.TypeName('str'), api.types.TypeName('int')],
                )
            ],
        ),
    ]


def test_attribute_types(tmp_path: pathlib.Path) -> None:
    def func(a: api.types.TypeName, b: api.types.Attribute, /):
        pass

    params = extractParameterTypes(source.make_file(tmp_path, func))
    assert params == [
        api.types.Attribute(
            value=api.types.Attribute(
                value=api.types.TypeName('api'),
                attr='types',
            ),
            attr='TypeName',
        ),
        api.types.Attribute(
            value=api.types.Attribute(
                value=api.types.TypeName('api'),
                attr='types',
            ),
            attr='Attribute',
        ),
    ]


def test_unknown_types(tmp_path: pathlib.Path) -> None:
    def func2():
        pass

    def func1(a: func2(), b: lambda x: x, /):
        pass

    params = extractParameterTypes(source.make_file(tmp_path, func1))

    assert len(params) == 2
    assert isinstance(params[0], api.types.Unknown)
    assert isinstance(params[1], api.types.Unknown)
