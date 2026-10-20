#!/usr/bin/env python3
"""Exit 0 if a package is promoted to R2, 1 if it stays on S3 only.

Only the PyTorch Foundation packages (PT_FOUNDATION_PACKAGES in
s3_management/manage_v2.py) are mirrored to R2. The list is read from the
source without importing the module, which sets up S3 and R2 clients on import.

usage: is_r2_package.py PACKAGE
"""
import ast
import sys
from pathlib import Path

MANAGE_V2 = Path(__file__).resolve().parent.parent / "s3_management" / "manage_v2.py"


def foundation_packages() -> set:
    for node in ast.parse(MANAGE_V2.read_text()).body:
        if isinstance(node, ast.Assign) and any(
            getattr(target, "id", None) == "PT_FOUNDATION_PACKAGES"
            for target in node.targets
        ):
            return {ast.literal_eval(element) for element in node.value.elts}
    raise SystemExit(f"PT_FOUNDATION_PACKAGES not found in {MANAGE_V2}")


def main() -> int:
    name = sys.argv[1].lower().replace("-", "_")
    if name in foundation_packages():
        print(f"{name} is in PT_FOUNDATION_PACKAGES: promoted to R2")
        return 0
    print(f"{name} is not in PT_FOUNDATION_PACKAGES: not promoted to R2")
    return 1


if __name__ == "__main__":
    sys.exit(main())
