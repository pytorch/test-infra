import re
from typing import Dict, List, Union

import boto3  # type: ignore[import-untyped]


S3 = boto3.resource("s3")
CLIENT = boto3.client("s3")
BUCKET = S3.Bucket("pytorch")

PACKAGES_PER_PROJECT = {
    "sympy": [{"version": "latest", "project": "torch"}],
    "mpmath": [{"version": "latest", "project": "torch"}],
    "pillow": [{"version": "latest", "project": "torch"}],
    "networkx": [{"version": "latest", "project": "torch"}],
    "numpy": [{"version": "latest", "project": "torch"}],
    "jinja2": [{"version": "latest", "project": "torch"}],
    "filelock": [{"version": "latest", "project": "torch"}],
    "fsspec": [{"version": "latest", "project": "torch"}],
    "nvidia-cudnn-cu11": [{"version": "latest", "project": "torch"}],
    "nvidia-cudnn-cu12": [{"version": "latest", "project": "torch"}],
    "typing-extensions": [{"version": "latest", "project": "torch"}],
    "nvidia-cuda-nvrtc-cu12": [
        {
            "version": "12.6.77",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "12.8.93",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "12.9.86",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cuda-nvrtc": [
        {
            "version": "13.0.48",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-cuda-runtime-cu12": [
        {
            "version": "12.6.77",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "12.8.90",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "12.9.79",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cuda-runtime": [
        {
            "version": "13.0.48",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-cuda-cupti-cu12": [
        {
            "version": "12.6.80",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "12.8.90",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "12.9.79",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cuda-cupti": [
        {
            "version": "13.0.48",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-cudnn-cu12": [
        {
            "version": "9.10.2.21",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "9.10.2.21",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "latest",
            "project": "torch",
            "target": "",
        },
    ],
    "nvidia-cudnn-cu13": [
        {
            "version": "9.13.0.50",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-cublas-cu12": [
        {
            "version": "12.6.4.1",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "12.8.4.1",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "12.9.1.4",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cublas": [
        {
            "version": "13.0.0.19",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-cufft-cu12": [
        {
            "version": "11.3.0.4",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "11.3.3.83",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "11.4.1.4",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cufft": [
        {
            "version": "12.0.0.15",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-curand-cu12": [
        {
            "version": "10.3.7.77",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "10.3.9.90",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "10.3.10.19",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-curand": [
        {
            "version": "10.4.0.35",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-cusolver-cu12": [
        {
            "version": "11.7.1.2",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "11.7.3.90",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "11.7.5.82",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cusolver": [
        {
            "version": "12.0.3.29",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-cusparse-cu12": [
        {
            "version": "12.5.4.2",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "12.5.8.93",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "12.5.10.65",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cusparse": [
        {
            "version": "12.6.2.49",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-cusparselt-cu12": [
        {
            "version": "0.7.1",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "0.7.1",
            "project": "torch",
            "target": "cu128",
        },
    ],
    "nvidia-cusparselt-cu13": [
        {
            "version": "0.8.0",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-nccl-cu12": [
        {
            "version": "2.27.5",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "2.27.5",
            "project": "torch",
            "target": "cu128",
        },
    ],
    "nvidia-nccl-cu13": [
        {
            "version": "2.27.7",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-nvshmem-cu12": [
        {
            "version": "3.3.24",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "3.3.24",
            "project": "torch",
            "target": "cu128",
        },
    ],
    "nvidia-nvshmem-cu13": [
        {
            "version": "3.3.24",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-nvtx-cu12": [
        {
            "version": "12.6.77",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "12.8.90",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "12.9.79",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-nvtx": [
        {
            "version": "13.0.39",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-nvjitlink-cu12": [
        {
            "version": "12.6.85",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "12.8.93",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "12.9.86",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-nvjitlink": [
        {
            "version": "13.0.39",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "nvidia-cufile-cu12": [
        {
            "version": "1.11.1.6",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "1.13.1.3",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "1.14.1.1",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cufile": [
        {
            "version": "1.15.0.42",
            "project": "torch",
            "target": "cu130",
        }
    ],
    "arpeggio": [{"version": "latest", "project": "triton"}],
    "caliper-reader": [{"version": "latest", "project": "triton"}],
    "contourpy": [{"version": "latest", "project": "triton"}],
    "cycler": [{"version": "latest", "project": "triton"}],
    "dill": [{"version": "latest", "project": "triton"}],
    "fonttools": [{"version": "latest", "project": "triton"}],
    "kiwisolver": [{"version": "latest", "project": "triton"}],
    "llnl-hatchet": [{"version": "latest", "project": "triton"}],
    "matplotlib": [{"version": "latest", "project": "triton"}],
    "pandas": [{"version": "latest", "project": "triton"}],
    "pydot": [{"version": "latest", "project": "triton"}],
    "pyparsing": [{"version": "latest", "project": "triton"}],
    "pytz": [{"version": "latest", "project": "triton"}],
    "textX": [{"version": "latest", "project": "triton"}],
    "tzdata": [{"version": "latest", "project": "triton"}],
    "importlib-metadata": [{"version": "latest", "project": "triton"}],
    "importlib-resources": [{"version": "latest", "project": "triton"}],
    "zipp": [{"version": "latest", "project": "triton"}],
    "aiohttp": [{"version": "latest", "project": "torchtune"}],
    "aiosignal": [{"version": "latest", "project": "torchtune"}],
    "antlr4-python3-runtime": [{"version": "latest", "project": "torchtune"}],
    "attrs": [{"version": "latest", "project": "torchtune"}],
    "blobfile": [{"version": "latest", "project": "torchtune"}],
    "certifi": [{"version": "latest", "project": "torchtune"}],
    "charset-normalizer": [{"version": "latest", "project": "torchtune"}],
    "datasets": [{"version": "latest", "project": "torchtune"}],
    "dill": [{"version": "latest", "project": "torchtune"}],
    "frozenlist": [{"version": "latest", "project": "torchtune"}],
    "huggingface-hub": [{"version": "latest", "project": "torchtune"}],
    "idna": [{"version": "latest", "project": "torchtune"}],
    "lxml": [{"version": "latest", "project": "torchtune"}],
    "markupsafe": [{"version": "latest", "project": "torchtune"}],
    "multidict": [{"version": "latest", "project": "torchtune"}],
    "multiprocess": [{"version": "latest", "project": "torchtune"}],
    "omegaconf": [{"version": "latest", "project": "torchtune"}],
    "pandas": [{"version": "latest", "project": "torchtune"}],
    "pyarrow": [{"version": "latest", "project": "torchtune"}],
    "pyarrow-hotfix": [{"version": "latest", "project": "torchtune"}],
    "pycryptodomex": [{"version": "latest", "project": "torchtune"}],
    "python-dateutil": [{"version": "latest", "project": "torchtune"}],
    "pytz": [{"version": "latest", "project": "torchtune"}],
    "pyyaml": [{"version": "latest", "project": "torchtune"}],
    "regex": [{"version": "latest", "project": "torchtune"}],
    "requests": [{"version": "latest", "project": "torchtune"}],
    "safetensors": [{"version": "latest", "project": "torchtune"}],
    "sentencepiece": [{"version": "latest", "project": "torchtune"}],
    "six": [{"version": "latest", "project": "torchtune"}],
    "tiktoken": [{"version": "latest", "project": "torchtune"}],
    "tqdm": [{"version": "latest", "project": "torchtune"}],
    "tzdata": [{"version": "latest", "project": "torchtune"}],
    "urllib3": [{"version": "latest", "project": "torchtune"}],
    "xxhash": [{"version": "latest", "project": "torchtune"}],
    "yarl": [{"version": "latest", "project": "torchtune"}],
    "dpcpp-cpp-rt": [{"version": "latest", "project": "torch_xpu"}],
    "intel-cmplr-lib-rt": [{"version": "latest", "project": "torch_xpu"}],
    "intel-cmplr-lib-ur": [{"version": "latest", "project": "torch_xpu"}],
    "intel-cmplr-lic-rt": [{"version": "latest", "project": "torch_xpu"}],
    "intel-opencl-rt": [{"version": "latest", "project": "torch_xpu"}],
    "intel-sycl-rt": [{"version": "latest", "project": "torch_xpu"}],
    "intel-openmp": [{"version": "latest", "project": "torch_xpu"}],
    "tcmlib": [{"version": "latest", "project": "torch_xpu"}],
    "umf": [{"version": "latest", "project": "torch_xpu"}],
    "intel-pti": [{"version": "latest", "project": "torch_xpu"}],
    "tbb": [{"version": "latest", "project": "torch_xpu"}],
    "oneccl-devel": [{"version": "latest", "project": "torch_xpu"}],
    "oneccl": [{"version": "latest", "project": "torch_xpu"}],
    "impi-rt": [{"version": "latest", "project": "torch_xpu"}],
    "onemkl-sycl-blas": [{"version": "latest", "project": "torch_xpu"}],
    "onemkl-sycl-dft": [{"version": "latest", "project": "torch_xpu"}],
    "onemkl-sycl-lapack": [{"version": "latest", "project": "torch_xpu"}],
    "onemkl-sycl-sparse": [{"version": "latest", "project": "torch_xpu"}],
    "onemkl-sycl-rng": [{"version": "latest", "project": "torch_xpu"}],
    "mkl": [{"version": "latest", "project": "torch_xpu"}],
}


def download(url: str) -> bytes:
    from urllib.request import urlopen

    with urlopen(url) as conn:
        return conn.read()


def is_stable(package_version: str) -> bool:
    return bool(re.match(r"^([0-9]+\.)+[0-9]+$", package_version))


def parse_simple_idx(url: str) -> Dict[str, str]:
    html = download(url).decode("ascii")
    return {
        name: url
        for (url, name) in re.findall('<a href="([^"]+)"[^>]*>([^>]+)</a>', html)
    }


def get_whl_versions(idx: Dict[str, str]) -> List[str]:
    return [
        k.split("-")[1]
        for k in idx.keys()
        if k.endswith(".whl") and is_stable(k.split("-")[1])
    ]


def get_wheels_of_version(idx: Dict[str, str], version: str) -> Dict[str, str]:
    return {
        k: v
        for (k, v) in idx.items()
        if k.endswith(".whl") and k.split("-")[1] == version
    }


def upload_missing_whls(
    pkg_name: str = "numpy",
    prefix: str = "whl/test",
    *,
    dry_run: bool = False,
    only_pypi: bool = False,
    target_version: str = "latest",
) -> None:
    pypi_idx = parse_simple_idx(f"https://pypi.org/simple/{pkg_name}")
    pypi_versions = get_whl_versions(pypi_idx)

    # Determine which version to use
    if target_version == "latest" or not target_version:
        selected_version = pypi_versions[-1] if pypi_versions else None
    elif target_version in pypi_versions:
        selected_version = target_version
    else:
        print(
            f"Warning: Version {target_version} not found for {pkg_name}, using latest"
        )
        selected_version = pypi_versions[-1] if pypi_versions else None

    if not selected_version:
        print(f"No stable versions found for {pkg_name}")
        return

    pypi_latest_packages = get_wheels_of_version(pypi_idx, selected_version)

    download_latest_packages: Dict[str, str] = {}
    if not only_pypi:
        download_idx = parse_simple_idx(
            f"https://download.pytorch.org/{prefix}/{pkg_name}"
        )
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
        print(f"{pkg_name} is already at version {selected_version} for {prefix}")


def main() -> None:
    from argparse import ArgumentParser

    parser = ArgumentParser("Upload dependent packages to s3://pytorch")
    # Get unique paths from the packages list - now handling list of configs
    project_paths = list(
        set(
            config["project"]
            for pkg_configs in PACKAGES_PER_PROJECT.values()
            for config in pkg_configs
        )
    )
    parser.add_argument("--package", choices=project_paths, default="torch")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--only-pypi", action="store_true")
    parser.add_argument("--include-stable", action="store_true")
    args = parser.parse_args()

    SUBFOLDERS = ["whl/nightly", "whl/test"]
    if args.include_stable:
        SUBFOLDERS.append("whl")

    for prefix in SUBFOLDERS:
        # Process each package and its multiple configurations
        for pkg_name, pkg_configs in PACKAGES_PER_PROJECT.items():
            # Filter configurations by the selected project
            selected_configs = [
                config for config in pkg_configs if config["project"] == args.package
            ]

            # Process each configuration for this package
            for pkg_config in selected_configs:
                if "target" in pkg_config and pkg_config["target"] != "":
                    full_path = f"{prefix}/{pkg_config['target']}"
                else:
                    full_path = f"{prefix}"

                upload_missing_whls(
                    pkg_name,
                    full_path,
                    dry_run=args.dry_run,
                    only_pypi=args.only_pypi,
                    target_version=pkg_config["version"],
                )


if __name__ == "__main__":
    main()
