#!/usr/bin/env python3
"""Report the versions and sizes of the binaries a validation run installed.

Emits a small markdown table that validate_binaries.sh prints to the job log and
appends to the job summary. Values are read from the installed packages rather
than from the build matrix, so a mismatch between what was requested and what
pip resolved is visible in the report.

Two sizes are reported because they answer different questions:

* wheel     -- the compressed download size, i.e. what a user pulls from the
               index. Only pip knows it, so the caller passes it in; it is
               absent on the uv/wheel-variants path and when the wheel was
               already satisfied.
* installed -- unpacked bytes on disk, measured here from the installed
               package, so it is available on every install path and every OS.

Nothing in here may fail the validation job: every lookup that depends on how
torch was built (CUDA, cuDNN, NCCL) degrades to "-" instead of raising.

Note on imports: this is deliberately a script file rather than a heredoc piped
to python. For a script, sys.path[0] is the script's own directory, so `import
torch` cannot pick up the pytorch source checkout the validation runs from --
which a `python -` heredoc would, since that puts the cwd on sys.path.

Usage:
  build_report.py --target-os linux --python-version 3.12 \
      --gpu-arch-type cuda --gpu-arch-version 12.8 \
      --torch-wheel-mb 812.4 --torchvision-wheel-mb 8.1
"""

from __future__ import annotations

import argparse
import os
from types import ModuleType


def installed_size_mb(module: ModuleType) -> str:
    """Total size of a package directory on disk, formatted as MB.

    Files that vanish or cannot be stat'd mid-walk are skipped rather than
    aborting the report.
    """
    path = getattr(module, "__file__", None)
    if not path:
        return "-"

    total = 0
    for dirpath, _, filenames in os.walk(os.path.dirname(path)):
        for filename in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, filename))
            except OSError:
                continue
    return f"{total / 1024 / 1024:.1f} MB"


def format_mb(value: str) -> str:
    """Render a caller-supplied megabyte figure, or "-" when it is unknown."""
    return f"{value} MB" if value else "-"


def cudnn_version(torch: ModuleType) -> str:
    """Decode torch's packed cuDNN version integer, e.g. 91002 -> 9.10.2."""
    try:
        packed = torch.backends.cudnn.version()
    except Exception:
        return "-"
    if not packed:
        return "-"
    return f"{packed // 10000}.{packed % 10000 // 100}.{packed % 100}"


def nccl_version(torch: ModuleType) -> str:
    """Format torch's NCCL version tuple, e.g. (2, 30, 7) -> 2.30.7."""
    try:
        return ".".join(str(part) for part in torch.cuda.nccl.version())
    except Exception:
        return "-"


def collect_rows(args: argparse.Namespace) -> list[tuple[str, str]]:
    arch = args.gpu_arch_type
    if args.gpu_arch_version:
        arch = f"{arch} {args.gpu_arch_version}"
    rows = [("build", f"{args.target_os} / py{args.python_version} / {arch}")]

    try:
        import torch
    except Exception as exc:
        rows.append(("torch", f"import failed: {exc}"))
    else:
        rows.extend(
            [
                ("torch", torch.__version__),
                ("torch wheel", format_mb(args.torch_wheel_mb)),
                ("torch installed", installed_size_mb(torch)),
                ("CUDA", torch.version.cuda or "-"),
                ("cuDNN", cudnn_version(torch)),
                ("NCCL", nccl_version(torch)),
            ]
        )

    try:
        import torchvision
    except Exception:
        rows.append(("torchvision", "-"))
    else:
        rows.extend(
            [
                ("torchvision", torchvision.__version__),
                ("torchvision wheel", format_mb(args.torchvision_wheel_mb)),
                ("torchvision installed", installed_size_mb(torchvision)),
            ]
        )

    return rows


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-os", default="?")
    parser.add_argument("--python-version", default="?")
    parser.add_argument("--gpu-arch-type", default="cpu")
    parser.add_argument("--gpu-arch-version", default="")
    parser.add_argument(
        "--torch-wheel-mb",
        default="",
        help="Compressed torch wheel size in MB, as read from pip's output",
    )
    parser.add_argument(
        "--torchvision-wheel-mb",
        default="",
        help="Compressed torchvision wheel size in MB, as read from pip's output",
    )
    return parser.parse_args()


def main() -> None:
    rows = collect_rows(parse_args())
    print("| field | value |")
    print("| --- | --- |")
    for field, value in rows:
        print(f"| {field} | {value} |")


if __name__ == "__main__":
    main()
