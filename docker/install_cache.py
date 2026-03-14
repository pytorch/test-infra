#!/usr/bin/env python3
"""Install sccache from prebuilt GitHub release binaries.

Adapted from PyTorch CI: .ci/docker/common/install_cache.sh
"""

# /// script
# requires-python = ">=3.9"
# ///

import argparse
import os
import platform
import subprocess
import sys


INSTALL_DIR = "/opt/cache/bin"


def detect_arch() -> str:
    """Return 'x86_64' or 'aarch64'."""
    target = os.environ.get("TARGETARCH", platform.machine())
    if target in ("amd64", "x86_64"):
        return "x86_64"
    if target in ("arm64", "aarch64"):
        return "aarch64"
    print(f"Unsupported architecture: {target}", file=sys.stderr)
    sys.exit(1)


def run(*cmd: str, **kwargs) -> None:
    print(f"+ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True, **kwargs)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sccache-version",
        default=os.environ.get("SCCACHE_VERSION", "v0.13.0"),
        help="sccache release tag (default: v0.13.0 or $SCCACHE_VERSION)",
    )
    args = parser.parse_args()

    arch = detect_arch()
    version = args.sccache_version

    tarball = f"sccache-{version}-{arch}-unknown-linux-musl.tar.gz"
    url = f"https://github.com/mozilla/sccache/releases/download/{version}/{tarball}"

    os.makedirs(INSTALL_DIR, exist_ok=True)

    # Download and extract in one pipeline, same as the bash version
    run(
        "bash", "-c",
        f'curl -fsSL "{url}" | tar xz --strip-components=1 -C {INSTALL_DIR}',
    )
    os.chmod(f"{INSTALL_DIR}/sccache", 0o755)

    print(f"sccache {version} ({arch}) installed to {INSTALL_DIR}", flush=True)


if __name__ == "__main__":
    main()
