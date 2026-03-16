import os
import re
import time
from typing import Dict, List

import boto3  # type: ignore[import-untyped]


S3 = boto3.resource("s3")
CLIENT = boto3.client("s3")
BUCKET = S3.Bucket("pytorch")

# Valid target patterns for validation
VALID_TARGET_PATTERNS = [
    r"^cu[0-9]+$",  # CUDA: cu118, cu121, cu126, cu128, cu129, cu130, cuXYZ
    r"^rocm[0-9]+\.[0-9]+$",  # ROCm: rocm5.7, rocm6.0, rocm6.4, rocm7.1, rocm7.2
]

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
            "project": "torch",
            "target": "cu132",
        },
        {
            "project": "vllm",
        },
    ],
    "cuda-toolkit": [
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
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
        {
            "project": "torch",
            "target": "cu132",
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
    return pkg_name.startswith("nvidia-") or pkg_name.startswith("cuda-")


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


def is_valid_target(target: str) -> bool:
    """Check if a target name is valid (matches expected patterns)."""
    for pattern in VALID_TARGET_PATTERNS:
        if re.match(pattern, target):
            return True
    return False


def get_packages_for_target(target: str) -> List[str]:
    """
    Get packages from PACKAGES_PER_PROJECT that should be initialized for a target.

    Returns packages where:
    - project is "torch" AND
    - either no target is specified (universal packages like filelock, numpy)
    - or the target matches the specified target
    - nvidia/cuda packages are only included for CUDA targets (cu*)
    """
    is_cuda_target = target.startswith("cu")
    packages = []
    for pkg_name, pkg_configs in PACKAGES_PER_PROJECT.items():
        # Skip nvidia/cuda packages for non-CUDA targets
        if not is_cuda_target and is_nvidia_package(pkg_name):
            continue

        for config in pkg_configs:
            if config.get("project") != "torch":
                continue
            pkg_target = config.get("target", "")
            # Include if no target specified (universal) or target matches
            if pkg_target == "" or pkg_target == target:
                if pkg_name not in packages:
                    packages.append(pkg_name)
                break
    return packages


def target_exists(prefix: str, target: str) -> bool:
    """Check if a target directory already exists in S3."""
    target_path = f"{prefix}/{target}/"

    # Check if any objects exist with this prefix
    response = CLIENT.list_objects_v2(
        Bucket="pytorch",
        Prefix=target_path,
        MaxKeys=1,
    )

    return response.get("KeyCount", 0) > 0


def generate_packages_index_html(packages: List[str]) -> str:
    """Generate a PEP 503 simple index listing packages."""
    lines = [
        "<!DOCTYPE html>",
        "<html>",
        "  <body>",
    ]
    for pkg in sorted(packages):
        pkg_normalized = pkg.lower().replace("_", "-")
        lines.append(f'    <a href="{pkg_normalized}/">{pkg_normalized}</a><br/>')
    lines.append("  </body>")
    lines.append("</html>")
    lines.append(f"<!--TIMESTAMP {int(time.time())}-->")
    return "\n".join(lines)


def copy_target(
    prefix: str,
    source: str,
    target: str,
    *,
    dry_run: bool = False,
) -> bool:
    """
    Initialize a new target by copying all folders and index.html from an existing source target.

    Only copies package subdirectory index files (second level), not the top-level index.html.
    For example: copy_target("whl/nightly", "cu130", "cu132") copies
    whl/nightly/cu130/filelock/index.html -> whl/nightly/cu132/filelock/index.html
    whl/nightly/cu130/numpy/index.html -> whl/nightly/cu132/numpy/index.html
    but NOT whl/nightly/cu130/index.html

    Args:
        prefix: The base prefix (e.g., "whl/nightly")
        source: The source target name (e.g., "cu130")
        target: The destination target name (e.g., "cu132")
        dry_run: If True, don't actually copy anything

    Returns:
        True if target was created, False otherwise
    """
    if not is_valid_target(target):
        print(f"ERROR: Invalid target name '{target}'")
        print(f"Valid patterns: {VALID_TARGET_PATTERNS}")
        return False

    if not is_valid_target(source):
        print(f"ERROR: Invalid source name '{source}'")
        print(f"Valid patterns: {VALID_TARGET_PATTERNS}")
        return False

    source_path = f"{prefix}/{source}/"
    target_path = f"{prefix}/{target}"

    # Check source exists
    if not dry_run and not target_exists(prefix, source):
        print(f"ERROR: Source '{prefix}/{source}' does not exist in S3.")
        return False

    # Warn if target already exists but continue anyway
    if not dry_run and target_exists(prefix, target):
        print(f"WARNING: Target '{target_path}' already exists, will copy into it.")

    print(
        f"{'[DRY RUN] ' if dry_run else ''}Copying {prefix}/{source} -> {target_path}"
    )

    # List all objects under the source path, only copying files in subdirectories
    # (e.g., cu130/filelock/index.html) and skipping any files directly in the
    # source root (e.g., cu130/index.html). Also skip .whl and .zip binary artifacts.
    copied_count = 0
    skipped_count = 0
    paginator = CLIENT.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket="pytorch", Prefix=source_path):
        for obj in page.get("Contents", []):
            source_key = obj["Key"]
            # Get the relative path after the source prefix
            relative_path = source_key[len(source_path) :]
            # Only copy files in subdirectories (must contain a /)
            # Skip any files directly in the source root like index.html
            if "/" not in relative_path:
                print(f"  Skipping root-level file: {source_key}")
                continue
            # Skip .whl and .zip files - only copy subfolder index files
            if source_key.endswith(".whl") or source_key.endswith(".zip"):
                skipped_count += 1
                print(f"  Skipping binary artifact: {source_key}")
                continue
            # Replace source target with destination target in the key
            dest_key = source_key.replace(source_path, f"{target_path}/", 1)

            if dry_run:
                print(f"  [DRY RUN] Would copy: {source_key} -> {dest_key}")
            else:
                print(f"  Copying: {source_key} -> {dest_key}")
                CLIENT.copy_object(
                    Bucket="pytorch",
                    CopySource={"Bucket": "pytorch", "Key": source_key},
                    Key=dest_key,
                    ACL="public-read",
                )

                # Also copy to R2 if configured
                if R2_BUCKET:
                    print(f"  Copying to R2: {source_key} -> {dest_key}")
                    # Download from S3 and upload to R2 (cross-service copy)
                    response = CLIENT.get_object(Bucket="pytorch", Key=source_key)
                    body = response["Body"].read()
                    content_type = response.get("ContentType", "text/html")
                    R2_BUCKET.Object(key=dest_key).put(
                        ACL="public-read",
                        ContentType=content_type,
                        CacheControl="no-cache,no-store,must-revalidate",
                        Body=body,
                    )

            copied_count += 1

    print(
        f"{'[DRY RUN] ' if dry_run else ''}"
        f"Successfully copied {copied_count} objects from {prefix}/{source} to {target_path}"
        f" (skipped {skipped_count} .whl/.zip files)"
    )
    return True


def create_target(
    prefix: str,
    target: str,
    *,
    dry_run: bool = False,
) -> bool:
    """
    Create a new target directory with torch dependencies from PACKAGES_PER_PROJECT.

    Args:
        prefix: The base prefix (e.g., "whl/nightly")
        target: The target name (e.g., "rocm7.2", "cu130")
        dry_run: If True, don't actually upload anything

    Returns:
        True if target was created, False otherwise
    """
    if not is_valid_target(target):
        print(f"ERROR: Invalid target name '{target}'")
        print(f"Valid patterns: {VALID_TARGET_PATTERNS}")
        return False

    target_path = f"{prefix}/{target}"

    # Check if target already exists (skip check in dry-run mode)
    if not dry_run and target_exists(prefix, target):
        print(f"Target '{target_path}' already exists.")
        return False

    print(f"{'[DRY RUN] ' if dry_run else ''}Creating new target: {target_path}")

    # Get packages from PACKAGES_PER_PROJECT for this target
    packages = get_packages_for_target(target)
    print(
        f"{'[DRY RUN] ' if dry_run else ''}"
        f"Initializing with {len(packages)} packages from PACKAGES_PER_PROJECT"
    )

    # Create package directories with index.html
    created_packages = []
    for pkg_name in packages:
        if dry_run:
            print(f"  [DRY RUN] Would create: {target_path}/{pkg_name}/index.html")
        # Fetch from PyPI/NVIDIA and upload
        upload_package_using_simple_index(pkg_name, target_path, dry_run=dry_run)
        created_packages.append(pkg_name)

    # Create the main index.html for the target directory
    target_index_html = generate_packages_index_html(created_packages)
    target_index_key = f"{target_path}/index.html"

    # Use upload_index_html with target as pkg_name to upload to {prefix}/{target}/index.html
    upload_index_html(target, prefix, target_index_html, "", dry_run=dry_run)

    print(
        f"{'[DRY RUN] ' if dry_run else ''}Successfully created target: {target_path}"
    )
    print(
        f"  - {'Would create' if dry_run else 'Created'} "
        f"{len(created_packages)} package index files"
    )
    print(
        f"  - {'Would create' if dry_run else 'Created'} "
        f"main index.html at {target_index_key}"
    )

    return True


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

    # Existing arguments
    parser.add_argument("--package", choices=project_paths, default="torch")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--include-stable", action="store_true")

    # Arguments for target creation
    parser.add_argument(
        "--target",
        type=str,
        help="Specific target to operate on (e.g., rocm7.2, cu130)",
    )
    parser.add_argument(
        "--create-target",
        action="store_true",
        help="Create a new target directory with torch dependencies",
    )
    parser.add_argument(
        "--init-from",
        type=str,
        help="Initialize a new target by copying all folders and index.html from an existing source target "
        "(e.g., --init-from cu130 --target cu132 copies whl/nightly/cu130/* -> whl/nightly/cu132/*)",
    )
    parser.add_argument(
        "--prefix",
        type=str,
        default="whl/nightly",
        help="Base prefix for target operations (default: whl/nightly)",
    )

    args = parser.parse_args()

    # Handle init-from mode (copy source target to new target)
    if args.init_from:
        if not args.target:
            print("ERROR: --target is required when using --init-from")
            return

        copy_target(
            args.prefix,
            args.init_from,
            args.target,
            dry_run=args.dry_run,
        )
        return

    # Handle target creation mode
    if args.create_target:
        if not args.target:
            print("ERROR: --target is required when using --create-target")
            return

        create_target(
            args.prefix,
            args.target,
            dry_run=args.dry_run,
        )
        return

    # Original behavior: update all dependencies for specified package
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
