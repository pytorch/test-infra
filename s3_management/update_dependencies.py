import os
import re
from typing import Dict, List

import boto3  # type: ignore[import-untyped]


S3 = boto3.resource("s3")
CLIENT = boto3.client("s3")
BUCKET = S3.Bucket("pytorch")

# Cloudflare R2 configuration for writing indexes
# Set these environment variables:
# - R2_ACCOUNT_ID
# - R2_ACCESS_KEY_ID
# - R2_SECRET_ACCESS_KEY
# - R2_BUCKET_NAME (e.g., "pytorch-downloads")

R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME", "pytorch-downloads")

# Create R2 client with custom endpoint
R2_BUCKET = None
if R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY:
    R2_CLIENT = boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",  # R2 uses 'auto' as region
    )
    R2_RESOURCE = boto3.resource(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )
    R2_BUCKET = R2_RESOURCE.Bucket(R2_BUCKET_NAME)
    print(
        f"INFO: Will upload indexes to both S3 'pytorch' bucket and R2 '{R2_BUCKET_NAME}' bucket"
    )
else:
    print("WARNING: R2 credentials not configured, will only upload to S3")

PACKAGES_PER_PROJECT: Dict[str, List[Dict[str, str]]] = {
    "sympy": [{"project": "torch"}],
    "mpmath": [{"project": "torch"}],
    "pillow": [{"project": "torch"}],
    "networkx": [{"project": "torch"}],
    "numpy": [{"project": "torch"}],
    "jinja2": [{"project": "torch"}],
    "filelock": [{"project": "torch"}],
    "fsspec": [{"project": "torch"}],
    "nvidia-cudnn-cu11": [{"project": "torch"}],
    "typing-extensions": [{"project": "torch"}],
    "cuda-bindings": [
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
        {
            "project": "vllm",
        },
    ],
    "nvidia-cuda-nvrtc-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cuda-nvrtc": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-cuda-runtime-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cuda-runtime": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-cuda-cupti-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cuda-cupti": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-cudnn-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cudnn-cu13": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-cublas-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cublas": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-cufft-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cufft": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-curand-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-curand": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-cusolver-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cusolver": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-cusparse-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cusparse": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-cusparselt-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cusparselt-cu13": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-nccl-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-nccl-cu13": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-nvshmem-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-nvshmem-cu13": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-cuda-cccl-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cuda-cccl": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-nvtx-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-nvtx": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-nvjitlink-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-nvjitlink": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "nvidia-cufile-cu12": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu126",
        },
        {
            "project": "torch",
            "target": "cu128",
        },
        {
            "project": "torch",
            "target": "cu129",
        },
    ],
    "nvidia-cufile": [
        {
            "project": "torch",
        },
        {
            "project": "torch",
            "target": "cu130",
        },
    ],
    "arpeggio": [{"project": "triton"}],
    "caliper-reader": [{"project": "triton"}],
    "contourpy": [{"project": "triton"}],
    "cycler": [{"project": "triton"}],
    "dill": [{"project": "triton"}],
    "fonttools": [{"project": "triton"}],
    "kiwisolver": [{"project": "triton"}],
    "llnl-hatchet": [{"project": "triton"}],
    "matplotlib": [{"project": "triton"}],
    "pandas": [{"project": "triton"}],
    "pydot": [{"project": "triton"}],
    "pyparsing": [{"project": "triton"}],
    "pytz": [{"project": "triton"}],
    "textX": [{"project": "triton"}],
    "tzdata": [{"project": "triton"}],
    "importlib-metadata": [{"project": "triton"}],
    "importlib-resources": [{"project": "triton"}],
    "zipp": [{"project": "triton"}],
    "aiohttp": [{"project": "torchtune"}],
    "aiosignal": [{"project": "torchtune"}],
    "antlr4-python3-runtime": [{"project": "torchtune"}],
    "attrs": [{"project": "torchtune"}],
    "blobfile": [{"project": "torchtune"}],
    "certifi": [{"project": "torchtune"}],
    "charset-normalizer": [{"project": "torchtune"}],
    "datasets": [{"project": "torchtune"}],
    "frozenlist": [{"project": "torchtune"}],
    "huggingface-hub": [{"project": "torchtune"}],
    "idna": [{"project": "torchtune"}],
    "lxml": [{"project": "torchtune"}],
    "markupsafe": [{"project": "torchtune"}],
    "multidict": [{"project": "torchtune"}],
    "multiprocess": [{"project": "torchtune"}],
    "omegaconf": [{"project": "torchtune"}],
    "pyarrow": [{"project": "torchtune"}],
    "pyarrow-hotfix": [{"project": "torchtune"}],
    "pycryptodomex": [{"project": "torchtune"}],
    "python-dateutil": [{"project": "torchtune"}],
    "pyyaml": [{"project": "torchtune"}],
    "regex": [{"project": "torchtune"}],
    "requests": [{"project": "torchtune"}],
    "safetensors": [{"project": "torchtune"}],
    "sentencepiece": [{"project": "torchtune"}],
    "six": [{"project": "torchtune"}],
    "tiktoken": [{"project": "torchtune"}],
    "tqdm": [{"project": "torchtune"}],
    "urllib3": [{"project": "torchtune"}],
    "xxhash": [{"project": "torchtune"}],
    "yarl": [{"project": "torchtune"}],
    "dpcpp-cpp-rt": [{"project": "torch_xpu", "target": "xpu"}],
    "intel-cmplr-lib-rt": [{"project": "torch_xpu", "target": "xpu"}],
    "intel-cmplr-lib-ur": [{"project": "torch_xpu", "target": "xpu"}],
    "intel-cmplr-lic-rt": [{"project": "torch_xpu", "target": "xpu"}],
    "intel-opencl-rt": [{"project": "torch_xpu", "target": "xpu"}],
    "intel-sycl-rt": [{"project": "torch_xpu", "target": "xpu"}],
    "intel-openmp": [{"project": "torch_xpu", "target": "xpu"}],
    "tcmlib": [{"project": "torch_xpu", "target": "xpu"}],
    "umf": [{"project": "torch_xpu", "target": "xpu"}],
    "intel-pti": [{"project": "torch_xpu", "target": "xpu"}],
    "tbb": [{"project": "torch_xpu", "target": "xpu"}],
    "oneccl-devel": [{"project": "torch_xpu", "target": "xpu"}],
    "oneccl": [{"project": "torch_xpu", "target": "xpu"}],
    "impi-rt": [{"project": "torch_xpu", "target": "xpu"}],
    "onemkl-sycl-blas": [{"project": "torch_xpu", "target": "xpu"}],
    "onemkl-sycl-dft": [{"project": "torch_xpu", "target": "xpu"}],
    "onemkl-sycl-lapack": [{"project": "torch_xpu", "target": "xpu"}],
    "onemkl-sycl-sparse": [{"project": "torch_xpu", "target": "xpu"}],
    "onemkl-sycl-rng": [{"project": "torch_xpu", "target": "xpu"}],
    "onemkl-license": [{"project": "torch_xpu", "target": "xpu"}],
    "mkl": [{"project": "torch_xpu", "target": "xpu"}],
    "pyelftools": [{"project": "torch_xpu", "target": "xpu"}],
    # vLLM
    "ninja": [{"project": "vllm"}],
    "cuda-python": [{"project": "vllm"}],
    "cuda-pathfinder": [{"project": "vllm"}],
    "pynvml": [{"project": "vllm"}],
    "nvidia-ml-py": [{"project": "vllm"}],
    "einops": [{"project": "vllm"}],
    "packaging": [{"project": "vllm"}],
    "nvidia-cudnn-frontend": [{"project": "vllm"}],
    "cachetools": [{"project": "vllm"}],
    "blake3": [{"project": "vllm"}],
    "py-cpuinfo": [{"project": "vllm"}],
    "transformers": [{"project": "vllm"}],
    "hf-xet": [{"project": "vllm"}],
    "tokenizers": [{"project": "vllm"}],
    "protobuf": [{"project": "vllm"}],
    "fastapi": [{"project": "vllm"}],
    "annotated-types": [{"project": "vllm"}],
    "anyio": [{"project": "vllm"}],
    "pydantic": [{"project": "vllm"}],
    "pydantic-core": [{"project": "vllm"}],
    "sniffio": [{"project": "vllm"}],
    "starlette": [{"project": "vllm"}],
    "typing-inspection": [{"project": "vllm"}],
    "openai": [{"project": "vllm"}],
    "distro": [{"project": "vllm"}],
    "h11": [{"project": "vllm"}],
    "httpcore": [{"project": "vllm"}],
    "httpx": [{"project": "vllm"}],
    "jiter": [{"project": "vllm"}],
    "prometheus-client": [{"project": "vllm"}],
    "prometheus-fastapi-instrumentator": [{"project": "vllm"}],
    "lm-format-enforcer": [{"project": "vllm"}],
    "interegular": [{"project": "vllm"}],
    "llguidance": [{"project": "vllm"}],
    "outlines-core": [{"project": "vllm"}],
    "diskcache": [{"project": "vllm"}],
    "lark": [{"project": "vllm"}],
    "xgrammar": [{"project": "vllm"}],
    "partial-json-parser": [{"project": "vllm"}],
    "pyzmq": [{"project": "vllm"}],
    "msgspec": [{"project": "vllm"}],
    "gguf": [{"project": "vllm"}],
    "mistral-common": [{"project": "vllm"}],
    "rpds-py": [{"project": "vllm"}],
    "pycountry": [{"project": "vllm"}],
    "referencing": [{"project": "vllm"}],
    "pydantic-extra-types": [{"project": "vllm"}],
    "jsonschema-specifications": [{"project": "vllm"}],
    "jsonschema": [{"project": "vllm"}],
    "opencv-python-headless": [{"project": "vllm"}],
    "compressed-tensors": [{"project": "vllm"}],
    "frozendict": [{"project": "vllm"}],
    "depyf": [{"project": "vllm"}],
    "astor": [{"project": "vllm"}],
    "cloudpickle": [{"project": "vllm"}],
    "watchfiles": [{"project": "vllm"}],
    "python-json-logger": [{"project": "vllm"}],
    "scipy": [{"project": "vllm"}],
    "pybase64": [{"project": "vllm"}],
    "cbor2": [{"project": "vllm"}],
    "setproctitle": [{"project": "vllm"}],
    "openai-harmony": [{"project": "vllm"}],
    "numba": [{"project": "vllm"}],
    "llvmlite": [{"project": "vllm"}],
    "ray": [{"project": "vllm"}],
    "click": [{"project": "vllm"}],
    "msgpack": [{"project": "vllm"}],
    "fastapi-cli": [{"project": "vllm"}],
    "httptools": [{"project": "vllm"}],
    "markdown-it-py": [{"project": "vllm"}],
    "pygments": [{"project": "vllm"}],
    "python-dotenv": [{"project": "vllm"}],
    "rich": [{"project": "vllm"}],
    "rich-toolkit": [{"project": "vllm"}],
    "shellingham": [{"project": "vllm"}],
    "typer": [{"project": "vllm"}],
    "uvicorn": [{"project": "vllm"}],
    "uvloop": [{"project": "vllm"}],
    "websockets": [{"project": "vllm"}],
    "python-multipart": [{"project": "vllm"}],
    "email-validator": [{"project": "vllm"}],
    "dnspython": [{"project": "vllm"}],
    "fastapi-cloud-cli": [{"project": "vllm"}],
    "mdurl": [{"project": "vllm"}],
    "rignore": [{"project": "vllm"}],
    "sentry-sdk": [{"project": "vllm"}],
    "cupy-cuda12x": [{"project": "vllm"}],
    "fastrlock": [{"project": "vllm"}],
    "soundfile": [{"project": "vllm"}],
    "cffi": [{"project": "vllm"}],
    "pycparser": [{"project": "vllm"}],
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
    if not base_url.endswith("/"):
        base_url += "/"

    # Pattern to match href attributes with relative URLs (not starting with http:// or https://)
    def replace_href(match):
        full_match = match.group(0)
        url = match.group(1)

        # If URL is already absolute, don't modify it
        if (
            url.startswith("http://")
            or url.startswith("https://")
            or url.startswith("//")
        ):
            return full_match

        # Remove leading ./ or /
        url = url.lstrip("./")
        url = url.lstrip("/")

        # Replace with absolute URL
        return f'href="{base_url}{url}"'

    # Replace href="..." patterns
    html = re.sub(r'href="([^"]+)"', replace_href, html)

    return html


def parse_simple_idx(url: str) -> tuple[Dict[str, str], str]:
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
    """Upload modified index.html to S3 and R2 with absolute links"""
    # Replace relative links with absolute links
    modified_html = replace_relative_links_with_absolute(html, base_url)

    index_key = f"{prefix}/{pkg_name}/index.html"

    if dry_run:
        print(f"Dry Run - not uploading index.html to s3://pytorch/{index_key}")
        if R2_BUCKET:
            print(
                f"Dry Run - not uploading index.html to R2 bucket {R2_BUCKET.name}/{index_key}"
            )
        return

    # Upload to S3
    print(f"Uploading index.html to s3://pytorch/{index_key}")
    BUCKET.Object(key=index_key).put(
        ACL="public-read",
        ContentType="text/html",
        CacheControl="no-cache,no-store,must-revalidate",
        Body=modified_html.encode("utf-8"),
    )

    # Upload to R2 if configured
    if R2_BUCKET:
        print(f"Uploading index.html to R2 bucket {R2_BUCKET.name}/{index_key}")
        R2_BUCKET.Object(key=index_key).put(
            ACL="public-read",
            ContentType="text/html",
            CacheControl="no-cache,no-store,must-revalidate",
            Body=modified_html.encode("utf-8"),
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

    print(
        f"Processing {pkg_name} using {'NVIDIA' if is_nvidia else 'PyPI'} Simple Index: {source_url}"
    )

    # Parse the index and get raw HTML
    try:
        _, raw_html = parse_simple_idx(source_url)
    except Exception as e:
        print(f"Error fetching package {pkg_name}: {e}")
        return

    # Upload modified index.html with absolute links
    upload_index_html(pkg_name, prefix, raw_html, source_url, dry_run=dry_run)

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
                    pkg_name, full_path, dry_run=args.dry_run
                )


if __name__ == "__main__":
    main()
