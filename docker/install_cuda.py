#!/usr/bin/env python3
"""Install CUDA toolkits, cuDNN, NCCL, nvSHMEM, and cuSPARSELt.

Adapted from PyTorch CI: .ci/docker/common/install_cuda.sh
Inlines NCCL and cuSPARSELt installation (upstream uses separate scripts + pin files).

Version information is fetched from PyTorch's generate_binary_build_matrix.py
at build time so it stays in sync automatically.  Use --dry-run to inspect
the discovered configuration without installing anything.
"""

# /// script
# requires-python = ">=3.9"
# ///

import argparse
import ast
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
import urllib.request
from time import sleep


PYTORCH_MATRIX_URL = (
    "https://raw.githubusercontent.com/pytorch/pytorch/main/"
    ".github/scripts/generate_binary_build_matrix.py"
)

# CUDA arches to skip (PyTorch supports them but we don't build Docker images for them)
SKIP_CUDA_ARCHES = {"12.6"}

# ---------------------------------------------------------------------------
# Fetching & parsing PyTorch version info
# ---------------------------------------------------------------------------


def _fetch_text(url: str) -> str:
    """Fetch URL content as text."""
    print(f"+ fetch {url}", flush=True)
    with urllib.request.urlopen(url) as resp:
        return resp.read().decode()


def _extract_ast_assign(tree: ast.Module, name: str) -> ast.expr:
    """Return the value node for a top-level assignment ``name = ...``."""
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == name:
                    return node.value
    raise KeyError(f"{name!r} not found in AST")


def fetch_pytorch_versions() -> list[dict]:
    """Download PyTorch's build-matrix script and extract CUDA version configs.

    Returns a list of dicts, one per CUDA arch, each with keys:
        version, cuda_major, cudnn_version, nccl_pip_version,
        cusparselt_pip_version, nvshmem_version
    """
    source = _fetch_text(PYTORCH_MATRIX_URL)
    tree = ast.parse(source)

    # CUDA_ARCHES = ["12.6", "12.8", ...]
    arches_node = _extract_ast_assign(tree, "CUDA_ARCHES")
    arches: list[str] = [
        a for a in ast.literal_eval(arches_node) if a not in SKIP_CUDA_ARCHES
    ]

    # CUDA_ARCHES_FULL_VERSION = {"12.6": "12.6.3", ...}
    full_ver_node = _extract_ast_assign(tree, "CUDA_ARCHES_FULL_VERSION")
    full_versions: dict[str, str] = ast.literal_eval(full_ver_node)

    # PYTORCH_EXTRA_INSTALL_REQUIREMENTS = {"12.6": "...", ...}
    reqs_node = _extract_ast_assign(tree, "PYTORCH_EXTRA_INSTALL_REQUIREMENTS")
    reqs: dict[str, str] = ast.literal_eval(reqs_node)

    def _extract_pip_ver(pkg_prefix: str, req_str: str, arch: str) -> str:
        m = re.search(rf"{re.escape(pkg_prefix)}==([^\s;|]+)", req_str)
        if not m:
            raise ValueError(
                f"Could not find {pkg_prefix} in requirements for CUDA {arch}"
            )
        return m.group(1)

    results = []
    for arch in arches:
        full_ver = full_versions[arch]
        cuda_major = arch.split(".")[0]
        req_str = reqs[arch]

        results.append(
            {
                "version": full_ver,
                "cuda_major": cuda_major,
                "cudnn_version": _extract_pip_ver(
                    f"nvidia-cudnn-cu{cuda_major}", req_str, arch
                ),
                "nccl_pip_version": _extract_pip_ver(
                    f"nvidia-nccl-cu{cuda_major}", req_str, arch
                ),
                "cusparselt_pip_version": _extract_pip_ver(
                    f"nvidia-cusparselt-cu{cuda_major}", req_str, arch
                ),
                "nvshmem_version": _extract_pip_ver(
                    f"nvidia-nvshmem-cu{cuda_major}", req_str, arch
                ),
            }
        )

    return results


# ---------------------------------------------------------------------------
# Dynamic discovery of NVIDIA download names
# ---------------------------------------------------------------------------


def discover_cuda_runfile(full_version: str) -> str:
    """Return the CUDA runfile base name (without arch suffix and .run).

    Fetches the CUDA redistrib JSON to get the driver version, then
    constructs the runfile name: ``cuda_{version}_{driver}_linux``.
    """
    url = (
        f"https://developer.download.nvidia.com/compute/cuda/redist/"
        f"redistrib_{full_version}.json"
    )
    data = json.loads(_fetch_text(url))
    driver_version = data["nvidia_driver"]["version"]
    return f"cuda_{full_version}_{driver_version}_linux"


def discover_cusparselt_archive(
    cusparselt_pip_ver: str, cuda_major: str, arch: str
) -> str:
    """Find the exact cuSPARSELt archive name from NVIDIA's directory listing.

    The pip version (e.g. ``0.7.1``) maps to an archive like
    ``libcusparse_lt-linux-x86_64-0.7.1.0-archive``.  Newer versions may
    include a ``_cuda{N}`` suffix.
    """
    nv_arch = "x86_64" if arch == "x86_64" else "aarch64"
    listing_url = (
        f"https://developer.download.nvidia.com/compute/cusparselt/redist/"
        f"libcusparse_lt/linux-{nv_arch}/"
    )
    html = _fetch_text(listing_url)

    # Match archives whose version starts with the pip version prefix
    # e.g. pip 0.7.1 -> 0.7.1.0, pip 0.8.0 -> 0.8.0.4_cuda13
    pattern = (
        rf"(libcusparse_lt-linux-{re.escape(nv_arch)}"
        rf"-{re.escape(cusparselt_pip_ver)}\.[^\"]*?-archive)"
    )
    candidates = re.findall(pattern, html)

    if not candidates:
        raise RuntimeError(
            f"No cuSPARSELt archive found for pip version {cusparselt_pip_ver} "
            f"at {listing_url}"
        )

    # Prefer the one matching our cuda_major (e.g. _cuda13), or the one
    # without a cuda suffix for older versions that are cuda-agnostic
    cuda_suffix = f"_cuda{cuda_major}"
    for c in candidates:
        if cuda_suffix in c:
            return c
    # If no cuda-suffixed match, return the first (cuda-agnostic) candidate
    return candidates[0]


def nccl_pip_to_git_tag(pip_version: str) -> str:
    """Convert NCCL pip version ``2.29.3`` to git tag ``v2.29.3-1``."""
    return f"v{pip_version}-1"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def detect_arch() -> str:
    """Return 'x86_64' or 'sbsa' (aarch64)."""
    target = os.environ.get("TARGETARCH", platform.machine())
    if target in ("amd64", "x86_64"):
        return "x86_64"
    return "sbsa"


def run(*cmd: str, **kwargs) -> None:
    """Run a command, logging it first."""
    print(f"+ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True, **kwargs)


def download(url: str, dest: str, retries: int = 3) -> None:
    """Download *url* to *dest* with simple retries."""
    for attempt in range(1, retries + 1):
        try:
            print(f"+ download {url} -> {dest} (attempt {attempt})", flush=True)
            urllib.request.urlretrieve(url, dest)
            return
        except Exception as exc:
            if attempt == retries:
                raise
            print(f"  download failed ({exc}), retrying …", flush=True)
            sleep(5)


# ---------------------------------------------------------------------------
# Installers
# ---------------------------------------------------------------------------


def install_cuda(version: str, runfile: str, prefix: str, arch: str, tmp: str) -> None:
    major_minor = ".".join(version.split(".")[:2])
    default_path = f"/usr/local/cuda-{major_minor}"

    # Clean previous installs
    for p in (default_path, "/usr/local/cuda"):
        if os.path.exists(p):
            if os.path.islink(p):
                os.remove(p)
            else:
                shutil.rmtree(p)

    if arch == "sbsa":
        runfile = f"{runfile}_sbsa"
    runfile = f"{runfile}.run"

    dest = os.path.join(tmp, runfile)
    download(
        f"https://developer.download.nvidia.com/compute/cuda/{version}/local_installers/{runfile}",
        dest,
    )
    os.chmod(dest, 0o755)
    run(dest, "--toolkit", "--silent")
    os.remove(dest)

    # Remove the symlink the runfile creates
    if os.path.islink("/usr/local/cuda"):
        os.remove("/usr/local/cuda")

    # Move to the target prefix if needed
    if default_path != prefix and os.path.exists(default_path):
        shutil.move(default_path, prefix)


def install_cudnn(
    cuda_major: str, cudnn_version: str, prefix: str, arch: str, tmp: str
) -> None:
    filepath = f"cudnn-linux-{arch}-{cudnn_version}_cuda{cuda_major}-archive"
    url = f"https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/linux-{arch}/{filepath}.tar.xz"

    dest = os.path.join(tmp, f"{filepath}.tar.xz")
    download(url, dest)
    run("tar", "xf", dest, "-C", tmp)
    os.remove(dest)

    extracted = os.path.join(tmp, filepath)
    run("cp", "-a", *_glob(f"{extracted}/include/"), f"{prefix}/include/")
    run("cp", "-a", *_glob(f"{extracted}/lib/"), f"{prefix}/lib64/")
    shutil.rmtree(extracted)


def install_nvshmem(
    cuda_major: str, nvshmem_version: str, prefix: str, arch: str, tmp: str
) -> None:
    filename = f"libnvshmem-linux-{arch}-{nvshmem_version}_cuda{cuda_major}-archive"
    url = f"https://developer.download.nvidia.com/compute/nvshmem/redist/libnvshmem/linux-{arch}/{filename}.tar.xz"

    dest = os.path.join(tmp, f"{filename}.tar.xz")
    download(url, dest)
    run("tar", "xf", dest, "-C", tmp)
    os.remove(dest)

    extracted = os.path.join(tmp, filename)
    run("cp", "-a", *_glob(f"{extracted}/include/"), f"{prefix}/include/")
    run("cp", "-a", *_glob(f"{extracted}/lib/"), f"{prefix}/lib64/")
    shutil.rmtree(extracted)


def install_nccl(nccl_version: str, prefix: str, tmp: str) -> None:
    nccl_dir = os.path.join(tmp, "nccl")
    run(
        "git",
        "clone",
        "-b",
        nccl_version,
        "--depth",
        "1",
        "https://github.com/NVIDIA/nccl.git",
        nccl_dir,
    )
    jobs = max(1, os.cpu_count() - 2)
    run("make", f"-j{jobs}", f"CUDA_HOME={prefix}", "src.build", cwd=nccl_dir)
    run("cp", "-a", *_glob(f"{nccl_dir}/build/include/"), f"{prefix}/include/")
    run("cp", "-a", *_glob(f"{nccl_dir}/build/lib/"), f"{prefix}/lib64/")
    shutil.rmtree(nccl_dir)
    run("ldconfig")


def install_cusparselt(cusparselt_name: str, prefix: str, arch: str, tmp: str) -> None:
    nv_arch = "x86_64" if arch == "x86_64" else "aarch64"
    url = (
        f"https://developer.download.nvidia.com/compute/cusparselt/redist/"
        f"libcusparse_lt/linux-{nv_arch}/{cusparselt_name}.tar.xz"
    )

    dest = os.path.join(tmp, f"{cusparselt_name}.tar.xz")
    download(url, dest, retries=3)
    run("tar", "xf", dest, "-C", tmp)
    os.remove(dest)

    extracted = os.path.join(tmp, cusparselt_name)
    run("cp", "-a", *_glob(f"{extracted}/include/"), f"{prefix}/include/")
    run("cp", "-a", *_glob(f"{extracted}/lib/"), f"{prefix}/lib64/")
    shutil.rmtree(extracted)
    run("ldconfig")


def _glob(pattern: str) -> list[str]:
    """Expand a trailing-slash glob into file list for cp -a.

    'cp -a dir/*' needs shell expansion; we replicate it here so we can avoid
    shell=True.  Given '/tmp/foo/include/' we return all children of that dir.
    """
    import glob as _glob_mod

    # pattern like "/tmp/foo/include/" -> "/tmp/foo/include/*"
    results = _glob_mod.glob(pattern.rstrip("/") + "/*")
    if not results:
        raise FileNotFoundError(f"No files matched: {pattern}")
    return sorted(results)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def install_version(cfg: dict, arch: str) -> None:
    version = cfg["version"]
    major_minor = ".".join(version.split(".")[:2])
    prefix = f"/usr/local/cuda-{major_minor}"

    print(
        f"\n{'=' * 72}\n"
        f"Installing CUDA {version} + cuDNN {cfg['cudnn_version']} "
        f"+ nvSHMEM {cfg['nvshmem_version']} "
        f"+ NCCL {cfg['nccl_git_tag']} "
        f"+ cuSPARSELt {cfg['cusparselt_archive']}\n"
        f"{'=' * 72}",
        flush=True,
    )

    with tempfile.TemporaryDirectory() as tmp:
        install_cuda(version, cfg["runfile"], prefix, arch, tmp)
        install_cudnn(cfg["cuda_major"], cfg["cudnn_version"], prefix, arch, tmp)
        install_nvshmem(cfg["cuda_major"], cfg["nvshmem_version"], prefix, arch, tmp)
        install_nccl(cfg["nccl_git_tag"], prefix, tmp)
        install_cusparselt(cfg["cusparselt_archive"], prefix, arch, tmp)

    run("ldconfig")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print discovered configuration and exit without installing",
    )
    args = parser.parse_args()

    arch = detect_arch()
    print(f"Detected architecture: {arch}", flush=True)

    # Fetch version info from PyTorch's build matrix
    print("\nFetching CUDA version info from PyTorch ...", flush=True)
    versions = fetch_pytorch_versions()

    # Resolve download names for each version
    configs = []
    for v in versions:
        runfile = discover_cuda_runfile(v["version"])
        cusparselt_archive = discover_cusparselt_archive(
            v["cusparselt_pip_version"], v["cuda_major"], arch
        )
        nccl_git_tag = nccl_pip_to_git_tag(v["nccl_pip_version"])

        configs.append(
            {
                **v,
                "runfile": runfile,
                "cusparselt_archive": cusparselt_archive,
                "nccl_git_tag": nccl_git_tag,
            }
        )

    if args.dry_run:
        print("\n=== Discovered configuration (--dry-run) ===\n")
        for cfg in configs:
            mm = ".".join(cfg["version"].split(".")[:2])
            print(f"CUDA {mm} ({cfg['version']}):")
            print(f"  runfile:       {cfg['runfile']}")
            print(f"  cuDNN:         {cfg['cudnn_version']}")
            print(
                f"  NCCL:          {cfg['nccl_git_tag']} (pip: {cfg['nccl_pip_version']})"
            )
            print(
                f"  cuSPARSELt:    {cfg['cusparselt_archive']} (pip: {cfg['cusparselt_pip_version']})"
            )
            print(f"  nvSHMEM:       {cfg['nvshmem_version']}")
            print()
        return

    for cfg in configs:
        install_version(cfg, arch)

    # Default symlink: last version in the list
    last = configs[-1]["version"]
    last_major_minor = ".".join(last.split(".")[:2])
    default = f"/usr/local/cuda-{last_major_minor}"
    link = "/usr/local/cuda"
    if os.path.islink(link):
        os.remove(link)
    os.symlink(default, link)
    print(f"Symlinked {link} -> {default}", flush=True)

    run("ldconfig")


if __name__ == "__main__":
    main()
