#!/usr/bin/env python3
"""Download, extract, and validate a libtorch binary package.

Validation loads the shipped c10 library with ctypes to confirm it is a
working binary for the runner's platform and architecture. Loading a
wrong-architecture library fails, so this catches a libtorch package being
overwritten by a different-arch build on upload (see pytorch/pytorch#187812,
where the Windows x86_64 package shipped Aarch64 binaries under the x64
download URL).

Usage: validate_libtorch.py <download-url>
"""

from __future__ import annotations

import argparse
import ctypes
import glob
import os
import shutil
import sys
import urllib.request
import zipfile


def find_c10_lib() -> str | None:
    for pattern in ("c10.dll", "libc10.so", "libc10.dylib"):
        matches = glob.glob(os.path.join("libtorch", "lib", pattern))
        if matches:
            return matches[0]
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "url",
        nargs="?",
        default=os.environ.get("MATRIX_INSTALLATION", ""),
        help="libtorch package download URL",
    )
    args = parser.parse_args()
    if not args.url:
        sys.exit("ERROR: libtorch download URL not provided")

    print(f"Downloading {args.url}")
    # Set an explicit User-Agent: the R2-backed CDN behind download.pytorch.org
    # returns 403 for the default "Python-urllib/x.y" agent.
    request = urllib.request.Request(
        args.url, headers={"User-Agent": "libtorch-validation"}
    )
    with urllib.request.urlopen(request) as response, open("libtorch.zip", "wb") as out:
        shutil.copyfileobj(response, out)
    with zipfile.ZipFile("libtorch.zip") as zf:
        zf.extractall(".")

    lib = find_c10_lib()
    if lib is None:
        sys.exit("ERROR: c10 library not found under libtorch/lib")

    # On Windows c10 resolves its sibling DLLs from the package lib directory.
    lib_dir = os.path.abspath(os.path.dirname(lib))
    if sys.platform == "win32" and hasattr(os, "add_dll_directory"):
        os.add_dll_directory(lib_dir)

    print(f"Loading {lib} to validate it is a working binary for this runner")
    ctypes.CDLL(lib)
    print(f"Successfully loaded {lib}")


if __name__ == "__main__":
    main()
