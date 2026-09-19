"""Line classification for the greenlight decision export.

Given one file's unified-diff patch, count its churn (added + removed lines) and
its *significant* churn -- the same lines with blanks, documentation files and
comments taken out. Pure: no network, no filesystem, no module state.

Comments are recognised from the line alone, by prefix, with no parser and no
file reconstruction. Which prefixes apply is decided **per extension** by
``COMMENT_PREFIXES_BY_EXTENSION``: ``//``, ``/*`` and ``*`` in the C family only,
the two triple-quote forms in Python only, and ``#`` in Python and the
hash-comment family only -- never in C, where it opens a preprocessor directive
that is code. An extension the table does not name strips nothing, since guessing
a comment syntax for an unknown language is how ``#include`` becomes prose. Those
unnamed extensions carry a fraction of a percent of changed lines, so the silence
costs far less than a wrong guess would.

**The error is size-bounded, and that shape is why there is no parser here.** A
small diff can be badly wrong in relative terms; a large one is accurate. Since
the column exists to compare pull request sizes, the cases where it is least
reliable are the ones where being wrong matters least, and that stays true as the
corpus grows.

The digits behind that claim are a dated sample, not an invariant: measured
2026-09-03 over the then-151-PR corpus, this ran 2.37% above a parser-exact
reference, exact on 113 PRs, median error zero, worst case 23% at 200 changed
lines and above and 6% at 500 and above. The corpus grows daily and the reference
implementation is not in this repository, so none of those figures can be
re-derived from here -- treat the size-boundedness as the claim and the numbers
as the day it was checked.
"""

from __future__ import annotations

import os
from typing import Callable, Iterator


DOC_PATH_PREFIX = "docs/"
# ``.txt`` is deliberately absent: pytorch carries 301 of them and only 4 are
# prose, the rest being CMakeLists.txt and pinned requirements.
DOC_EXTENSIONS = frozenset({".md", ".rst", ".markdown", ".adoc"})
DOC_BASENAMES = frozenset({"LICENSE", "NOTICE", "AUTHORS", "COPYING", "CHANGELOG"})

_HASH_PREFIXES = ("#",)
_SLASH_PREFIXES = ("//", "/*", "*")
_PYTHON_PREFIXES = _HASH_PREFIXES + ('"""', "'''")

_C_FAMILY_EXTENSIONS = frozenset(
    {
        ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx", ".cu", ".cuh",
        ".m", ".mm", ".metal", ".java", ".ts", ".tsx", ".js", ".jsx",
    }
)  # fmt: skip
_PYTHON_EXTENSIONS = frozenset({".py", ".pyi"})
_HASH_EXTENSIONS = frozenset(
    {
        ".sh", ".bash", ".yaml", ".yml", ".toml", ".txt", ".cmake",
        ".bzl", ".bazel", ".cfg", ".ini", ".pl", ".rb", ".j2",
    }
)  # fmt: skip

COMMENT_PREFIXES_BY_EXTENSION = {
    extension: prefixes
    for prefixes, extensions in (
        (_SLASH_PREFIXES, _C_FAMILY_EXTENSIONS),
        (_PYTHON_PREFIXES, _PYTHON_EXTENSIONS),
        (_HASH_PREFIXES, _HASH_EXTENSIONS),
    )
    for extension in extensions
}
COMMENT_PREFIXES_BY_BASENAME = dict.fromkeys(
    ("CMakeLists.txt", "Makefile", "Dockerfile"), _HASH_PREFIXES
)


def is_doc_path(path: str) -> bool:
    """Whether a repository path holds documentation rather than code."""
    if path.startswith(DOC_PATH_PREFIX):
        return True
    if os.path.basename(path) in DOC_BASENAMES:
        return True
    return os.path.splitext(path)[1].lower() in DOC_EXTENSIONS


def classify_patch(path: str, patch: str) -> tuple[int, int]:
    """Return (loc, sig_loc) for one file's unified-diff patch."""
    return classify_renamed_patch(patch, path, path)


def classify_renamed_patch(
    patch: str, added_path: str, removed_path: str
) -> tuple[int, int]:
    """Count churn and significant churn, judging each side against its own path.

    The paths differ on a rename: the removed lines belong to the old location,
    which may be documentation while the new one is code, or the reverse.
    """
    added_is_significant = _significance_test(added_path)
    removed_is_significant = (
        added_is_significant
        if removed_path == added_path
        else _significance_test(removed_path)
    )

    changed = list(_iter_changed_lines(patch))
    sig_loc = sum(
        1
        for is_addition, text in changed
        if (added_is_significant(text) if is_addition else removed_is_significant(text))
    )
    return len(changed), sig_loc


def _iter_changed_lines(patch: str) -> Iterator[tuple[bool, str]]:
    """Yield (is_addition, text) for each added or removed line of a unified diff.

    Hunk headers, context lines and the no-newline marker all fail the
    first-character test and drop out.
    """
    for line in patch.split("\n"):
        if not line:
            continue
        marker = line[0]
        if marker == "+":
            yield True, line[1:]
        elif marker == "-":
            yield False, line[1:]


def _comment_prefixes_for(path: str) -> tuple[str, ...]:
    basename = os.path.basename(path)
    if basename in COMMENT_PREFIXES_BY_BASENAME:
        return COMMENT_PREFIXES_BY_BASENAME[basename]
    return COMMENT_PREFIXES_BY_EXTENSION.get(os.path.splitext(path)[1].lower(), ())


def _significance_test(path: str) -> Callable[[str], bool]:
    """Build the per-line significance predicate for one path."""
    if is_doc_path(path):
        return lambda text: False

    prefixes = _comment_prefixes_for(path)
    if not prefixes:
        return lambda text: bool(text.strip())

    def is_significant(text: str) -> bool:
        stripped = text.strip()
        return bool(stripped) and not stripped.startswith(prefixes)

    return is_significant
