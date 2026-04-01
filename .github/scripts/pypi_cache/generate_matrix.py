#!/usr/bin/env python3
"""Generate the build matrix for the PyPI wheel cache workflow."""

import argparse
import json
import re
import sys


ARCH_RUNNERS = {
    "x86_64": "mt-l-x86iavx512-46-85",
    "aarch64": "mt-l-arm64g3-61-463",
}

# major.minor with optional .patch
_CUDA_VERSION_RE = re.compile(r"^\d+\.\d+(\.\d+)?$")


def cuda_stub(version: str) -> str:
    """12.8.1 → cu128"""
    parts = version.split(".")
    return f"cu{parts[0]}{parts[1]}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cuda-versions",
        required=True,
        help="Space-separated full CUDA versions (e.g. '12.8.1 13.0.2')",
    )
    parser.add_argument(
        "--image-tag",
        default="latest",
        help="Container image tag (default: 'latest')",
    )
    args = parser.parse_args()

    include = []
    for cuda_ver in args.cuda_versions.split():
        if not _CUDA_VERSION_RE.match(cuda_ver):
            print(
                f"::error::Invalid CUDA version '{cuda_ver}'. "
                "Expected major.minor or major.minor.patch (e.g. '12.8' or '12.8.1').",
                file=sys.stderr,
            )
            sys.exit(1)
        parts = cuda_ver.split(".")
        major, minor = parts[0], parts[1]
        variant = cuda_stub(cuda_ver)
        for arch, runner in ARCH_RUNNERS.items():
            include.append(
                {
                    "variant": variant,
                    "arch": arch,
                    "runner": runner,
                    "image": f"ghcr.io/pytorch/test-infra:cuda-{arch}-{args.image_tag}",
                    "cuda_dir": f"/usr/local/cuda-{major}.{minor}",
                }
            )

    # CPU entries
    for arch, runner in ARCH_RUNNERS.items():
        include.append(
            {
                "variant": "cpu",
                "arch": arch,
                "runner": runner,
                "image": f"ghcr.io/pytorch/test-infra:cpu-{arch}-{args.image_tag}",
                "cuda_dir": "",
            }
        )

    print(json.dumps({"include": include}))


if __name__ == "__main__":
    main()
