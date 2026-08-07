#!/usr/bin/env python3
"""Update the `crcr:` tag in a ci-infra `crcr/Terrafile`.

Rewrites only the `tag:` line inside the `crcr:` block, leaving the
`terraform-aws-vpc` block (and anything else) untouched.

Usage:
    update_crcr_terrafile.py <Terrafile> <new_tag>
"""
import re
import sys


def update(path: str, new_tag: str) -> bool:
    with open(path) as f:
        text = f.read()

    # Match the crcr: block and its quoted tag: line. The block is anchored at
    # the start of a line ("crcr:") and consists of the following indented
    # lines. Only the tag: line inside it is rewritten.
    pattern = re.compile(
        r'(?P<block>^crcr:\n(?:[ \t].*\n)*?)(?P<indent>[ \t]+)tag:[ \t]*"[^"]*"\n',
        re.MULTILINE,
    )

    def repl(m: re.Match) -> str:
        return f"{m.group('block')}{m.group('indent')}tag: \"{new_tag}\"\n"

    new_text, n = pattern.subn(repl, text, count=1)
    if n == 0:
        print(f"ERROR: could not find a `crcr:` block with a quoted `tag:` line in {path}", file=sys.stderr)
        return False

    with open(path, "w") as f:
        f.write(new_text)
    return True


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: update_crcr_terrafile.py <Terrafile> <new_tag>", file=sys.stderr)
        return 2
    return 0 if update(sys.argv[1], sys.argv[2]) else 1


if __name__ == "__main__":
    sys.exit(main())
