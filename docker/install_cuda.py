#!/usr/bin/env python3
"""Install CUDA toolkits, cuDNN, NCCL, nvSHMEM, and cuSPARSELt.

Adapted from PyTorch CI: .ci/docker/common/install_cuda.sh
Inlines NCCL and cuSPARSELt installation (upstream uses separate scripts + pin files).

Installs all three CUDA versions (12.8, 12.9, 13.0) into separate prefixes:
  /usr/local/cuda-12.8, /usr/local/cuda-12.9, /usr/local/cuda-13.0
with /usr/local/cuda symlinked to /usr/local/cuda-13.0 as the default.
"""

# /// script
# requires-python = ">=3.9"
# ///

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from time import sleep

# ---------------------------------------------------------------------------
# Version configurations
# ---------------------------------------------------------------------------
CUDA_VERSIONS = [
    {
        "version": "12.8.1",
        "runfile": "cuda_12.8.1_570.124.06_linux",
        "cudnn_version": "9.19.0.56",
        "cuda_major": "12",
        "cusparselt": "libcusparse_lt-linux-{arch}-0.7.1.0-archive",
    },
    {
        "version": "12.9.1",
        "runfile": "cuda_12.9.1_575.57.08_linux",
        "cudnn_version": "9.17.1.4",
        "cuda_major": "12",
        "cusparselt": "libcusparse_lt-linux-{arch}-0.7.1.0-archive",
    },
    {
        "version": "13.0.2",
        "runfile": "cuda_13.0.2_580.95.05_linux",
        "cudnn_version": "9.19.0.56",
        "cuda_major": "13",
        "cusparselt": "libcusparse_lt-linux-{arch}-0.8.0.4_cuda13-archive",
    },
]

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


def install_cuda(
    version: str, runfile: str, prefix: str, arch: str, tmp: str
) -> None:
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
    run("make", "-j", f"CUDA_HOME={prefix}", "src.build", cwd=nccl_dir)
    run("cp", "-a", *_glob(f"{nccl_dir}/build/include/"), f"{prefix}/include/")
    run("cp", "-a", *_glob(f"{nccl_dir}/build/lib/"), f"{prefix}/lib64/")
    shutil.rmtree(nccl_dir)
    run("ldconfig")


def install_cusparselt(
    cusparselt_name: str, prefix: str, arch: str, tmp: str
) -> None:
    name = cusparselt_name.format(arch=arch)
    url = f"https://developer.download.nvidia.com/compute/cusparselt/redist/libcusparse_lt/linux-{arch}/{name}.tar.xz"

    dest = os.path.join(tmp, f"{name}.tar.xz")
    download(url, dest, retries=3)
    run("tar", "xf", dest, "-C", tmp)
    os.remove(dest)

    extracted = os.path.join(tmp, name)
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


def install_version(
    cfg: dict, nccl_version: str, nvshmem_version: str, arch: str
) -> None:
    version = cfg["version"]
    major_minor = ".".join(version.split(".")[:2])
    prefix = f"/usr/local/cuda-{major_minor}"

    print(
        f"\n{'='*72}\n"
        f"Installing CUDA {version} + cuDNN {cfg['cudnn_version']} "
        f"+ nvSHMEM + NCCL + cuSPARSELt\n"
        f"{'='*72}",
        flush=True,
    )

    with tempfile.TemporaryDirectory() as tmp:
        install_cuda(version, cfg["runfile"], prefix, arch, tmp)
        install_cudnn(cfg["cuda_major"], cfg["cudnn_version"], prefix, arch, tmp)
        install_nvshmem(cfg["cuda_major"], nvshmem_version, prefix, arch, tmp)
        install_nccl(nccl_version, prefix, tmp)
        install_cusparselt(cfg["cusparselt"], prefix, arch, tmp)

    run("ldconfig")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--nccl-version",
        default=os.environ.get("NCCL_VERSION", "v2.29.3-1"),
        help="NCCL version git tag (default: v2.29.3-1 or $NCCL_VERSION)",
    )
    parser.add_argument(
        "--nvshmem-version",
        default=os.environ.get("NVSHMEM_VERSION", "3.4.5"),
        help="nvSHMEM version (default: 3.4.5 or $NVSHMEM_VERSION)",
    )
    args = parser.parse_args()

    arch = detect_arch()
    print(f"Detected architecture: {arch}", flush=True)

    for cfg in CUDA_VERSIONS:
        install_version(cfg, args.nccl_version, args.nvshmem_version, arch)

    # Default symlink: last version in the list
    last = CUDA_VERSIONS[-1]["version"]
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
