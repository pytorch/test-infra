"""Responsible for dealing with Python APIs using the ast module."""

from __future__ import annotations

import ast
import os
import pathlib
from collections.abc import Mapping, Sequence

import api
import api.types


def extract(path: pathlib.Path, *, include_classes: bool = False) -> api.API:
    """Extracts API definitions from a given source file."""

    funcs, classes = extract_raw(path, include_classes=include_classes)
    parameters = {
        name: _function_def_to_parameters(func) for name, func in funcs.items()
    }
    return api.API(functions=parameters, classes=classes)


def extract_raw(
    path: pathlib.Path, *, include_classes: bool = False
) -> tuple[Mapping[str, ast.FunctionDef], Mapping[str, api.Class]]:
    """Extracts API as AST nodes."""

    funcs: dict[str, ast.FunctionDef] = {}
    classes: dict[str, api.Class] = {}
    _ContextualNodeVisitor(funcs, classes if include_classes else None, []).visit(
        ast.parse(path.read_text(), os.fspath(path))
    )
    return funcs, classes


def _function_def_to_parameters(node: ast.FunctionDef) -> api.Parameters:
    """Converts an ast.FunctionDef to api.Parameters."""
    args = node.args

    num_required = len(args.posonlyargs) + len(args.args) - len(args.defaults)
    assert num_required >= 0

    # Collect the position-only parameters.
    params = [
        api.Parameter(
            name=arg.arg,
            positional=True,
            keyword=False,
            required=i < num_required,
            line=arg.lineno,
            type_annotation=api.types.annotation_to_dataclass(arg.annotation),
        )
        for i, arg in enumerate(args.posonlyargs)
    ]
    # Collect the parameters that may be provided positionally or by
    # keyword.
    params += [
        api.Parameter(
            name=arg.arg,
            positional=True,
            keyword=True,
            required=i < num_required,
            line=arg.lineno,
            type_annotation=api.types.annotation_to_dataclass(arg.annotation),
        )
        for i, arg in enumerate(args.args, start=len(args.posonlyargs))
    ]

    # Collect the keyword-only parameters.
    assert len(args.kwonlyargs) == len(args.kw_defaults)
    params += [
        api.Parameter(
            name=arg.arg,
            positional=False,
            keyword=True,
            required=args.kw_defaults[i] is None,
            line=arg.lineno,
            type_annotation=api.types.annotation_to_dataclass(arg.annotation),
        )
        for i, arg in enumerate(args.kwonlyargs)
    ]
    return api.Parameters(
        parameters=params,
        variadic_args=args.vararg is not None,
        variadic_kwargs=args.kwarg is not None,
        line=node.lineno,
    )


class _ContextualNodeVisitor(ast.NodeVisitor):
    """NodeVisitor that collects functions and optionally classes."""

    def __init__(
        self,
        functions: dict[str, ast.FunctionDef],
        classes: dict[str, api.Class] | None,
        context: Sequence[str],
    ) -> None:
        self._functions = functions
        self._classes = classes
        self._context = list(context)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        # Recursively visit all nodes under this class, with the given
        # class name pushed onto a new context.
        if self._classes is not None:
            name = ".".join(self._context + [node.name])
            is_dataclass = any(
                (isinstance(dec, ast.Name) and dec.id == "dataclass")
                or (isinstance(dec, ast.Attribute) and dec.attr == "dataclass")
                for dec in node.decorator_list
            )
            fields: list[api.Field] = []
            for stmt in node.body:
                if isinstance(stmt, ast.AnnAssign) and isinstance(
                    stmt.target, ast.Name
                ):
                    field_name = stmt.target.id
                    if field_name.startswith("_"):
                        continue
                    required = stmt.value is None
                    init = True
                    # Support dataclasses.field(...)
                    if isinstance(stmt.value, ast.Call):
                        fn = stmt.value.func

                        def _is_field_func(f: ast.AST) -> bool:
                            return (isinstance(f, ast.Name) and f.id == "field") or (
                                isinstance(f, ast.Attribute) and f.attr == "field"
                            )

                        if _is_field_func(fn):
                            # default/default_factory imply not required
                            has_default = any(
                                isinstance(kw, ast.keyword)
                                and kw.arg == "default"
                                and kw.value is not None
                                for kw in stmt.value.keywords
                            )
                            has_default_factory = any(
                                isinstance(kw, ast.keyword)
                                and kw.arg == "default_factory"
                                and kw.value is not None
                                for kw in stmt.value.keywords
                            )
                            required = not (has_default or has_default_factory)
                            # init flag
                            for kw in stmt.value.keywords:
                                if isinstance(kw, ast.keyword) and kw.arg == "init":
                                    init = not (
                                        isinstance(kw.value, ast.Constant)
                                        and kw.value.value is False
                                    )
                                    break
                    fields.append(
                        api.Field(
                            name=field_name,
                            required=required,
                            line=stmt.lineno,
                            type_annotation=api.types.annotation_to_dataclass(
                                stmt.annotation
                            ),
                            init=init,
                        )
                    )
                elif isinstance(stmt, ast.Assign):
                    for target in stmt.targets:
                        if isinstance(target, ast.Name):
                            field_name = target.id
                            if field_name.startswith("_"):
                                continue
                            fields.append(
                                api.Field(
                                    name=field_name,
                                    required=False,
                                    line=stmt.lineno,
                                    type_annotation=None,
                                    init=True,
                                )
                            )
            self._classes[name] = api.Class(
                fields=fields, line=node.lineno, dataclass=is_dataclass
            )

        _ContextualNodeVisitor(
            self._functions, self._classes, self._context + [node.name]
        ).generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        # Records this function.
        name = ".".join(self._context + [node.name])
        self._functions[name] = node
