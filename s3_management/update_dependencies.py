from typing import Dict, List

import boto3
import re


S3 = boto3.resource("s3")
CLIENT = boto3.client("s3")
BUCKET = S3.Bucket("pytorch")

PACKAGES_PER_PROJECT = [
    {"package": "sympy", "version": "latest", "project": "torch"},
    {"package": "mpmath", "version": "latest", "project": "torch"},
    {"package": "pillow", "version": "latest", "project": "torch"},
    {"package": "networkx", "version": "latest", "project": "torch"},
    {"package": "numpy", "version": "latest", "project": "torch"},
    {"package": "jinja2", "version": "latest", "project": "torch"},
    {"package": "filelock", "version": "latest", "project": "torch"},
    {"package": "fsspec", "version": "latest", "project": "torch"},
    {"package": "nvidia-cudnn-cu11", "version": "latest", "project": "torch"},
    {"package": "nvidia-cudnn-cu12", "version": "latest", "project": "torch"},
    {"package": "typing-extensions", "version": "latest", "project": "torch"},
    {"package": "nvidia-cuda-nvrtc-cu12", "version": "12.9.86", "project": "torch", "target": "cu129"},
    {"package": "nvidia-cuda-runtime-cu12", "version": "12.9.79", "project": "torch", "target": "cu129"},
    {"package": "nvidia-cuda-cupti-cu12", "version": "12.9.79", "project": "torch", "target": "cu129"},
    {"package": "nvidia-cublas-cu12", "version": "12.9.1.4", "project": "torch", "target": "cu129"},
    {"package": "nvidia-cufft-cu12", "version": "11.4.1.4", "project": "torch", "target": "cu129"},
    {"package": "nvidia-curand-cu12", "version": "10.3.10.19", "project": "torch", "target": "cu129"},
    {"package": "nvidia-cusolver-cu12", "version": "11.7.5.82", "project": "torch", "target": "cu129"},
    {"package": "nvidia-cusparse-cu12", "version": "12.5.10.65", "project": "torch", "target": "cu129"},
    {"package": "nvidia-nvtx-cu12", "version": "12.9.79", "project": "torch", "target": "cu129"},
    {"package": "nvidia-nvjitlink-cu12", "version": "12.9.86", "project": "torch", "target": "cu129"},
    {"package": "nvidia-cufile-cu12", "version": "1.14.1.1", "project": "torch", "target": "cu129"},
    {"package": "arpeggio", "version": "latest", "project": "triton"},
    {"package": "caliper-reader", "version": "latest", "project": "triton"},
    {"package": "contourpy", "version": "latest", "project": "triton"},
    {"package": "cycler", "version": "latest", "project": "triton"},
    {"package": "dill", "version": "latest", "project": "triton"},
    {"package": "fonttools", "version": "latest", "project": "triton"},
    {"package": "kiwisolver", "version": "latest", "project": "triton"},
    {"package": "llnl-hatchet", "version": "latest", "project": "triton"},
    {"package": "matplotlib", "version": "latest", "project": "triton"},
    {"package": "pandas", "version": "latest", "project": "triton"},
    {"package": "pydot", "version": "latest", "project": "triton"},
    {"package": "pyparsing", "version": "latest", "project": "triton"},
    {"package": "pytz", "version": "latest", "project": "triton"},
    {"package": "textX", "version": "latest", "project": "triton"},
    {"package": "tzdata", "version": "latest", "project": "triton"},
    {"package": "importlib-metadata", "version": "latest", "project": "triton"},
    {"package": "importlib-resources", "version": "latest", "project": "triton"},
    {"package": "zipp", "version": "latest", "project": "triton"},
    {"package": "aiohttp", "version": "latest", "project": "torchtune"},
    {"package": "aiosignal", "version": "latest", "project": "torchtune"},
    {"package": "antlr4-python3-runtime", "version": "latest", "project": "torchtune"},
    {"package": "attrs", "version": "latest", "project": "torchtune"},
    {"package": "blobfile", "version": "latest", "project": "torchtune"},
    {"package": "certifi", "version": "latest", "project": "torchtune"},
    {"package": "charset-normalizer", "version": "latest", "project": "torchtune"},
    {"package": "datasets", "version": "latest", "project": "torchtune"},
    {"package": "dill", "version": "latest", "project": "torchtune"},
    {"package": "frozenlist", "version": "latest", "project": "torchtune"},
    {"package": "huggingface-hub", "version": "latest", "project": "torchtune"},
    {"package": "idna", "version": "latest", "project": "torchtune"},
    {"package": "lxml", "version": "latest", "project": "torchtune"},
    {"package": "markupsafe", "version": "latest", "project": "torchtune"},
    {"package": "multidict", "version": "latest", "project": "torchtune"},
    {"package": "multiprocess", "version": "latest", "project": "torchtune"},
    {"package": "omegaconf", "version": "latest", "project": "torchtune"},
    {"package": "pandas", "version": "latest", "project": "torchtune"},
    {"package": "pyarrow", "version": "latest", "project": "torchtune"},
    {"package": "pyarrow-hotfix", "version": "latest", "project": "torchtune"},
    {"package": "pycryptodomex", "version": "latest", "project": "torchtune"},
    {"package": "python-dateutil", "version": "latest", "project": "torchtune"},
    {"package": "pytz", "version": "latest", "project": "torchtune"},
    {"package": "pyyaml", "version": "latest", "project": "torchtune"},
    {"package": "regex", "version": "latest", "project": "torchtune"},
    {"package": "requests", "version": "latest", "project": "torchtune"},
    {"package": "safetensors", "version": "latest", "project": "torchtune"},
    {"package": "sentencepiece", "version": "latest", "project": "torchtune"},
    {"package": "six", "version": "latest", "project": "torchtune"},
    {"package": "tiktoken", "version": "latest", "project": "torchtune"},
    {"package": "tqdm", "version": "latest", "project": "torchtune"},
    {"package": "tzdata", "version": "latest", "project": "torchtune"},
    {"package": "urllib3", "version": "latest", "project": "torchtune"},
    {"package": "xxhash", "version": "latest", "project": "torchtune"},
    {"package": "yarl", "version": "latest", "project": "torchtune"},
    {"package": "dpcpp-cpp-rt", "version": "latest", "project": "torch_xpu"},
    {"package": "intel-cmplr-lib-rt", "version": "latest", "project": "torch_xpu"},
    {"package": "intel-cmplr-lib-ur", "version": "latest", "project": "torch_xpu"},
    {"package": "intel-cmplr-lic-rt", "version": "latest", "project": "torch_xpu"},
    {"package": "intel-opencl-rt", "version": "latest", "project": "torch_xpu"},
    {"package": "intel-sycl-rt", "version": "latest", "project": "torch_xpu"},
    {"package": "intel-openmp", "version": "latest", "project": "torch_xpu"},
    {"package": "tcmlib", "version": "latest", "project": "torch_xpu"},
    {"package": "umf", "version": "latest", "project": "torch_xpu"},
    {"package": "intel-pti", "version": "latest", "project": "torch_xpu"},
    {"package": "tbb", "version": "latest", "project": "torch_xpu"},
    {"package": "oneccl-devel", "version": "latest", "project": "torch_xpu"},
    {"package": "oneccl", "version": "latest", "project": "torch_xpu"},
    {"package": "impi-rt", "version": "latest", "project": "torch_xpu"},
    {"package": "onemkl-sycl-blas", "version": "latest", "project": "torch_xpu"},
    {"package": "onemkl-sycl-dft", "version": "latest", "project": "torch_xpu"},
    {"package": "onemkl-sycl-lapack", "version": "latest", "project": "torch_xpu"},
    {"package": "onemkl-sycl-sparse", "version": "latest", "project": "torch_xpu"},
    {"package": "onemkl-sycl-rng", "version": "latest", "project": "torch_xpu"},
    {"package": "mkl", "version": "latest", "project": "torch_xpu"},
]


def download(url: str) -> bytes:
    from urllib.request import urlopen

    with urlopen(url) as conn:
        return conn.read()


def is_stable(package_version: str) -> bool:
    return bool(re.match(r'^([0-9]+\.)+[0-9]+$', package_version))


def parse_simple_idx(url: str) -> Dict[str, str]:
    html = download(url).decode("ascii")
    return {
        name: url
        for (url, name) in re.findall('<a href="([^"]+)"[^>]*>([^>]+)</a>', html)
    }


def get_whl_versions(idx: Dict[str, str]) -> List[str]:
    return [k.split("-")[1] for k in idx.keys() if k.endswith(".whl") and is_stable(k.split("-")[1])]


def get_wheels_of_version(idx: Dict[str, str], version: str) -> Dict[str, str]:
    return {
        k: v
        for (k, v) in idx.items()
        if k.endswith(".whl") and k.split("-")[1] == version
    }


def upload_missing_whls(
    pkg_name: str = "numpy", 
    prefix: str = "whl/test", *, 
    dry_run: bool = False, 
    only_pypi: bool = False,
    target_version: str = "latest"
) -> None:
    pypi_idx = parse_simple_idx(f"https://pypi.org/simple/{pkg_name}")
    pypi_versions = get_whl_versions(pypi_idx)

    # Determine which version to use
    if target_version == "latest" or not target_version:
        selected_version = pypi_versions[-1] if pypi_versions else None
    elif target_version in pypi_versions:
        selected_version = target_version
    else:
        print(f"Warning: Version {target_version} not found for {pkg_name}, using latest")
        selected_version = pypi_versions[-1] if pypi_versions else None

    if not selected_version:
        print(f"No stable versions found for {pkg_name}")
        return

    pypi_latest_packages = get_wheels_of_version(pypi_idx, selected_version)

    download_latest_packages = []
    if not only_pypi:
        download_idx = parse_simple_idx(f"https://download.pytorch.org/{prefix}/{pkg_name}")
        download_latest_packages = get_wheels_of_version(download_idx, selected_version)

    has_updates = False
    for pkg in pypi_latest_packages:
        if pkg in download_latest_packages:
            continue
        # Skip pp packages
        if "-pp3" in pkg:
            continue
        # Skip win32 packages
        if "-win32" in pkg:
            continue
        # Skip muslinux packages
        if "-musllinux" in pkg:
            continue
        print(f"Downloading {pkg}")
        if dry_run:
            has_updates = True
            print(f"Dry Run - not Uploading {pkg} to s3://pytorch/{prefix}/")
            continue
        data = download(pypi_idx[pkg])
        print(f"Uploading {pkg} to s3://pytorch/{prefix}/")
        BUCKET.Object(key=f"{prefix}/{pkg}").put(
            ACL="public-read", ContentType="binary/octet-stream", Body=data
        )
        has_updates = True
    if not has_updates:
        print(
            f"{pkg_name} is already at version {selected_version} for {prefix}"
        )


def main() -> None:
    from argparse import ArgumentParser

    parser = ArgumentParser("Upload dependent packages to s3://pytorch")
    # Get unique paths from the packages list
    project_paths = list(set(pkg["project"] for pkg in PACKAGES_PER_PROJECT))
    parser.add_argument("--package", choices=project_paths, default="torch")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--only-pypi", action="store_true")
    parser.add_argument("--include-stable", action="store_true")
    args = parser.parse_args()

    SUBFOLDERS = ["whl/nightly", "whl/test"]
    if args.include_stable:
        SUBFOLDERS.append("whl")

    for prefix in SUBFOLDERS:
        # Filter packages by the selected project path
        selected_packages = [pkg for pkg in PACKAGES_PER_PROJECT if pkg["project"] == args.package]
        for pkg_info in selected_packages:
            if( hasattr(pkg_info, "target") and pkg_info["target"] != ""):
                full_path=f'{prefix}/{pkg_info["target"]}'
            else:
                full_path=f'{prefix}'

            upload_missing_whls(
                pkg_info["package"],
                full_path,
                dry_run=args.dry_run,
                only_pypi=args.only_pypi,
                target_version=pkg_info["version"]
            )


if __name__ == "__main__":
    main()
