#!/usr/bin/env python3
"""Build PyPI wheels and upload to S3-backed wheel cache.

Builds every requested package/Python-version combination and uploads the
resulting wheels to an S3 bucket.  Wheels that already exist in S3 are
skipped.  Expected build failures are reported via GitHub Actions
``::warning::`` annotations; unexpected errors (S3, environment) abort
the script with a non-zero exit code.
"""

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Union


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BUILD_DIR = Path("/tmp/pypi-cache-build")
FAILURE_SUMMARY_PATH = Path("/tmp/pypi-cache-failure-summary.txt")

# ---------------------------------------------------------------------------
# Pure helpers (unit-testable, no I/O)
# ---------------------------------------------------------------------------


def python_path(ver: str) -> str:
    """Convert a version like '3.13' or '3.13t' to the manylinux interpreter path."""
    suffix = ""
    if ver.endswith("t"):
        suffix = "t"
        ver = ver[:-1]
    digits = ver.replace(".", "")
    return f"/opt/python/cp{digits}-cp{digits}{suffix}/bin/python"


def cp_tag(ver: str) -> str:
    """Convert '3.13' → 'cp313', '3.13t' → 'cp313t'."""
    suffix = ""
    if ver.endswith("t"):
        suffix = "t"
        ver = ver[:-1]
    digits = ver.replace(".", "")
    return f"cp{digits}{suffix}"


def normalize_name(name: str) -> str:
    """PEP 503 name normalisation: lowercase, collapse ``[-_.]+`` to ``_``."""
    return re.sub(r"[-_.]+", "_", name.lower())


def wheel_matches(
    norm_name: str,
    version: str,
    tag: str,
    arch: str,
    existing_names: list[str],
) -> bool:
    """Return True if a matching wheel already exists in *existing_names*.

    Checks three patterns (same precedence as the original bash):
      1. Native cpython wheel with a specific ABI tag.
      2. Pure-python wheel (``py3-none-any``).
      3. Platform-specific but python-version-independent wheel.
    """
    esc_name = re.escape(norm_name)
    esc_ver = re.escape(version)
    esc_arch = re.escape(arch)
    patterns = [
        re.compile(
            rf"^{esc_name}-{esc_ver}(-[^-]+)?-[^-]*-{tag}-.*manylinux.*{esc_arch}\.whl$",
            re.IGNORECASE,
        ),
        re.compile(
            rf"^{esc_name}-{esc_ver}-py[23][^-]*-none-any\.whl$",
            re.IGNORECASE,
        ),
        re.compile(
            rf"^{esc_name}-{esc_ver}-py[23][^-]*-none-.*manylinux.*{esc_arch}\.whl$",
            re.IGNORECASE,
        ),
    ]
    for name in existing_names:
        for pat in patterns:
            if pat.match(name):
                return True
    return False


def load_skip_list(skip_file: Path) -> set[str]:
    """Parse *skip_python_versions.txt* into ``{'norm==ver:pyver', ...}``."""
    result: set[str] = set()
    if not skip_file.is_file():
        return result
    for line in skip_file.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2 or "==" not in parts[0]:
            continue
        pkg_spec = parts[0]
        name, ver = pkg_spec.split("==", 1)
        norm = normalize_name(name)
        for pyver in parts[1:]:
            result.add(f"{norm}=={ver}:{pyver}")
    return result


def write_failure_summary(failures: list[tuple[str, str]], path: Path) -> None:
    """Write a formatted failure summary grouped by package."""
    if not failures:
        path.write_text("")
        return
    grouped: dict[str, list[str]] = {}
    for entry, pyver in sorted(failures):
        grouped.setdefault(entry, []).append(pyver)
    lines: list[str] = []
    first = True
    for pkg, versions in grouped.items():
        if not first:
            lines.append("")
        first = False
        lines.append(f"{pkg}:")
        for v in versions:
            lines.append(f"  - {v}")
    path.write_text("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------
# Subprocess wrappers
# ---------------------------------------------------------------------------


def run_cmd(
    args: list[str],
    *,
    check: bool = True,
    capture: bool = False,
    cwd: Union[str, Path, None] = None,
) -> subprocess.CompletedProcess[str]:
    """Run a command, returning the CompletedProcess."""
    return subprocess.run(
        args,
        check=check,
        capture_output=capture,
        text=True,
        cwd=cwd,
    )


def aws_s3_cp(src: str, dst: str, *, recursive: bool = False) -> None:
    """``aws s3 cp`` wrapper.  Raises on failure."""
    cmd = ["aws", "s3", "cp", src, dst]
    if recursive:
        cmd.append("--recursive")
    run_cmd(cmd)


def aws_s3_ls(path: str) -> list[str]:
    """``aws s3 ls`` wrapper.  Returns list of ``.whl`` filenames.

    Returns an empty list when the prefix does not exist or the command
    fails (mirrors the ``|| true`` in the original bash).
    """
    result = run_cmd(["aws", "s3", "ls", path], check=False, capture=True)
    if result.returncode != 0:
        return []
    names: list[str] = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if parts and parts[-1].endswith(".whl"):
            names.append(parts[-1])
    return names


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def _require_env(name: str) -> str:
    val = os.environ.get(name, "")
    if not val:
        print(f"::error::{name} must be set", file=sys.stderr)
        sys.exit(1)
    return val


def setup_cuda(cuda_dir: str) -> None:
    """Symlink ``/usr/local/cuda`` and update environment variables."""
    link = Path("/usr/local/cuda")
    if link.exists() or link.is_symlink():
        link.unlink()
    link.symlink_to(cuda_dir)
    os.environ["PATH"] = f"/usr/local/cuda/bin:{os.environ['PATH']}"
    os.environ["LD_LIBRARY_PATH"] = (
        f"/usr/local/cuda/lib64:{os.environ.get('LD_LIBRARY_PATH', '')}"
    )
    os.environ["CUDA_HOME"] = "/usr/local/cuda"


def download_and_merge_wants(
    s3_bucket: str, wants_dir: Path, packages_file: Path
) -> list[str]:
    """Download ``wants/*.txt`` from S3, merge, deduplicate, return entries.

    The ``wants/*.txt`` files are produced by the **wants-collector** service
    in the ``pytorch/ci-infra`` repository.  It runs as a Kubernetes pod that
    periodically scans EFS access logs for PyPI download requests, filters out
    packages that already have pre-built wheels, and uploads the remaining
    entries to ``s3://pytorch-pypi-wheel-cache/wants/{cluster_id}.txt``.
    The files auto-expire after 7 days.

    See:
      - Service source:
        https://github.com/pytorch/ci-infra/blob/main/modules/pypi-cache/scripts/python/wants_collector.py
      - Kubernetes deployment:
        https://github.com/pytorch/ci-infra/blob/main/modules/pypi-cache/kubernetes/wants-collector-deployment.yaml.tpl
    """
    wants_dir.mkdir(parents=True, exist_ok=True)
    aws_s3_cp(f"s3://{s3_bucket}/wants/", str(wants_dir) + "/", recursive=True)

    entries: set[str] = set()
    for txt in sorted(wants_dir.glob("*.txt")):
        for line in txt.read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                entries.add(line)

    packages = sorted(entries)
    packages_file.write_text("\n".join(packages) + "\n" if packages else "")
    return packages


def fetch_existing_wheels(s3_bucket: str, variant: str) -> list[str]:
    """Return list of ``.whl`` filenames already present in S3."""
    return aws_s3_ls(f"s3://{s3_bucket}/{variant}/")


def build_wheel(py_bin: str, entry: str, wheel_dir: Path) -> bool:
    """Run ``pip wheel --no-deps``.  Return True on success, False on failure."""
    result = run_cmd(
        [
            py_bin,
            "-m",
            "pip",
            "wheel",
            "--no-deps",
            "--wheel-dir",
            str(wheel_dir),
            entry,
        ],
        check=False,
    )
    return result.returncode == 0


def repair_if_needed(whl_path: Path, script_dir: Path, build_dir: Path) -> Path:
    """Run the manylinux repair script if the wheel has a ``-linux_`` tag.

    Returns the (possibly renamed) wheel path.
    """
    if "-linux_" not in whl_path.name:
        return whl_path
    manywheel_ver = os.environ.get("MANYWHEEL_VERSION", "2_28")
    repair_script = script_dir.parent / f"repair_manylinux_{manywheel_ver}.sh"
    run_cmd(
        ["bash", str(repair_script), str(whl_path)],
        cwd=str(build_dir),
    )
    new_name = whl_path.name.replace("-linux_", f"-manylinux_{manywheel_ver}_", 1)
    return whl_path.parent / new_name


def _clear_directory(path: Path) -> None:
    """Remove all contents of *path* without removing the directory itself."""
    for child in path.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


def upload_wheel(whl_path: Path, s3_bucket: str, variant: str) -> None:
    """Upload a wheel to S3.  Raises on failure."""
    aws_s3_cp(str(whl_path), f"s3://{s3_bucket}/{variant}/{whl_path.name}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    s3_bucket = _require_env("S3_BUCKET")
    variant = _require_env("VARIANT")
    arch = _require_env("ARCH")
    python_versions = _require_env("PYTHON_VERSIONS").split()

    script_dir = Path(__file__).resolve().parent
    cuda_dir = os.environ.get("CUDA_DIR", "")
    force_rebuild = os.environ.get("FORCE_REBUILD", "")

    wants_dir = BUILD_DIR / "wants"
    wheel_dir = BUILD_DIR / "wheels"
    packages_file = BUILD_DIR / "packages.txt"
    skip_file = script_dir / "skip_python_versions.txt"

    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    FAILURE_SUMMARY_PATH.write_text("")

    try:
        # Step 1: CUDA
        if cuda_dir:
            setup_cuda(cuda_dir)

        # Step 2: Download and merge wants
        # NOTE: The wants list only records package names+versions, not
        # per-Python-version availability.  We intentionally build every
        # package for every configured Python version even though some
        # wheels may already exist on PyPI.  This is fine because:
        #   - At serve time PyPI is the preferred index; redundant wheels
        #     in S3 are simply never fetched by pip.
        #   - Each combination is built at most once (existing S3 wheels
        #     are skipped above), so the extra compute cost is negligible.
        #   - Tracking per-version PyPI availability in the wants list
        #     would add significant complexity for no practical benefit.
        wheel_dir.mkdir(parents=True, exist_ok=True)
        packages = download_and_merge_wants(s3_bucket, wants_dir, packages_file)
        print(f"==> Merged package list ({len(packages)} entries)")

        # Step 2b: Skip list
        skip_set = load_skip_list(skip_file)
        if skip_set:
            print(f"==> Skip list loaded ({len(skip_set)} entries)")

        # Step 3: Cache existing S3 listing
        existing_wheels = fetch_existing_wheels(s3_bucket, variant)
        print(f"==> Existing wheels in S3: {len(existing_wheels)}")

        # Step 4: Build
        built = 0
        skipped = 0
        excluded = 0
        failed = 0
        failures: list[tuple[str, str]] = []

        for pyver in python_versions:
            py_bin = python_path(pyver)
            tag = cp_tag(pyver)

            if not os.access(py_bin, os.X_OK):
                print(f"::warning::Python {pyver} not found at {py_bin}, skipping")
                continue

            print(f"==> Processing Python {pyver}  ({py_bin})")

            for entry in packages:
                if "==" not in entry:
                    continue

                pkg_name, pkg_version = entry.split("==", 1)
                norm = normalize_name(pkg_name)
                out = wheel_dir / pyver
                out.mkdir(parents=True, exist_ok=True)

                # Skip list — highest precedence
                if f"{norm}=={pkg_version}:{pyver}" in skip_set:
                    print(f"    Excluding {entry} for {pyver} (unsupported)")
                    excluded += 1
                    continue

                # Existing wheel check
                if force_rebuild != "*" and force_rebuild != entry:
                    if wheel_matches(norm, pkg_version, tag, arch, existing_wheels):
                        skipped += 1
                        continue

                print(f"    Building {entry} for {tag} ...")
                if not build_wheel(py_bin, entry, out):
                    print(f"::warning::Failed to build {entry} for Python {pyver}")
                    failures.append((entry, pyver))
                    failed += 1
                    _clear_directory(out)
                    continue

                for whl in sorted(out.glob("*.whl")):
                    whl = repair_if_needed(whl, script_dir, BUILD_DIR)
                    upload_wheel(whl, s3_bucket, variant)
                    existing_wheels.append(whl.name)
                    built += 1

                _clear_directory(out)

        # Step 5: Summary
        print()
        print(
            f"==> Build complete:  built={built}  skipped={skipped}"
            f"  excluded={excluded}  failed={failed}"
        )
        write_failure_summary(failures, FAILURE_SUMMARY_PATH)

    finally:
        shutil.rmtree(BUILD_DIR, ignore_errors=True)


if __name__ == "__main__":
    main()
