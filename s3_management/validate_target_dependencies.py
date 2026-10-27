#!/usr/bin/env python3
"""
Check that the dependencies of built wheels resolve from a download.pytorch.org
index target, before the wheels are uploaded to it.

Users install with `pip install --index-url https://download.pytorch.org/whl/<target>`,
so every dependency of torch must be reachable through that one index. A target
created with update_dependencies.py only mirrors the packages listed in
PACKAGES_PER_PROJECT, and some of them (nvidia-*, cuda-*) are keyed to specific
targets, so a new target can be missing dependencies without anything failing until
the first user installs from it.

For each wheel this resolves `<name>==<version>` against only the target's index,
supplying the local wheel through --find-links, for the Python version and
platform in the wheel's own tags. The wheel's real Requires-Dist (including the
CUDA or ROCm pins) is used, so nothing has to be uploaded first. Nothing is
installed; `uv pip compile` only resolves.

Examples:

    # Wheels built but not yet uploaded, target already created under whl/test:
    python3 s3_management/validate_target_dependencies.py \\
        --prefix whl/test --target cu134 --wheel-dir ./wheelhouse

    # Any index URL:
    python3 s3_management/validate_target_dependencies.py \\
        --index-url https://download.pytorch.org/whl/test/rocm10.0 --wheel torch-*.whl

Put every wheel that depends on another in the same directory: torchvision pins
torch==<version>+<target>, which has to come from --wheel-dir, not the index.
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


DEFAULT_BASE_URL = "https://download.pytorch.org"


@dataclass(frozen=True)
class Wheel:
    path: Path
    name: str
    version: str
    python_tag: str
    abi_tag: str
    platform_tag: str


def parse_wheel(path: Path) -> Wheel:
    """Split <name>-<version>[-<build>]-<python>-<abi>-<platform>.whl."""
    if path.suffix != ".whl":
        raise ValueError(f"not a wheel: {path}")
    parts = path.stem.split("-")
    if len(parts) not in (5, 6):
        raise ValueError(f"cannot parse wheel filename: {path.name}")
    return Wheel(
        path=path,
        name=parts[0],
        version=parts[1],
        python_tag=parts[-3],
        abi_tag=parts[-2],
        platform_tag=parts[-1],
    )


def python_version(wheel: Wheel) -> Optional[str]:
    """cp312 -> 3.12. None for tags that do not name one interpreter (py3, abi3)."""
    m = re.fullmatch(r"cp(\d)(\d+)", wheel.python_tag)
    return f"{m.group(1)}.{m.group(2)}" if m else None


def uv_platforms(platform_tag: str) -> List[str]:
    """
    Map a wheel platform tag to `uv --python-platform` values. A compressed tag such
    as manylinux_2_27_x86_64.manylinux_2_28_x86_64 is one wheel built for both, and
    the oldest glibc is the strictest environment to resolve for, so use that one.
    """
    glibc_by_alias = {
        "manylinux1": (2, 5),
        "manylinux2010": (2, 12),
        "manylinux2014": (2, 17),
    }
    platforms = []
    linux = []
    for tag in platform_tag.split("."):
        m = re.fullmatch(r"manylinux_(\d+)_(\d+)_(x86_64|aarch64)", tag)
        if m:
            linux.append(((int(m.group(1)), int(m.group(2))), m.group(3)))
            continue
        m = re.fullmatch(
            r"(manylinux1|manylinux2010|manylinux2014)_(x86_64|aarch64)", tag
        )
        if m:
            linux.append((glibc_by_alias[m.group(1)], m.group(2)))
            continue
        if tag == "linux_x86_64":
            platforms.append("x86_64-unknown-linux-gnu")
        elif tag == "linux_aarch64":
            platforms.append("aarch64-unknown-linux-gnu")
        elif tag == "win_amd64":
            platforms.append("x86_64-pc-windows-msvc")
        elif tag == "win_arm64":
            platforms.append("aarch64-pc-windows-msvc")
        elif re.fullmatch(r"macosx_\d+_\d+_arm64", tag):
            platforms.append("aarch64-apple-darwin")
        elif re.fullmatch(r"macosx_\d+_\d+_x86_64", tag):
            platforms.append("x86_64-apple-darwin")
    for arch in ("x86_64", "aarch64"):
        versions = [v for v, a in linux if a == arch]
        if versions:
            major, minor = min(versions)
            platforms.append(f"{arch}-manylinux_{major}_{minor}")
    return platforms


def index_url(args: argparse.Namespace) -> str:
    if args.index_url:
        return args.index_url.rstrip("/")
    return f"{args.base_url.rstrip('/')}/{args.prefix.strip('/')}/{args.target}"


def index_package_count(url: str) -> int:
    """Number of project links on the target's index page; raises if it is absent."""
    with urlopen(f"{url}/", timeout=60) as response:
        html = response.read().decode("utf-8", "replace")
    return len(re.findall(r"<a\s", html))


def resolve(
    uv: str,
    wheel: Wheel,
    url: str,
    find_links: Path,
    py: str,
    platform: str,
    refresh: bool,
    prerelease: str,
    allow_sdist: bool,
) -> "tuple[bool, str]":
    with tempfile.TemporaryDirectory() as tmp:
        requirements = Path(tmp) / "requirements.in"
        requirements.write_text(f"{wheel.name}=={wheel.version}\n")
        output = Path(tmp) / "resolved.txt"
        cmd = [
            uv,
            "pip",
            "compile",
            str(requirements),
            "--index-url",
            url,
            "--find-links",
            str(find_links),
            "--python-version",
            py,
            "--python-platform",
            platform,
            "--prerelease",
            prerelease,
            "--no-header",
            "--no-annotate",
            "--output-file",
            str(output),
        ]
        if not allow_sdist:
            cmd += ["--only-binary", ":all:"]
        if refresh:
            cmd.append("--refresh")
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout).strip()
            if "no usable wheels" in detail and not allow_sdist:
                detail += (
                    "\nhint: a dependency has no wheel on this index. If it ships an sdist "
                    "(the `rocm` meta package does), pip builds it at install time; rerun "
                    "with --allow-sdist to resolve it the same way. That makes uv run the "
                    "package's build backend."
                )
            return False, detail
        pins = [
            line
            for line in output.read_text().splitlines()
            if line and not line.startswith("#")
        ]
        return True, f"{len(pins)} packages resolved"


def collect_wheels(wheel_args: Sequence[str], wheel_dirs: Sequence[str]) -> List[Wheel]:
    paths = [Path(p) for p in wheel_args]
    for directory in wheel_dirs:
        paths.extend(sorted(Path(directory).glob("*.whl")))
    return [parse_wheel(p) for p in paths]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check that built wheels' dependencies resolve from an index target "
        "before upload.",
        epilog=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--index-url", help="Full index URL of the target to check")
    parser.add_argument(
        "--prefix", default="whl/test", help="e.g. whl/test, whl/nightly"
    )
    parser.add_argument("--target", help="e.g. cu134, rocm10.0")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument(
        "--wheel", action="append", default=[], help="A wheel; repeatable"
    )
    parser.add_argument(
        "--wheel-dir", action="append", default=[], help="Directory of wheels"
    )
    parser.add_argument(
        "--python-version",
        action="append",
        default=[],
        help="Python version(s) to resolve for instead of the one in the wheel tag "
        "(required for py3/abi3 wheels), e.g. 3.12",
    )
    parser.add_argument(
        "--prerelease",
        default="allow",
        choices=[
            "allow",
            "disallow",
            "if-necessary",
            "explicit",
            "if-necessary-or-explicit",
        ],
        help="uv's pre-release policy. Default 'allow', which is what pip can resolve: pip "
        "uses a pre-release when no final release satisfies a specifier (e.g. rocm==10.0.* "
        "with only 10.0.0rc builds), where uv's own default rejects it.",
    )
    parser.add_argument(
        "--allow-sdist",
        action="store_true",
        help="Resolve dependencies that only ship an sdist (pip builds those at install "
        "time; the ROCm `rocm` meta package is one). Off by default because uv has to run "
        "the package's build backend to read its metadata.",
    )
    parser.add_argument("--uv", default=shutil.which("uv") or "uv", help="Path to uv")
    parser.add_argument(
        "--refresh", action="store_true", help="Ignore uv's cached index data"
    )
    args = parser.parse_args()

    if not args.index_url and not args.target:
        parser.error("pass --index-url, or --target (with --prefix)")
    if not args.wheel and not args.wheel_dir:
        parser.error("pass at least one --wheel or --wheel-dir")
    if shutil.which(args.uv) is None:
        print(f"ERROR: uv not found ({args.uv}); install it with `pip install uv`")
        return 2

    url = index_url(args)
    try:
        wheels = collect_wheels(args.wheel, args.wheel_dir)
    except ValueError as e:
        print(f"ERROR: {e}")
        return 2
    if not wheels:
        print("ERROR: no wheels found")
        return 2

    try:
        count = index_package_count(url)
    except (HTTPError, URLError) as e:
        print(f"ERROR: index {url}/ is not reachable ({e}); create the target first")
        return 2
    print(f"Index {url}/ lists {count} projects\n")

    # --find-links takes a directory; stage the wheels so mixed inputs share one.
    failures = 0
    skipped = 0
    with tempfile.TemporaryDirectory() as staging:
        for wheel in wheels:
            link = Path(staging) / wheel.path.name
            try:
                link.symlink_to(wheel.path.resolve())
            except OSError:
                shutil.copy(wheel.path, link)
        for wheel in wheels:
            versions = args.python_version or [python_version(wheel)]
            platforms = uv_platforms(wheel.platform_tag)
            label = f"{wheel.name}=={wheel.version} ({wheel.python_tag}-{wheel.platform_tag})"
            if None in versions or not platforms or wheel.abi_tag.endswith("t"):
                reason = (
                    "free-threaded abi is not supported by uv --python-platform"
                    if wheel.abi_tag.endswith("t")
                    else "cannot derive python version or platform; pass --python-version"
                )
                print(f"SKIP  {label}: {reason}")
                skipped += 1
                continue
            for py in versions:
                for platform in platforms:
                    ok, detail = resolve(
                        args.uv,
                        wheel,
                        url,
                        Path(staging),
                        py,
                        platform,
                        args.refresh,
                        args.prerelease,
                        args.allow_sdist,
                    )
                    print(f"{'OK   ' if ok else 'FAIL '} {label} py{py} {platform}")
                    if not ok:
                        failures += 1
                        print(
                            "\n".join(
                                f"      {line}" for line in detail.splitlines()[-12:]
                            )
                        )
    print(
        f"\n{'FAILED' if failures else 'PASSED'}: {failures} failing environment(s), "
        f"{skipped} wheel(s) skipped"
    )
    return 1 if failures or skipped else 0


if __name__ == "__main__":
    sys.exit(main())
