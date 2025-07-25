"""The API package deals with Python APIs and how they compare to each other."""

from __future__ import annotations

import dataclasses
from collections.abc import Sequence, Mapping
from typing import Optional

import api.types


@dataclasses.dataclass
class Parameters:
    """Represents all of the parameters of a function."""

    # The function's parameters in the order in which they are
    # defined.
    parameters: Sequence[Parameter]
    # Whether or not the function takes variadic positional arguments.
    variadic_args: bool
    # Whether or not the function takes variadic keyword arguments.
    variadic_kwargs: bool
    # The line where the function is defined.
    line: int


@dataclasses.dataclass
class Parameter:
    """Represents a single parameter to a function."""

    # The name of the parameter, only usable if it may be provided as
    # a keyword argument.
    name: str
    # Whether or not this parameter may be provided positionally.
    positional: bool
    # Whether or not this parameter may be provided by name.
    keyword: bool
    # Whether or not this parameter must be provided.
    required: bool
    # Which line the parameter is defined on.
    line: int
    # Type annotation (relies on ast.annotation types)
    type_annotation: Optional[api.types.TypeHint] = None


@dataclasses.dataclass
class Field:
    """Represents a dataclass or class attribute."""

    name: str
    required: bool
    line: int
    type_annotation: Optional[api.types.TypeHint] = None


@dataclasses.dataclass
class Class:
    """Represents a class or dataclass."""

    fields: Sequence[Field]
    line: int
    dataclass: bool = False


@dataclasses.dataclass
class API:
    """Represents extracted API information."""

    functions: Mapping[str, Parameters]
    classes: Mapping[str, Class]
