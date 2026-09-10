"""Scrape a constant out of a TypeScript source file, for the gates that pin greenlight's mirrors.

Two renderers are written twice -- once in ``greenlight/src/greenlight/`` and once in
``torchci/lib/greenlight/`` -- and nothing at build time links a Python constant to the
TypeScript one beside it. The gates that hold them together read the TypeScript as text rather
than parsing it, so every literal they pin has to stay a ``const NAME = <literal>;`` declaration
in the file named, spelled as one literal. A restructure that moves one is a deliberate re-target
of the scrape; a scrape that silently starts matching less is a gate that has stopped guarding.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

RESTRUCTURED = "the TypeScript was restructured; re-target this test's regex at the new shape"

# Every escape a TypeScript string literal can carry. An unknown one raises rather than passing
# through, so a scrape cannot quietly compare a half-decoded value against Python and pass.
_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", "0": "\0", "\\": "\\", '"': '"', "'": "'", "`": "`"}


def read(ts_file: str) -> str:
    return (ROOT / ts_file).read_text()


def unescape(literal: str) -> str:
    out: list[str] = []
    index = 0
    while index < len(literal):
        char = literal[index]
        if char != "\\":
            out.append(char)
            index += 1
            continue
        marker = literal[index + 1]
        if marker == "u":
            out.append(chr(int(literal[index + 2 : index + 6], 16)))
            index += 6
            continue
        out.append(_ESCAPES[marker])
        index += 2
    return "".join(out)


def ts_string(ts_file: str, name: str) -> str:
    """The value of a single-line string constant, whichever quote it is spelled with.

    Both quotes, because prettier leaves a literal holding a double quote single-quoted, and one
    of the sentinels is exactly that.
    """
    pattern = rf"^(?:export )?const {re.escape(name)} =\s*([\"'])(.*?)\1;$"
    match = re.search(pattern, read(ts_file), re.MULTILINE)
    assert match is not None, f"no `const {name} = <string>;` in {ts_file}: {RESTRUCTURED}"
    return unescape(match.group(2))


def ts_number(ts_file: str, name: str) -> int:
    # `[0-9]` rather than `\d`, which in Python matches digits ClickHouse's RE2 and JavaScript
    # do not -- the same divergence the modules being pinned are written to avoid.
    pattern = rf"^(?:export )?const {re.escape(name)} =\s*([0-9]+);$"
    match = re.search(pattern, read(ts_file), re.MULTILINE)
    assert match is not None, f"no `const {name} = <number>;` in {ts_file}: {RESTRUCTURED}"
    return int(match.group(1))


def drift(ts_file: str, py_file: str, detail: str) -> str:
    return (
        f"{ts_file} drifted from {py_file}, which is the source of truth: "
        f"change the TypeScript to match it, or change both together. {detail}"
    )
