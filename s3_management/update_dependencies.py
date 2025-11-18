import re
from typing import Dict, List

import boto3  # type: ignore[import-untyped]


S3 = boto3.resource("s3")
CLIENT = boto3.client("s3")
BUCKET = S3.Bucket("pytorch")

PACKAGES_PER_PROJECT: Dict[str, List[Dict[str, str]]] = {
    "sympy": [{"version": "latest", "project": "torch"}],
    "mpmath": [{"version": "latest", "project": "torch"}],
    "pillow": [{"version": "latest", "project": "torch"}],
    "networkx": [{"version": "latest", "project": "torch"}],
    "numpy": [{"version": "latest", "project": "torch"}],
    "jinja2": [{"version": "latest", "project": "torch"}],
    "filelock": [{"version": "latest", "project": "torch"}],
    "fsspec": [{"version": "latest", "project": "torch"}],
    "nvidia-cudnn-cu11": [{"version": "latest", "project": "torch"}],
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
            "version": "13.0.88",
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
            "version": "13.0.96",
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
            "version": "13.0.85",
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
            "version": "9.10.2.21",
            "project": "torch",
            "target": "cu129",
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
            "version": "13.1.0.3",
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
            "version": "12.0.0.61",
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
            "version": "10.4.0.42",
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
            "version": "12.0.4.66",
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
            "version": "12.6.3.3",
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
        {
            "version": "0.7.1",
            "project": "torch",
            "target": "cu129",
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
        {
            "version": "2.27.5",
            "project": "torch",
            "target": "cu129",
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
            "version": "3.4.5",
            "project": "torch",
            "target": "cu126",
        },
        {
            "version": "3.4.5",
            "project": "torch",
            "target": "cu128",
        },
        {
            "version": "3.4.5",
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-nvshmem-cu13": [
        {
            "version": "3.4.5",
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
            "version": "13.0.85",
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
            "version": "13.0.88",
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
            "version": "1.15.1.6",
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
    "frozenlist": [{"version": "latest", "project": "torchtune"}],
    "huggingface-hub": [{"version": "latest", "project": "torchtune"}],
    "idna": [{"version": "latest", "project": "torchtune"}],
    "lxml": [{"version": "latest", "project": "torchtune"}],
    "markupsafe": [{"version": "latest", "project": "torchtune"}],
    "multidict": [{"version": "latest", "project": "torchtune"}],
    "multiprocess": [{"version": "latest", "project": "torchtune"}],
    "omegaconf": [{"version": "latest", "project": "torchtune"}],
    "pyarrow": [{"version": "latest", "project": "torchtune"}],
    "pyarrow-hotfix": [{"version": "latest", "project": "torchtune"}],
    "pycryptodomex": [{"version": "latest", "project": "torchtune"}],
    "python-dateutil": [{"version": "latest", "project": "torchtune"}],
    "pyyaml": [{"version": "latest", "project": "torchtune"}],
    "regex": [{"version": "latest", "project": "torchtune"}],
    "requests": [{"version": "latest", "project": "torchtune"}],
    "safetensors": [{"version": "latest", "project": "torchtune"}],
    "sentencepiece": [{"version": "latest", "project": "torchtune"}],
    "six": [{"version": "latest", "project": "torchtune"}],
    "tiktoken": [{"version": "latest", "project": "torchtune"}],
    "tqdm": [{"version": "latest", "project": "torchtune"}],
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
    # vLLM
    "ninja": [{"version": "latest", "project": "vllm"}],
    "cuda-python": [{"version": "12.9.0", "project": "vllm"}],
    "cuda-bindings": [{"version": "12.9.2", "project": "vllm"}],
    "cuda-pathfinder": [{"version": "latest", "project": "vllm"}],
    "pynvml": [{"version": "latest", "project": "vllm"}],
    "nvidia-ml-py": [{"version": "latest", "project": "vllm"}],
    "einops": [{"version": "latest", "project": "vllm"}],
    "packaging": [{"version": "latest", "project": "vllm"}],
    "nvidia-cudnn-frontend": [{"version": "latest", "project": "vllm"}],
    "cachetools": [{"version": "latest", "project": "vllm"}],
    "blake3": [{"version": "latest", "project": "vllm"}],
    "py-cpuinfo": [{"version": "latest", "project": "vllm"}],
    "transformers": [{"version": "latest", "project": "vllm"}],
    "hf-xet": [{"version": "latest", "project": "vllm"}],
    "tokenizers": [{"version": "latest", "project": "vllm"}],
    "protobuf": [{"version": "latest", "project": "vllm"}],
    "fastapi": [{"version": "latest", "project": "vllm"}],
    "annotated-types": [{"version": "latest", "project": "vllm"}],
    "anyio": [{"version": "latest", "project": "vllm"}],
    "pydantic": [{"version": "latest", "project": "vllm"}],
    "pydantic-core": [{"version": "2.33.2", "project": "vllm"}],
    "sniffio": [{"version": "latest", "project": "vllm"}],
    "starlette": [{"version": "latest", "project": "vllm"}],
    "typing-inspection": [{"version": "latest", "project": "vllm"}],
    "openai": [{"version": "latest", "project": "vllm"}],
    "distro": [{"version": "latest", "project": "vllm"}],
    "h11": [{"version": "latest", "project": "vllm"}],
    "httpcore": [{"version": "latest", "project": "vllm"}],
    "httpx": [{"version": "latest", "project": "vllm"}],
    "jiter": [{"version": "latest", "project": "vllm"}],
    "prometheus-client": [{"version": "latest", "project": "vllm"}],
    "prometheus-fastapi-instrumentator": [{"version": "latest", "project": "vllm"}],
    "lm-format-enforcer": [{"version": "latest", "project": "vllm"}],
    "interegular": [{"version": "latest", "project": "vllm"}],
    "llguidance": [{"version": "0.7.11", "project": "vllm"}],
    "outlines-core": [{"version": "0.2.10", "project": "vllm"}],
    "diskcache": [{"version": "latest", "project": "vllm"}],
    "lark": [{"version": "latest", "project": "vllm"}],
    "xgrammar": [{"version": "0.1.23", "project": "vllm"}],
    "partial-json-parser": [{"version": "latest", "project": "vllm"}],
    "pyzmq": [{"version": "latest", "project": "vllm"}],
    "msgspec": [{"version": "latest", "project": "vllm"}],
    "gguf": [{"version": "latest", "project": "vllm"}],
    "mistral-common": [{"version": "latest", "project": "vllm"}],
    "rpds-py": [{"version": "latest", "project": "vllm"}],
    "pycountry": [{"version": "latest", "project": "vllm"}],
    "referencing": [{"version": "latest", "project": "vllm"}],
    "pydantic-extra-types": [{"version": "latest", "project": "vllm"}],
    "jsonschema-specifications": [{"version": "latest", "project": "vllm"}],
    "jsonschema": [{"version": "latest", "project": "vllm"}],
    "opencv-python-headless": [{"version": "latest", "project": "vllm"}],
    "compressed-tensors": [{"version": "latest", "project": "vllm"}],
    "frozendict": [{"version": "latest", "project": "vllm"}],
    "depyf": [{"version": "latest", "project": "vllm"}],
    "astor": [{"version": "latest", "project": "vllm"}],
    "cloudpickle": [{"version": "latest", "project": "vllm"}],
    "watchfiles": [{"version": "latest", "project": "vllm"}],
    "python-json-logger": [{"version": "latest", "project": "vllm"}],
    "scipy": [{"version": "latest", "project": "vllm"}],
    "pybase64": [{"version": "latest", "project": "vllm"}],
    "cbor2": [{"version": "latest", "project": "vllm"}],
    "setproctitle": [{"version": "latest", "project": "vllm"}],
    "openai-harmony": [{"version": "latest", "project": "vllm"}],
    "numba": [{"version": "0.61.2", "project": "vllm"}],
    "llvmlite": [{"version": "latest", "project": "vllm"}],
    "ray": [{"version": "latest", "project": "vllm"}],
    "click": [{"version": "latest", "project": "vllm"}],
    "msgpack": [{"version": "latest", "project": "vllm"}],
    "fastapi-cli": [{"version": "latest", "project": "vllm"}],
    "httptools": [{"version": "latest", "project": "vllm"}],
    "markdown-it-py": [{"version": "latest", "project": "vllm"}],
    "pygments": [{"version": "latest", "project": "vllm"}],
    "python-dotenv": [{"version": "latest", "project": "vllm"}],
    "rich": [{"version": "latest", "project": "vllm"}],
    "rich-toolkit": [{"version": "latest", "project": "vllm"}],
    "shellingham": [{"version": "latest", "project": "vllm"}],
    "typer": [{"version": "latest", "project": "vllm"}],
    "uvicorn": [{"version": "latest", "project": "vllm"}],
    "uvloop": [{"version": "latest", "project": "vllm"}],
    "websockets": [{"version": "latest", "project": "vllm"}],
    "python-multipart": [{"version": "latest", "project": "vllm"}],
    "email-validator": [{"version": "latest", "project": "vllm"}],
    "dnspython": [{"version": "2.7.0", "project": "vllm"}],
    "fastapi-cloud-cli": [{"version": "latest", "project": "vllm"}],
    "mdurl": [{"version": "latest", "project": "vllm"}],
    "rignore": [{"version": "latest", "project": "vllm"}],
    "sentry-sdk": [{"version": "latest", "project": "vllm"}],
    "cupy-cuda12x": [{"version": "latest", "project": "vllm"}],
    "fastrlock": [{"version": "latest", "project": "vllm"}],
    "soundfile": [{"version": "latest", "project": "vllm"}],
    "cffi": [{"version": "latest", "project": "vllm"}],
    "pycparser": [{"version": "latest", "project": "vllm"}],
}


def is_nvidia_package(pkg_name: str) -> bool:
    """Check if a package is from NVIDIA and should use pypi.nvidia.com"""
    return pkg_name.startswith("nvidia-")


def get_package_source_url(pkg_name: str) -> str:
    """Get the source URL for a package based on its type"""
    if is_nvidia_package(pkg_name):
        return f"https://pypi.nvidia.com/{pkg_name}/"
    else:
        return f"https://pypi.org/simple/{pkg_name}/"


def download(url: str) -> bytes:
    from urllib.request import urlopen

    with urlopen(url) as conn:
        return conn.read()


def replace_relative_links_with_absolute(html: str, base_url: str) -> str:
    """
    Replace all relative links in HTML with absolute links.

    Args:
        html: HTML content as string
        base_url: Base URL to prepend to relative links

    Returns:
        Modified HTML with absolute links
    """
    # Ensure base_url ends with /
    if not base_url.endswith('/'):
        base_url += '/'

    # Pattern to match href attributes with relative URLs (not starting with http:// or https://)
    def replace_href(match):
        full_match = match.group(0)
        url = match.group(1)

        # If URL is already absolute, don't modify it
        if url.startswith('http://') or url.startswith('https://') or url.startswith('//'):
            return full_match

        # Remove leading ./ or /
        url = url.lstrip('./')
        url = url.lstrip('/')

        # Replace with absolute URL
        return f'href="{base_url}{url}"'

    # Replace href="..." patterns
    html = re.sub(r'href="([^"]+)"', replace_href, html)

    return html


def parse_simple_idx(url: str) -> Tuple[Dict[str, str], str]:
    """
    Parse a simple package index and return package dict and raw HTML.

    Returns:
        Tuple of (package_dict, raw_html)
    """
    html = download(url).decode("utf-8", errors="ignore")
    packages = {
        name: url
        for (url, name) in re.findall('<a href="([^"]+)"[^>]*>([^>]+)</a>', html)
    }
    return packages, html


def upload_index_html(
    pkg_name: str,
    prefix: str,
    html: str,
    base_url: str,
    *,
    dry_run: bool = False,
) -> None:
    """Upload modified index.html to S3 with absolute links"""
    # Replace relative links with absolute links
    modified_html = replace_relative_links_with_absolute(html, base_url)

    index_key = f"{prefix}/{pkg_name}/index.html"

    if dry_run:
        print(f"Dry Run - not uploading index.html to s3://pytorch/{index_key}")
        return

    print(f"Uploading index.html to s3://pytorch/{index_key}")
    BUCKET.Object(key=index_key).put(
        ACL="public-read",
        ContentType="text/html",
        Body=modified_html.encode("utf-8")
    )


def upload_package_using_simple_index(
    pkg_name: str,
    prefix: str,
    *,
    dry_run: bool = False,
) -> None:
    """
    Upload package index.html from PyPI Simple Index.
    Simply copies the index.html with absolute links - no wheel uploads or version filtering.
    Works for both NVIDIA and non-NVIDIA packages.
    """
    source_url = get_package_source_url(pkg_name)
    is_nvidia = is_nvidia_package(pkg_name)

    print(f"Processing {pkg_name} using {'NVIDIA' if is_nvidia else 'PyPI'} Simple Index: {source_url}")

    # Parse the index and get raw HTML
    try:
        _, raw_html = parse_simple_idx(source_url)
    except Exception as e:
        print(f"Error fetching package {pkg_name}: {e}")
        return

    # Upload modified index.html with absolute links
    upload_index_html(
        pkg_name,
        prefix,
        raw_html,
        source_url,
        dry_run=dry_run
    )

    print(f"Successfully processed index.html for {pkg_name}")


def main() -> None:
    from argparse import ArgumentParser

    parser = ArgumentParser("Upload dependent package indexes to s3://pytorch")
    # Get unique paths from the packages list
    project_paths = list(
        {
            config["project"]
            for pkg_configs in PACKAGES_PER_PROJECT.values()
            for config in pkg_configs
        }
    )
    project_paths += ["all"]
    parser.add_argument("--package", choices=project_paths, default="torch")
    parser.add_argument("--dry-run", action="store_true")
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
                config
                for config in pkg_configs
                if args.package == "all" or config["project"] == args.package
            ]

            # Process each configuration for this package
            for pkg_config in selected_configs:
                if "target" in pkg_config and pkg_config["target"] != "":
                    full_path = f"{prefix}/{pkg_config['target']}"
                else:
                    full_path = f"{prefix}"

                upload_package_using_simple_index(
                    pkg_name,
                    full_path,
                    dry_run=args.dry_run
                )


if __name__ == "__main__":
    main()
