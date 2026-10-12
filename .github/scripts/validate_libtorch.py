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
import ssl
import sys
import urllib.request
import zipfile


def ssl_context() -> ssl.SSLContext | None:
    """Build a verifying context that does not read the Windows cert store.

    create_default_context() with no cafile falls through to
    load_default_certs(), which on Windows concatenates every cert in the
    system stores into one blob and hands it to OpenSSL in a single
    load_verify_locations() call. A single unparseable entry aborts the whole
    load with "[ASN1: NOT_ENOUGH_DATA]", and it happens before
    set_default_verify_paths(), so SSL_CERT_FILE alone cannot avoid it.
    Naming a cafile takes the load_verify_locations() branch instead.

    Returns None when no bundle is available, which keeps urlopen on its
    default behaviour rather than downgrading verification.
    """
    cafile = os.environ.get("SSL_CERT_FILE")
    if not cafile or not os.path.isfile(cafile):
        try:
            import certifi
        except ImportError:
            return None
        cafile = certifi.where()
    return ssl.create_default_context(cafile=cafile)


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
    with urllib.request.urlopen(request, context=ssl_context()) as response, open(
        "libtorch.zip", "wb"
    ) as out:
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
