"""The texts embedded for each pytorch test file: skeleton pieces and test functions."""

import ast
import glob
import os
import re
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Literal, Optional, Union


SKELETON_CHARS = 1000
FUNCTION_CHARS = 4000

_IMPORT_LINE = re.compile(r"^\s*(import |from \S+ import )")
_CLASS_LINE = re.compile(r"^(\s*)class (\w+)")
_TEST_DEF_LINE = re.compile(r"^(\s*)(?:async\s+)?def (test\w*)")
# The parser's own line split: only \r\n, \r and \n end a line, never \f or \v.
_SOURCE_LINE = re.compile(r"[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+\Z")

_FunctionNode = Union[ast.FunctionDef, ast.AsyncFunctionDef]


@dataclass(frozen=True)
class Unit:
    test: str
    kind: Literal["skeleton", "function"]
    text: str


def discover(test_dir: Path) -> list[str]:
    """TD test names of every test/**/test_*.py file, as pytorch's discover_tests."""
    paths = glob.glob("**/test_*.py", root_dir=test_dir, recursive=True)
    return sorted(
        Path(p).as_posix()[: -len(".py")]
        for p in paths
        if os.path.isfile(os.path.join(test_dir, p))
    )


def _header(test: str) -> str:
    return f"# test/{test}.py"


def _pieces(header: str, lines: list[str]) -> list[str]:
    """Split lines into texts of at most SKELETON_CHARS, each led by header."""
    budget = max(SKELETON_CHARS - len(header) - 1, 1)
    pieces: list[list[str]] = []
    current: list[str] = []
    size = 0
    for line in lines:
        line = line[:budget]
        added = len(line) + 1 if current else len(line)
        if current and size + added > budget:
            pieces.append(current)
            current, size, added = [], 0, len(line)
        current.append(line)
        size += added
    if current or not pieces:
        pieces.append(current)
    return ["\n".join([header, *piece]) for piece in pieces]


def _walk(
    node: ast.AST, classes: tuple[str, ...] = ()
) -> Iterator[tuple[ast.AST, tuple[str, ...]]]:
    """Yield imports, classes and test defs in source order with their enclosing
    classes, descending into compound statements but never into function bodies."""
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.Import, ast.ImportFrom)):
            yield child, classes
        elif isinstance(child, ast.ClassDef):
            yield child, classes
            yield from _walk(child, (*classes, child.name))
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if child.name.startswith("test"):
                yield child, classes
        elif isinstance(child, (ast.stmt, ast.excepthandler)):
            yield from _walk(child, classes)


def _segment(lines: list[str], node: _FunctionNode) -> str:
    """ast.get_source_segment over pre-split lines (column offsets are UTF-8 bytes)."""
    assert node.end_lineno is not None and node.end_col_offset is not None
    first = lines[node.lineno - 1].encode()
    if node.end_lineno == node.lineno:
        return first[node.col_offset : node.end_col_offset].decode()
    last = lines[node.end_lineno - 1].encode()[: node.end_col_offset].decode()
    middle = "".join(lines[node.lineno : node.end_lineno - 1])
    return first[node.col_offset :].decode() + middle + last


def _parse(source: str) -> Optional[ast.Module]:
    with warnings.catch_warnings():
        # Invalid escape sequences in test files warn on every parse.
        warnings.simplefilter("ignore", SyntaxWarning)
        warnings.simplefilter("ignore", DeprecationWarning)
        try:
            return ast.parse(source)
        except (SyntaxError, ValueError, RecursionError):
            # Not parseable by this Python: the caller falls back to a regex.
            return None


def _regex_skeleton(source: str) -> list[str]:
    lines = []
    for line in source.splitlines():
        if _IMPORT_LINE.match(line):
            lines.append(line.strip())
        elif match := _CLASS_LINE.match(line):
            lines.append(("  " if match.group(1) else "") + f"class {match.group(2)}")
        elif match := _TEST_DEF_LINE.match(line):
            lines.append(("  " if match.group(1) else "") + f"def {match.group(2)}")
    return lines


def units_for_source(test: str, source: str, with_functions: bool) -> list[Unit]:
    header = _header(test)
    tree = _parse(source)
    if tree is None:
        return [
            Unit(test, "skeleton", text)
            for text in _pieces(header, _regex_skeleton(source))
        ]
    skeleton: list[str] = []
    functions: list[Unit] = []
    lines = _SOURCE_LINE.findall(source) if with_functions else []
    for node, classes in _walk(tree):
        indent = "  " * len(classes)
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if not classes:
                skeleton.append(ast.unparse(node))
        elif isinstance(node, ast.ClassDef):
            skeleton.append(f"{indent}class {node.name}")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            skeleton.append(f"{indent}def {node.name}")
            if with_functions:
                where = f" class {classes[-1]}" if classes else ""
                text = f"{header}{where}\n{_segment(lines, node)}"
                functions.append(Unit(test, "function", text[:FUNCTION_CHARS]))
    units = [Unit(test, "skeleton", text) for text in _pieces(header, skeleton)]
    return units + functions


def build(test_dir: Path, with_functions: bool) -> list[Unit]:
    units: list[Unit] = []
    for test in discover(test_dir):
        source = (Path(test_dir) / f"{test}.py").read_text(
            encoding="utf-8", errors="replace"
        )
        units.extend(units_for_source(test, source, with_functions))
    return units
