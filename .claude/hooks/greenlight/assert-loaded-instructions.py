#!/usr/bin/env python3
"""Fail-closed detector: assert no instruction file loaded from the untrusted checkout.

Claude Code's ``InstructionsLoaded`` hook appends one JSON object per loaded memory file
(``CLAUDE.md`` / ``.claude/rules``) to a manifest (JSONL); a ``SessionStart`` hook writes a
sentinel. After the model has run, this script asserts that no loaded instruction file resolves
under any ``--untrusted-root`` (the reviewed ``pytorch`` checkout). A missing sentinel means the
hook subsystem never ran, which is itself a failure -- that distinguishes a genuinely clean run
(zero project memory) from one where the observation machinery silently misfired.

Deny-root, not allow-root: a checked-out file can only ever load as ``Project`` or ``Local``
memory, and both of those resolve UNDER the checkout root; ``User``/``Managed`` memory is
location-fixed outside it. A loaded ``file_path`` is a violation when it lands under an
``--untrusted-root`` by EITHER its ``os.path.realpath`` (symlink-resolved) OR its lexical
``os.path.normpath(os.path.abspath(...))``. The union is required because the two forms catch
OPPOSITE symlink directions: realpath catches a link from OUTSIDE the checkout that resolves back
INTO it (canonical location inside), while the lexical path catches a link INSIDE the checkout
that escapes OUT (declared path inside, but realpath outside) -- a realpath-only check silently
misses that second case. Either form is drift-proof: it never reads the ``memory_type`` field (so
it cannot fail open on a schema/enum change), and it does not false-positive on trusted in-repo
``CLAUDE.md`` files that live outside the checkout (e.g. ``greenlight/CLAUDE.md``,
``torchci/CLAUDE.md``). Verified against Claude Code CLI 2.1.169 / Agent SDK 0.3.169
(``InstructionsLoaded`` fires with an absolute ``file_path``); re-verify on any
claude-code-action / CLI bump.

Runs standalone under the CI system Python (invoked as ``python3 .../assert-loaded-instructions.py``
with ``if: always()`` before any verdict handoff), so it depends only on the standard library and
fails closed: any unexpected error propagates to a non-zero exit, blocking the review.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="assert-loaded-instructions",
        description=(
            "Fail closed if any instruction file loaded during the review resolves under an "
            "--untrusted-root directory (the reviewed checkout)."
        ),
    )
    parser.add_argument(
        "--manifest",
        required=True,
        help="path to the InstructionsLoaded JSONL manifest",
    )
    parser.add_argument("--sentinel", required=True, help="path to the SessionStart sentinel file")
    parser.add_argument(
        "--untrusted-root",
        dest="untrusted_roots",
        action="append",
        required=True,
        metavar="ABS_DIR",
        help="untrusted checkout tree that no instruction file may load from (repeatable; at least one)",
    )
    return parser


def _canonical_roots(untrusted_roots: Sequence[str]) -> list[str]:
    # Symlink-resolved form, compared against each loaded file's realpath: catches a link from
    # OUTSIDE the checkout that resolves back INTO it. Canonicalizing the root too keeps a
    # symlinked root from slipping past the realpath comparison.
    return [os.path.realpath(root) for root in untrusted_roots]


def _lexical_roots(untrusted_roots: Sequence[str]) -> list[str]:
    # Purely lexical form, compared against each loaded file's lexical path: catches a link INSIDE
    # the checkout that escapes OUT (its realpath leaves the root, but its declared path stays in).
    # Root and file are both taken lexically here so they share the same un-resolved prefix.
    return [os.path.normpath(os.path.abspath(root)) for root in untrusted_roots]


def _is_under_untrusted_root(candidate: str, roots: Sequence[str]) -> bool:
    # Match the root itself or any descendant. The ``+ os.sep`` guard keeps a sibling such as
    # ``/ws/pytorch-evil`` from satisfying untrusted-root ``/ws/pytorch``; it guards both the
    # realpath and the lexical-normpath comparison.
    return any(candidate == root or candidate.startswith(root + os.sep) for root in roots)


def _collect_violations(
    manifest_path: str,
    canonical_roots: Sequence[str],
    lexical_roots: Sequence[str],
) -> list[str]:
    violations: list[str] = []
    with open(manifest_path, encoding="utf-8") as handle:
        for lineno, raw in enumerate(handle, start=1):
            line = raw.strip()
            if not line:
                continue  # tolerate blank/trailing lines
            try:
                entry = json.loads(line)
            except json.JSONDecodeError as exc:
                # Fail closed: an unparseable manifest line could be a tampered or truncated record,
                # so it is a violation rather than something to skip.
                violations.append(f"malformed manifest line {lineno}: {line!r} ({exc})")
                continue
            if not isinstance(entry, dict):
                violations.append(f"malformed manifest line {lineno}: not a JSON object: {line!r}")
                continue
            file_path = entry.get("file_path")
            if not isinstance(file_path, str) or not file_path:
                violations.append(f"manifest line {lineno}: entry has no non-empty string 'file_path': {line!r}")
                continue
            real_path = os.path.realpath(file_path)
            lexical_path = os.path.normpath(os.path.abspath(file_path))
            # Report the form that actually lands under a root, so the logged violation is always a
            # path under the untrusted checkout (realpath for outside->in, lexical for in->out).
            if _is_under_untrusted_root(real_path, canonical_roots):
                violations.append(real_path)
            elif _is_under_untrusted_root(lexical_path, lexical_roots):
                violations.append(lexical_path)
    return violations


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    if not os.path.exists(args.sentinel):
        print(
            f"ERROR: sentinel {args.sentinel!r} is missing; the hook subsystem did not run.",
            file=sys.stderr,
        )
        return 1

    # Sentinel present + no manifest content = a correct run that loaded zero project/local memory.
    if not os.path.exists(args.manifest) or os.path.getsize(args.manifest) == 0:
        print(f"OK: sentinel present; manifest {args.manifest!r} empty/absent, no project memory loaded.")
        return 0

    canonical_roots = _canonical_roots(args.untrusted_roots)
    lexical_roots = _lexical_roots(args.untrusted_roots)
    violations = _collect_violations(args.manifest, canonical_roots, lexical_roots)

    if violations:
        print(
            "ERROR: instruction files loaded from the untrusted checkout during review:",
            file=sys.stderr,
        )
        for item in violations:
            print(f"  {item}", file=sys.stderr)
        return 1

    joined = ", ".join(args.untrusted_roots)
    print(f"OK: sentinel present; no loaded instructions resolve under untrusted-root(s): {joined}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
