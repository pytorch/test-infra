from __future__ import annotations
from dataclasses import dataclass
from typing import List, Union, Optional
import ast


@dataclass
class TypeName:
    """
    Represents a simple type name, like `str` or `int`.
    """

    name: str

    def __str__(self):
        return self.name


@dataclass
class Constant:
    """
    Represents a constant, like `None` or `True`.
    """

    value: str

    def __str__(self):
        return self.value


@dataclass
class Generic:
    """
    Represents a generic type, like `List[int]` or `Dict[str, int]`.
    """

    base: Union[TypeName, 'Attribute']
    arguments: List[TypeHint]

    def __str__(self):
        arguments_str = ', '.join(str(arg) for arg in self.arguments)
        return f"{str(self.base)}[{arguments_str}]"


@dataclass
class Tuple:
    """
    Represents a tuple type, like `Tuple[int, str]`.
    """

    arguments: List[TypeHint]

    def __str__(self):
        return ', '.join(str(arg) for arg in self.arguments)


@dataclass
class Attribute:
    """
    Represents an attribute, like `foo.bar` or `foo.bar.baz`.
    """

    value: Union[TypeName, 'Attribute']
    attr: str

    def __str__(self):
        return f"{str(self.value)}.{self.attr}"


@dataclass
class Unknown:
    """
    Represents an unknown type (e.g. a type that couldn't be mapped currently).
    """

    raw: str

    def __str__(self):
        return self.raw


TypeHint = Union[TypeName, Constant, Generic, Tuple, Attribute, Unknown]


def annotation_to_dataclass(annotation) -> Optional[TypeHint]:
    """Converts an AST annotation to a dataclass."""
    if annotation is None:
        return None
    elif isinstance(annotation, ast.Name):
        return TypeName(annotation.id)
    elif isinstance(annotation, ast.Constant):
        return Constant(str(annotation.value))
    # tuple
    elif isinstance(annotation, ast.Tuple):
        return Tuple([annotation_to_dataclass(el) for el in annotation.elts])
    elif isinstance(annotation, ast.Subscript):
        base = annotation_to_dataclass(annotation.value)
        arguments = annotation_to_dataclass(annotation.slice)
        # either a single argument or a tuple
        return (
            Generic(base, [arguments])
            if not isinstance(arguments, Tuple)
            else Generic(base, arguments.arguments)
        )
    elif isinstance(annotation, ast.Attribute):
        value = annotation_to_dataclass(annotation.value)
        return Attribute(value, annotation.attr)
    else:
        return Unknown(str(annotation))
