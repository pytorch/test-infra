#!/usr/bin/env python

import argparse
import base64
import concurrent.futures
import dataclasses
import functools
import hashlib
import os
import time
from collections import defaultdict
from os import makedirs, path
from re import match, sub
from typing import Dict, Iterable, List, Optional, Set, TypeVar

import boto3  # type: ignore[import]
import botocore  # type: ignore[import]
from packaging.version import InvalidVersion, parse as _parse_version, Version


# S3 client for reading
S3 = boto3.resource("s3")
CLIENT = boto3.client("s3")

# bucket for download.pytorch.org (reading only)
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

ACCEPTED_FILE_EXTENSIONS = ("whl", "zip", "tar.gz", "json")

ACCEPTED_SUBDIR_PATTERNS = [
    r"cu[0-9]+",  # for cuda
    r"rocm[0-9]+\.[0-9]+",  # for rocm
    "cpu",
    "xpu",
]

# These are legacy build todo: delete these
NOT_ACCEPTED_SUBDIR_PATTERNS = [
    "cpu-cxx11-abi",
    "cpu_pypi_pkg",
    "cu[0-9]+_full",
    "cu[0-9]+_pypi_cudnn",
]

PREFIXES = [
    "whl",
    "whl/nightly",
    "whl/test",
    "libtorch",
    "libtorch/nightly",
    "whl/test/variant",
    "whl/variant",
    "whl/preview/forge",
    "source_code/test",
]

# NOTE: This refers to the name on the wheels themselves and not the name of
# package as specified by setuptools, for packages with "-" (hyphens) in their
# names you need to convert them to "_" (underscores) in order for them to be
# allowed here since the name of the wheels is compared here
PACKAGE_ALLOW_LIST = {
    x.lower()
    for x in [
        # ---- torchtune additional packages ----
        "aiohttp",
        "aiosignal",
        "aiohappyeyeballs",
        "antlr4_python3_runtime",
        "antlr4-python3-runtime",
        "async_timeout",
        "attrs",
        "blobfile",
        "datasets",
        "dill",
        "frozenlist",
        "huggingface_hub",
        "llnl_hatchet",
        "lxml",
        "jinja2",
        "multidict",
        "multiprocess",
        "omegaconf",
        "pandas",
        "psutil",
        "pyarrow",
        "pyarrow_hotfix",
        "pycryptodomex",
        "python_dateutil",
        "pytz",
        "PyYAML",
        "regex",
        "safetensors",
        "sentencepiece",
        "six",
        "tiktoken",
        "torchao",
        "torchao_nightly",
        "tzdata",
        "xxhash",
        "yarl",
        "pep_xxx_wheel_variants",
        "nvidia_variant_provider",
        # ---- triton additional packages ----
        "Arpeggio",
        "caliper_reader",
        "contourpy",
        "cycler",
        "dill",
        "fonttools",
        "kiwisolver",
        "llnl-hatchet",
        "matplotlib",
        "pandas",
        "pydot",
        "pyparsing",
        "pytz",
        "textx",
        "tzdata",
        "importlib_metadata",
        "importlib_resources",
        "zipp",
        # ----
        "certifi",
        "charset_normalizer",
        "cmake",
        "colorama",
        "fbgemm_gpu",
        "fbgemm_gpu_genai",
        "idna",
        "iopath",
        "lit",
        "lightning_utilities",
        "MarkupSafe",
        "mypy_extensions",
        "nestedtensor",
        "nvidia_cublas_cu11",
        "nvidia_cuda_cupti_cu11",
        "nvidia_cuda_nvrtc_cu11",
        "nvidia_cuda_runtime_cu11",
        "nvidia_cufft_cu11",
        "nvidia_curand_cu11",
        "nvidia_cusolver_cu11",
        "nvidia_cusparse_cu11",
        "nvidia_nccl_cu11",
        "nvidia_nvtx_cu11",
        "packaging",
        "portalocker",
        "pyre_extensions",
        "pytorch_triton",
        "pytorch_triton_rocm",
        "pytorch_triton_xpu",
        "triton_rocm",
        "triton_xpu",
        "requests",
        "torch_no_python",
        "torch",
        "torch_tensorrt",
        "torcharrow",
        "torchaudio",
        "torchcodec",
        "torchcsprng",
        "torchdata",
        "torchdistx",
        "torchmetrics",
        "torchrec",
        "torchtext",
        "torchtune",
        "torchtitan",
        "torchvision",
        "torchcomms",
        "torchvision_extra_decoders",
        "triton",
        "tqdm",
        "typing_inspect",
        "urllib3",
        "xformers",
        "executorch",
        "setuptools",
        "setuptools_scm",
        "wheel",
        "flash_attn_3",
        # vllm
        "ninja",
        "cuda_python",
        "cuda_bindings",
        "cuda_pathfinder",
        "cuda_toolkit",
        "pynvml",
        "nvidia_ml_py",
        "einops",
        "packaging",
        "nvidia_cudnn_frontend",
        "cachetools",
        "blake3",
        "py_cpuinfo",
        "transformers",
        "hf_xet",
        "tokenizers",
        "protobuf",
        "fastapi",
        "annotated_types",
        "anyio",
        "pydantic",
        "pydantic_core",
        "sniffio",
        "starlette",
        "typing_inspection",
        "openai",
        "distro",
        "h11",
        "httpcore",
        "httpx",
        "jiter",
        "prometheus_client",
        "prometheus_fastapi_instrumentator",
        "lm_format_enforcer",
        "interegular",
        "llguidance",
        "outlines_core",
        "diskcache",
        "lark",
        "xgrammar",
        "partial_json_parser",
        "pyzmq",
        "msgspec",
        "gguf",
        "mistral_common",
        "rpds_py",
        "pycountry",
        "referencing",
        "pydantic_extra_types",
        "jsonschema_specifications",
        "jsonschema",
        "opencv_python_headless",
        "compressed_tensors",
        "frozendict",
        "depyf",
        "astor",
        "cloudpickle",
        "watchfiles",
        "python_json_logger",
        "scipy",
        "pybase64",
        "cbor2",
        "setproctitle",
        "openai_harmony",
        "numba",
        "llvmlite",
        "ray",
        "click",
        "msgpack",
        "fastapi_cli",
        "fastapi_cloud_cli",
        "httptools",
        "markdown_it_py",
        "pygments",
        "python_dotenv",
        "rich",
        "rich_toolkit",
        "shellingham",
        "typer",
        "uvicorn",
        "uvloop",
        "websockets",
        "python_multipart",
        "email_validator",
        "dnspython",
        "mdurl",
        "rignore",
        "sentry_sdk",
        "cupy_cuda12x",
        "fastrlock",
        "soundfile",
        "cffi",
        "pycparser",
        "vllm",
        "flashinfer_python",
        # ---- forge additional packages ----
        "absl_py",
        "annotated_types",
        "docker",
        "docstring_parser",
        "exceptiongroup",
        "torchforge",
        "gitdb",
        "GitPython",
        "grpcio",
        "hf_transfer",
        "Markdown",
        "MarkupSafe",
        "monarch",
        "opentelemetry_api",
        "pip",
        "platformdirs",
        "propcache",
        "Pygments",
        "pygtrie",
        "rignore",
        "shtab",
        "smmap",
        "soxr",
        "tabulate",
        "tensorboard",
        "tensorboard_data_server",
        "tomli",
        "torchshow",
        "torchstore",
        "torchx_nightly",
        "tqdm",
        "transformers",
        "typeguard",
        "tyro",
        "wandb",
        "Werkzeug",
        "yarl",
        "zipp",
        "mslk",
    ]
}

# PyTorch foundation packages and required dependencies
# such as triton that should use relative URLs
# All other packages will use CloudFront absolute URLs
PT_FOUNDATION_PACKAGES = {
    "torch",
    "torchaudio",
    "torchvision",
    "fbgemm_gpu",
    "fbgemm_gpu_genai",
    "triton",
    "pytorch_triton",
    "pytorch_triton_rocm",
    "pytorch_triton_xpu",
}

# Packages that should use R2 (download-r2.pytorch.org) for nightly builds
# These packages will have their URLs point to R2 instead of S3/CloudFront
# when the path is whl/nightly
PT_R2_PACKAGES = {
    "torch",
    "torchaudio",
    "torchvision",
    "fbgemm_gpu",
    "fbgemm_gpu_genai",
    "triton",
    "triton_xpu",
    "triton_rocm",
    "pytorch_triton",
    "pytorch_triton_rocm",
    "pytorch_triton_xpu",
}

# Packages that should use R2 (download-r2.pytorch.org) for prod/stable builds
# These packages will have their URLs point to R2 instead of S3/CloudFront
# when the path is NOT whl/test and NOT whl/nightly (i.e., prod)
PT_R2_PACKAGES_PROD = {
    "fbgemm_gpu",
    "fbgemm_gpu_genai",
}

# Packages that should have their root index.html copied to subdirectories
# instead of processing wheels in subdirectories
# For example: whl/nightly/filelock/index.html -> whl/nightly/cu128/filelock/index.html
PACKAGE_LINKS_ALLOW_LIST = {
    x.lower()
    for x in [
        "filelock",
        "sympy",
        "mpmath",
        "pillow",
        "networkx",
        "numpy",
        "fsspec",
        "typing-extensions",
        "cuda-bindings",
        "cuda-toolkit",
        "nvidia-cuda-nvrtc-cu12",
        "nvidia-cuda-nvrtc",
        "nvidia-cuda-runtime-cu12",
        "nvidia-cuda-runtime",
        "nvidia-cuda-cupti-cu12",
        "nvidia-cuda-cupti",
        "nvidia-cuda-cccl-cu12",
        "nvidia-cuda-cccl",
        "nvidia-cudnn-cu12",
        "nvidia-cudnn-cu13",
        "nvidia-cublas-cu12",
        "nvidia-cublas",
        "nvidia-cufft-cu12",
        "nvidia-cufft",
        "nvidia-curand-cu12",
        "nvidia-curand",
        "nvidia-cusolver-cu12",
        "nvidia-cusolver",
        "nvidia-cusparse-cu12",
        "nvidia-cusparse",
        "nvidia-cusparselt-cu12",
        "nvidia-cusparselt-cu13",
        "nvidia-nccl-cu12",
        "nvidia-nccl-cu13",
        "nvidia-nvshmem-cu12",
        "nvidia-nvshmem-cu13",
        "nvidia-nvtx-cu12",
        "nvidia-nvtx",
        "nvidia-nvjitlink-cu12",
        "nvidia-nvjitlink",
        "nvidia-cufile-cu12",
        "nvidia-cufile",
        # torch_xpu packages
        "dpcpp-cpp-rt",
        "intel-cmplr-lib-rt",
        "intel-cmplr-lib-ur",
        "intel-cmplr-lic-rt",
        "intel-opencl-rt",
        "intel-sycl-rt",
        "intel-openmp",
        "tcmlib",
        "umf",
        "intel-pti",
        "tbb",
        "oneccl-devel",
        "oneccl",
        "impi-rt",
        "onemkl-sycl-blas",
        "onemkl-sycl-dft",
        "onemkl-sycl-lapack",
        "onemkl-sycl-sparse",
        "onemkl-sycl-rng",
        "onemkl-license",
        "mkl",
        "pyelftools",
    ]
}


# How many packages should we keep of a specific package?
KEEP_THRESHOLD = 60


S3IndexType = TypeVar("S3IndexType", bound="S3Index")


@dataclasses.dataclass(frozen=False)
@functools.total_ordering
class S3Object:
    key: str
    orig_key: str
    checksum: Optional[str]
    size: Optional[int]
    pep658: Optional[str]

    def __hash__(self):
        return hash(self.key)

    def __str__(self):
        return self.key

    def __eq__(self, other):
        return self.key == other.key

    def __lt__(self, other):
        return self.key < other.key


def safe_parse_version(ver_str: str) -> Version:
    try:
        return _parse_version(ver_str)  # type: ignore[return-value]
    except InvalidVersion:
        return Version("0.0.0")


class S3Index:
    def __init__(self, objects: List[S3Object], prefix: str) -> None:
        self.objects = objects
        self.prefix = prefix.rstrip("/")
        self.html_name = "index.html"
        # should dynamically grab subdirectories like whl/test/cu101
        # so we don't need to add them manually anymore
        self.subdirs = {
            path.dirname(obj.key) for obj in objects if path.dirname != prefix
        }
        # Cache for expensive computations
        self._package_name_cache: Dict[str, str] = {}
        self._parent_packages_cache: Dict[str, Set[str]] = {}
        # Cache for S3 bucket object listings to avoid repeated API calls
        self._bucket_listing_cache: Dict[str, List] = {}

    def packages_by_allow_list(self) -> List[S3Object]:
        """Filter packages to only include those in PACKAGE_ALLOW_LIST

        This method filters packages without applying version thresholds,
        keeping all versions of allowed packages.
        """
        return [
            obj
            for obj in self.objects
            if self.obj_to_package_name(obj) in PACKAGE_ALLOW_LIST
        ]

    def nightly_packages_to_show(self) -> List[S3Object]:
        """Finding packages to show based on a threshold we specify

        Basically takes our S3 packages, normalizes the version for easier
        comparisons, then iterates over normalized versions until we reach a
        threshold and then starts adding package to delete after that threshold
        has been reached

        After figuring out what versions we'd like to hide we iterate over
        our original object list again and pick out the full paths to the
        packages that are included in the list of versions to delete
        """
        # also includes versions without GPU specifier (i.e. cu102) for easier
        # sorting, sorts in reverse to put the most recent versions first
        all_sorted_packages = sorted(
            {self.normalize_package_version(obj) for obj in self.objects},
            key=lambda name_ver: safe_parse_version(name_ver.split("-", 1)[-1]),
            reverse=True,
        )
        packages: Dict[str, int] = defaultdict(int)
        to_hide: Set[str] = set()
        for obj in all_sorted_packages:
            full_package_name = path.basename(obj)
            package_name = full_package_name.split("-")[0]
            # Hard pass on packages that are included in our allow list
            if package_name.lower() not in PACKAGE_ALLOW_LIST:
                to_hide.add(obj)
                continue
            if packages[package_name] >= KEEP_THRESHOLD:
                to_hide.add(obj)
            else:
                packages[package_name] += 1
        return list(
            set(self.objects).difference(
                {
                    obj
                    for obj in self.objects
                    if self.normalize_package_version(obj) in to_hide
                }
            )
        )

    def is_obj_at_root(self, obj: S3Object) -> bool:
        return path.dirname(obj.key) == self.prefix

    def _resolve_subdir(self, subdir: Optional[str] = None) -> str:
        if not subdir:
            subdir = self.prefix
        # make sure we strip any trailing slashes
        return subdir.rstrip("/")

    def gen_file_list(
        self, subdir: Optional[str] = None, package_name: Optional[str] = None
    ) -> Iterable[S3Object]:
        objects = self.objects
        subdir = self._resolve_subdir(subdir) + "/"
        for obj in objects:
            if (
                package_name is not None
                and self.obj_to_package_name(obj) != package_name
            ):
                continue
            if self.is_obj_at_root(obj) or obj.key.startswith(subdir):
                yield obj

    def get_package_names(self, subdir: Optional[str] = None) -> List[str]:
        return sorted(
            {self.obj_to_package_name(obj) for obj in self.gen_file_list(subdir)}
        )

    def _get_bucket_listing(self, prefix: str) -> List:
        """Get bucket listing with caching to avoid repeated S3 API calls"""
        if prefix not in self._bucket_listing_cache:
            self._bucket_listing_cache[prefix] = list(
                BUCKET.objects.filter(Prefix=prefix)
            )
        return self._bucket_listing_cache[prefix]

    def get_packages_to_copy_from_parent(
        self, subdir: str, parent_prefix: str
    ) -> Set[str]:
        """Get packages from PACKAGE_LINKS_ALLOW_LIST that exist in parent but not in subdir

        Args:
            subdir: The subdirectory being processed (e.g., "whl/nightly/cu128")
            parent_prefix: The parent prefix to copy from (e.g., "whl/nightly")

        Returns:
            Set of package names that should be copied from parent
        """
        # Use cache to avoid repeated S3 API calls
        cache_key = f"{parent_prefix}:{subdir}"
        if cache_key in self._parent_packages_cache:
            return self._parent_packages_cache[cache_key]

        packages_to_copy = set()

        # Get packages in the subdirectory
        packages_in_subdir = set(self.get_package_names(subdir=subdir))

        # Batch process all objects with a single cached filter call
        prefix_to_search = f"{parent_prefix}/"

        # Collect all package index files in one pass using cached bucket listing
        parent_packages = set()
        for obj in self._get_bucket_listing(prefix_to_search):
            # Check if this is a packagename/index.html file at the parent level
            relative_key = obj.key[len(prefix_to_search) :]
            parts = relative_key.split("/")
            if len(parts) == 2 and parts[1] == "index.html":
                # Convert from URL format (dashes) to package name format (underscores)
                pkg_name_with_underscores = parts[0].replace("-", "_")
                parent_packages.add(pkg_name_with_underscores)

        # Now filter for PACKAGE_LINKS_ALLOW_LIST packages not in subdirectory
        for pkg_name in parent_packages:
            if pkg_name.lower() in PACKAGE_LINKS_ALLOW_LIST:
                if pkg_name.lower() not in {p.lower() for p in packages_in_subdir}:
                    packages_to_copy.add(pkg_name)
                    print(
                        f"INFO: Found PACKAGE_LINKS_ALLOW_LIST package '{pkg_name}' in '{parent_prefix}' to copy to '{subdir}'"
                    )

        # Cache the result
        self._parent_packages_cache[cache_key] = packages_to_copy
        return packages_to_copy

    def normalize_package_version(self, obj: S3Object) -> str:
        # removes the GPU specifier from the package name as well as
        # unnecessary things like the file extension, architecture name, etc.
        return sub(r"%2B.*", "", "-".join(path.basename(obj.key).split("-")[:2]))

    def obj_to_package_name(self, obj: S3Object) -> str:
        # Use cache to avoid repeated string operations
        if obj.key not in self._package_name_cache:
            self._package_name_cache[obj.key] = (
                path.basename(obj.key).split("-", 1)[0].lower()
            )
        return self._package_name_cache[obj.key]

    def to_libtorch_html(self, subdir: Optional[str] = None) -> str:
        """Generates a string that can be used as the HTML index

        Takes our objects and transforms them into HTML that have historically
        been used by pip for installing pytorch, but now only used to generate libtorch browseable folder.
        """
        out: List[str] = []
        subdir = self._resolve_subdir(subdir)
        is_root = subdir == self.prefix
        for obj in self.gen_file_list(subdir, "libtorch"):
            # Skip root objs, as they are irrelevant for libtorch indexes
            if not is_root and self.is_obj_at_root(obj):
                continue
            # Strip our prefix
            sanitized_obj = obj.key.replace(subdir, "", 1)
            if sanitized_obj.startswith("/"):
                sanitized_obj = sanitized_obj.lstrip("/")
            out.append(f'<a href="/{obj.key}">{sanitized_obj}</a><br/>')
        return "\n".join(sorted(out))

    def to_source_code_html(self, subdir: Optional[str] = None) -> str:
        """Generates a string that can be used as the HTML index for source code packages

        Creates a simple browseable index for pytorch-*.tar.gz source code packages.
        """
        out: List[str] = []
        subdir = self._resolve_subdir(subdir)
        for obj in self.gen_file_list(subdir):
            # Strip our prefix
            sanitized_obj = obj.key.replace(subdir, "", 1)
            if sanitized_obj.startswith("/"):
                sanitized_obj = sanitized_obj.lstrip("/")
            out.append(f'<a href="/{obj.key}">{sanitized_obj}</a><br/>')
        return "\n".join(sorted(out))

    def to_simple_package_html(
        self,
        subdir: Optional[str],
        package_name: str,
        use_cloudfront_for_non_foundation: bool = False,
    ) -> str:
        """Generates a string that can be used as the package simple HTML index

        Args:
            subdir: The subdirectory to generate HTML for
            package_name: The package name
            use_cloudfront_for_non_foundation: If True, use CloudFront URLs for packages
                not in PT_FOUNDATION_PACKAGES. If False, always use relative URLs.
        """
        out: List[str] = []
        # Adding html header
        out.append("<!DOCTYPE html>")
        out.append("<html>")
        out.append("  <body>")
        out.append(
            "    <h1>Links for {}</h1>".format(package_name.lower().replace("_", "-"))
        )

        # Determine URL strategy once before the loop
        resolved_subdir = self._resolve_subdir(subdir)

        # Check if this package should use R2 for nightly builds
        if package_name.lower() in PT_R2_PACKAGES and resolved_subdir.startswith(
            "whl/nightly"
        ):
            # Use R2 absolute URL for PT_R2_PACKAGES in nightly builds
            base_url = "https://download-r2.pytorch.org"
        elif (
            package_name.lower() in PT_R2_PACKAGES_PROD
            and not resolved_subdir.startswith("whl/test")
            and not resolved_subdir.startswith("whl/nightly")
        ):
            # Use R2 absolute URL for PT_R2_PACKAGES_PROD in prod/stable builds
            base_url = "https://download-r2.pytorch.org"
        elif (
            use_cloudfront_for_non_foundation
            and package_name.lower() not in PT_FOUNDATION_PACKAGES
        ):
            # Use CloudFront absolute URL for non-foundation packages when requested
            base_url = "https://d21usjoq99fcb9.cloudfront.net"
        else:
            # Use relative URL for S3 index or foundation packages in R2 index
            base_url = ""

        # Pre-check if this is a nightly package to avoid repeated startswith checks
        is_nightly = any(
            obj.orig_key.startswith("whl/nightly")
            for obj in self.gen_file_list(subdir, package_name)
        )

        for obj in sorted(self.gen_file_list(subdir, package_name)):
            # Do not include checksum for nightly packages, see
            # https://github.com/pytorch/test-infra/pull/6307
            maybe_fragment = (
                f"#sha256={obj.checksum}" if obj.checksum and not is_nightly else ""
            )
            attributes = ""
            if obj.pep658:
                pep658_sha = f"sha256={obj.pep658}"
                # pep714 renames the attribute to data-core-metadata
                attributes = f' data-dist-info-metadata="{pep658_sha}" data-core-metadata="{pep658_sha}"'

            out.append(
                f'    <a href="{base_url}/{obj.key}{maybe_fragment}"{attributes}>{path.basename(obj.key).replace("%2B", "+")}</a><br/>'
            )
        # Adding html footer
        out.append("  </body>")
        out.append("</html>")
        out.append(f"<!--TIMESTAMP {int(time.time())}-->")
        return "\n".join(out)

    def to_simple_packages_html(
        self,
        subdir: Optional[str],
    ) -> str:
        """Generates a string that can be used as the simple HTML index"""
        out: List[str] = []
        # Adding html header
        out.append("<!DOCTYPE html>")
        out.append("<html>")
        out.append("  <body>")

        # Get packages from wheel files
        packages_from_wheels = set(self.get_package_names(subdir))

        # Also find packages that have index.html but no wheels
        packages_with_index_only = set()
        resolved_subdir = self._resolve_subdir(subdir)

        # List all objects in the subdir to find packagename/index.html patterns
        prefix_to_search = f"{resolved_subdir}/"

        # Optimize: collect package names in a single pass using cached bucket listing
        for obj in self._get_bucket_listing(prefix_to_search):
            # Check if this is a packagename/index.html file
            relative_key = obj.key[len(prefix_to_search) :]
            parts = relative_key.split("/")
            if len(parts) == 2 and parts[1] == "index.html":
                package_name = parts[0].replace("-", "_")
                # Convert back to the format used in wheel names (use _ not -)
                # But we need to check if this package already has wheels
                package_name_lower = package_name.lower()
                if package_name_lower not in {p.lower() for p in packages_from_wheels}:
                    packages_with_index_only.add(package_name)

        # Only print if there are packages with index only
        if packages_with_index_only:
            for pkg in packages_with_index_only:
                print(
                    f"INFO: Including package '{pkg}' in {prefix_to_search} (has index.html but no wheels)"
                )

        # Combine both sets of packages
        all_packages = packages_from_wheels | packages_with_index_only

        for pkg_name in sorted(all_packages):
            out.append(
                f'    <a href="{pkg_name.lower().replace("_", "-")}/">{pkg_name.replace("_", "-")}</a><br/>'
            )
        # Adding html footer
        out.append("  </body>")
        out.append("</html>")
        out.append(f"<!--TIMESTAMP {int(time.time())}-->")
        return "\n".join(out)

    def upload_libtorch_html(self) -> None:
        """Upload libtorch indexes to S3 and R2 with same relative URLs"""
        for subdir in self.subdirs:
            index_html = self.to_libtorch_html(subdir=subdir)

            # Upload to S3
            print(
                f"INFO Uploading {subdir}/{self.html_name} to S3 bucket {BUCKET.name}"
            )
            BUCKET.Object(key=f"{subdir}/{self.html_name}").put(
                ACL="public-read",
                CacheControl="no-cache,no-store,must-revalidate",
                ContentType="text/html",
                Body=index_html,
            )

            # Upload to R2 if configured (same content with relative URLs)
            if R2_BUCKET:
                print(
                    f"INFO Uploading {subdir}/{self.html_name} to R2 bucket {R2_BUCKET.name}"
                )
                R2_BUCKET.Object(key=f"{subdir}/{self.html_name}").put(
                    ACL="public-read",
                    CacheControl="no-cache,no-store,must-revalidate",
                    ContentType="text/html",
                    Body=index_html,
                )

    def upload_source_code_html(self) -> None:
        """Upload source code index to S3 and R2"""
        # For source_code/test, it has a flat structure, so we only upload to the prefix directory
        index_html = self.to_source_code_html(subdir=self.prefix)

        # Upload to S3
        print(
            f"INFO Uploading {self.prefix}/{self.html_name} to S3 bucket {BUCKET.name}"
        )
        BUCKET.Object(key=f"{self.prefix}/{self.html_name}").put(
            ACL="public-read",
            CacheControl="no-cache,no-store,must-revalidate",
            ContentType="text/html",
            Body=index_html,
        )

        # Upload to R2 if configured
        if R2_BUCKET:
            print(
                f"INFO Uploading {self.prefix}/{self.html_name} to R2 bucket {R2_BUCKET.name}"
            )
            R2_BUCKET.Object(key=f"{self.prefix}/{self.html_name}").put(
                ACL="public-read",
                CacheControl="no-cache,no-store,must-revalidate",
                ContentType="text/html",
                Body=index_html,
            )

    def upload_pep503_htmls(self) -> None:
        # Pre-fetch bucket listings for all subdirectories to optimize S3 API calls
        print("INFO: Pre-fetching S3 bucket listings for optimization...")
        for subdir in self.subdirs:
            prefix_to_search = f"{self._resolve_subdir(subdir)}/"
            self._get_bucket_listing(prefix_to_search)
        print(f"INFO: Pre-fetched listings for {len(self.subdirs)} subdirectories")

        for subdir in self.subdirs:
            # Generate the package list index (same for both S3 and R2)
            index_html = self.to_simple_packages_html(subdir=subdir)

            # Upload package list to S3
            print(f"INFO Uploading {subdir}/index.html to S3 bucket {BUCKET.name}")
            BUCKET.Object(key=f"{subdir}/index.html").put(
                ACL="public-read",
                CacheControl="no-cache,no-store,must-revalidate",
                ContentType="text/html",
                Body=index_html,
            )

            # Upload package list to R2 if configured
            if R2_BUCKET:
                print(
                    f"INFO Uploading {subdir}/index.html to R2 bucket {R2_BUCKET.name}"
                )
                R2_BUCKET.Object(key=f"{subdir}/index.html").put(
                    ACL="public-read",
                    CacheControl="no-cache,no-store,must-revalidate",
                    ContentType="text/html",
                    Body=index_html,
                )

            # Generate and upload per-package indexes
            packages_with_wheels = self.get_package_names(subdir=subdir)

            # Filter out packages that are in PACKAGE_LINKS_ALLOW_LIST
            # Those packages should only be copied from parent, not recomputed from wheels
            packages_with_wheels = [
                pkg
                for pkg in packages_with_wheels
                if pkg.lower() not in PACKAGE_LINKS_ALLOW_LIST
            ]

            # Also get packages from PACKAGE_LINKS_ALLOW_LIST that exist in parent
            # Only copy from parent within the same prefix hierarchy
            # Do NOT copy from whl to whl/nightly or whl/test
            packages_to_copy_from_parent = set()
            if subdir != self.prefix:
                # For subdirectories like whl/nightly/cu128, check for packages in whl/nightly
                packages_to_copy_from_parent = self.get_packages_to_copy_from_parent(
                    subdir=subdir, parent_prefix=self.prefix
                )

            # Combine packages with wheels and packages to copy
            all_packages = sorted(
                set(packages_with_wheels) | packages_to_copy_from_parent
            )

            # Batch upload using ThreadPoolExecutor for better performance
            def upload_package_index(pkg_name: str) -> None:
                compat_pkg_name = pkg_name.lower().replace("_", "-")

                # Check if this package should copy from parent instead of processing wheels
                should_copy_from_parent = False
                copy_source_prefix = None

                if pkg_name.lower() in PACKAGE_LINKS_ALLOW_LIST:
                    if subdir != self.prefix:
                        # Case 1: Processing subdirectory, copy from root of current prefix
                        # e.g., whl/nightly/cu128 copies from whl/nightly
                        should_copy_from_parent = True
                        copy_source_prefix = self.prefix
                    else:
                        # Case 2: Processing root of prefix (e.g., whl/nightly or whl/test)
                        # Do NOT copy from parent prefix (whl)
                        # PACKAGE_LINKS_ALLOW_LIST packages should only exist in whl root level
                        print(
                            f"INFO: Skipping PACKAGE_LINKS_ALLOW_LIST package '{pkg_name}' at root level '{subdir}' (not copying from parent)"
                        )
                        return

                if should_copy_from_parent and copy_source_prefix is not None:
                    # Copy HTML from parent/root directory
                    root_index_key = (
                        f"{copy_source_prefix}/{compat_pkg_name}/index.html"
                    )

                    try:
                        # Fetch the root index.html from S3
                        root_obj = BUCKET.Object(key=root_index_key)
                        root_index_html = root_obj.get()["Body"].read().decode("utf-8")

                        # Upload to subdirectory in S3
                        BUCKET.Object(key=f"{subdir}/{compat_pkg_name}/index.html").put(
                            ACL="public-read",
                            CacheControl="no-cache,no-store,must-revalidate",
                            ContentType="text/html",
                            Body=root_index_html,
                        )

                        # Upload to R2 if configured
                        if R2_BUCKET:
                            R2_BUCKET.Object(
                                key=f"{subdir}/{compat_pkg_name}/index.html"
                            ).put(
                                ACL="public-read",
                                CacheControl="no-cache,no-store,must-revalidate",
                                ContentType="text/html",
                                Body=root_index_html,
                            )
                    except Exception as e:
                        print(f"ERROR: Failed to copy {root_index_key}: {e}")

                    return

                # Generate S3 index with relative URLs
                s3_index_html = self.to_simple_package_html(
                    subdir=subdir,
                    package_name=pkg_name,
                    use_cloudfront_for_non_foundation=False,
                )
                print(
                    f"INFO Uploading {subdir}/{compat_pkg_name}/index.html to S3 bucket {BUCKET.name}"
                )
                BUCKET.Object(key=f"{subdir}/{compat_pkg_name}/index.html").put(
                    ACL="public-read",
                    CacheControl="no-cache,no-store,must-revalidate",
                    ContentType="text/html",
                    Body=s3_index_html,
                )

                # Generate and upload R2 index with CloudFront URLs for non-foundation packages
                if R2_BUCKET:
                    r2_index_html = self.to_simple_package_html(
                        subdir=subdir,
                        package_name=pkg_name,
                        use_cloudfront_for_non_foundation=True,
                    )
                    print(
                        f"INFO Uploading {subdir}/{compat_pkg_name}/index.html to R2 bucket {R2_BUCKET.name}"
                    )
                    R2_BUCKET.Object(key=f"{subdir}/{compat_pkg_name}/index.html").put(
                        ACL="public-read",
                        CacheControl="no-cache,no-store,must-revalidate",
                        ContentType="text/html",
                        Body=r2_index_html,
                    )

            # Parallel upload of package indexes
            # Increase parallelism for faster uploads
            max_workers = min(20, len(all_packages)) if all_packages else 1
            with concurrent.futures.ThreadPoolExecutor(
                max_workers=max_workers
            ) as executor:
                executor.map(upload_package_index, all_packages)

    def save_libtorch_html(self) -> None:
        for subdir in self.subdirs:
            print(f"INFO Saving {subdir}/{self.html_name}")
            makedirs(subdir, exist_ok=True)
            with open(
                path.join(subdir, self.html_name), mode="w", encoding="utf-8"
            ) as f:
                f.write(self.to_libtorch_html(subdir=subdir))

    def save_source_code_html(self) -> None:
        """Save source code index to local file"""
        print(f"INFO Saving {self.prefix}/{self.html_name}")
        makedirs(self.prefix, exist_ok=True)
        with open(
            path.join(self.prefix, self.html_name), mode="w", encoding="utf-8"
        ) as f:
            f.write(self.to_source_code_html(subdir=self.prefix))

    def save_pep503_htmls(self) -> None:
        for subdir in self.subdirs:
            print(f"INFO Saving {subdir}/index.html")
            makedirs(subdir, exist_ok=True)
            with open(path.join(subdir, "index.html"), mode="w", encoding="utf-8") as f:
                f.write(self.to_simple_packages_html(subdir=subdir))

            packages_with_wheels = self.get_package_names(subdir=subdir)

            # Filter out packages that are in PACKAGE_LINKS_ALLOW_LIST
            # Those packages should only be copied from parent, not recomputed from wheels
            packages_with_wheels = [
                pkg
                for pkg in packages_with_wheels
                if pkg.lower() not in PACKAGE_LINKS_ALLOW_LIST
            ]

            # Also get packages from PACKAGE_LINKS_ALLOW_LIST that exist in parent
            # Only copy from parent within the same prefix hierarchy
            # Do NOT copy from whl to whl/nightly or whl/test
            packages_to_copy_from_parent = set()
            if subdir != self.prefix:
                # For subdirectories like whl/nightly/cu128, check for packages in whl/nightly
                packages_to_copy_from_parent = self.get_packages_to_copy_from_parent(
                    subdir=subdir, parent_prefix=self.prefix
                )

            # Combine packages with wheels and packages to copy
            all_packages = sorted(
                set(packages_with_wheels) | packages_to_copy_from_parent
            )

            for pkg_name in all_packages:
                compat_pkg_name = pkg_name.lower().replace("_", "-")
                pkg_dir = path.join(subdir, compat_pkg_name)
                makedirs(pkg_dir, exist_ok=True)

                # Check if this package should copy from parent instead of processing wheels
                # This applies only to subdirectories:
                # - Subdirectories (e.g., whl/nightly/cu128 copies from whl/nightly)
                # - Root level prefixes (whl/nightly, whl/test) do NOT copy from whl
                should_copy_from_parent = False
                copy_source_prefix = None

                if pkg_name.lower() in PACKAGE_LINKS_ALLOW_LIST:
                    print(
                        f"INFO PACKAGE_LINKS_ALLOW_LIST: Package '{pkg_name}' is in PACKAGE_LINKS_ALLOW_LIST - checking copy strategy"
                    )
                    if subdir != self.prefix:
                        # Case 1: Processing subdirectory, copy from root of current prefix
                        # e.g., whl/nightly/cu128 copies from whl/nightly
                        should_copy_from_parent = True
                        copy_source_prefix = self.prefix
                        print(
                            f"INFO PACKAGE_LINKS_ALLOW_LIST: Package '{pkg_name}' will copy index from '{copy_source_prefix}' to '{subdir}' (subdirectory copy)"
                        )
                    else:
                        # Case 2: Processing root of prefix (e.g., whl/nightly or whl/test)
                        # Do NOT copy from parent prefix (whl)
                        # PACKAGE_LINKS_ALLOW_LIST packages should only exist in whl root level
                        print(
                            f"INFO PACKAGE_LINKS_ALLOW_LIST: Skipping package '{pkg_name}' at root level '{subdir}' (not copying from parent)"
                        )
                        continue

                if should_copy_from_parent and copy_source_prefix is not None:
                    # Copy HTML from parent/root directory
                    root_index_path = path.join(
                        copy_source_prefix, compat_pkg_name, "index.html"
                    )
                    print(
                        f"INFO PACKAGE_LINKS_ALLOW_LIST: Copying {root_index_path} to {pkg_dir}/index.html"
                    )

                    try:
                        # Read the root index.html
                        with open(root_index_path, mode="r", encoding="utf-8") as src:
                            root_index_html = src.read()

                        # Save to subdirectory
                        with open(
                            path.join(pkg_dir, "index.html"),
                            mode="w",
                            encoding="utf-8",
                        ) as dst:
                            dst.write(root_index_html)
                        print(
                            f"SUCCESS PACKAGE_LINKS_ALLOW_LIST: Copied to {pkg_dir}/index.html"
                        )

                        # Also save R2 version if R2 is configured
                        if R2_BUCKET:
                            root_r2_path = path.join(
                                copy_source_prefix, compat_pkg_name, "index-r2.html"
                            )
                            if path.exists(root_r2_path):
                                with open(
                                    root_r2_path, mode="r", encoding="utf-8"
                                ) as src:
                                    root_r2_html = src.read()
                                with open(
                                    path.join(pkg_dir, "index-r2.html"),
                                    mode="w",
                                    encoding="utf-8",
                                ) as dst:
                                    dst.write(root_r2_html)
                                print(
                                    f"SUCCESS PACKAGE_LINKS_ALLOW_LIST: Copied to {pkg_dir}/index-r2.html"
                                )
                    except Exception as e:
                        print(
                            f"ERROR PACKAGE_LINKS_ALLOW_LIST: Failed to copy {root_index_path}: {e}"
                        )

                    continue

                # Save S3 version (with relative URLs)
                with open(
                    path.join(pkg_dir, "index.html"),
                    mode="w",
                    encoding="utf-8",
                ) as f:
                    f.write(
                        self.to_simple_package_html(
                            subdir=subdir,
                            package_name=pkg_name,
                            use_cloudfront_for_non_foundation=False,
                        )
                    )

                # Save R2 version (with CloudFront URLs for non-foundation) if R2 is configured
                if R2_BUCKET:
                    with open(
                        path.join(pkg_dir, "index-r2.html"),
                        mode="w",
                        encoding="utf-8",
                    ) as f:
                        f.write(
                            self.to_simple_package_html(
                                subdir=subdir,
                                package_name=pkg_name,
                                use_cloudfront_for_non_foundation=True,
                            )
                        )

    def compute_sha256(self) -> None:
        for obj in self.objects:
            if obj.checksum is not None:
                continue
            print(f"Updating {obj.orig_key} of size {obj.size} with SHA256 checksum")
            s3_obj = BUCKET.Object(key=obj.orig_key)
            s3_obj.copy_from(
                CopySource={"Bucket": BUCKET.name, "Key": obj.orig_key},
                Metadata=s3_obj.metadata,
                MetadataDirective="REPLACE",
                ACL="public-read",
                ChecksumAlgorithm="SHA256",
            )

    @classmethod
    def has_public_read(cls, key: str) -> bool:
        def is_all_users_group(o) -> bool:
            return (
                o.get("Grantee", {}).get("URI")
                == "http://acs.amazonaws.com/groups/global/AllUsers"
            )

        def can_read(o) -> bool:
            return o.get("Permission") in ["READ", "FULL_CONTROL"]

        acl_grants = CLIENT.get_object_acl(Bucket=BUCKET.name, Key=key)["Grants"]
        return any(is_all_users_group(x) and can_read(x) for x in acl_grants)

    @classmethod
    def grant_public_read(cls, key: str) -> None:
        CLIENT.put_object_acl(Bucket=BUCKET.name, Key=key, ACL="public-read")

    @classmethod
    def fetch_object_names(cls, prefix: str) -> List[str]:
        obj_names = []

        # Special handling for source_code prefix - flat structure with only tar.gz files
        if prefix.startswith("source_code"):
            for obj in BUCKET.objects.filter(Prefix=prefix):
                # For source_code, we only want files directly in the prefix directory
                # and they should be tar.gz files matching pytorch-*.tar.gz
                if path.dirname(obj.key) == prefix and obj.key.endswith(".tar.gz"):
                    obj_names.append(obj.key)
            return obj_names

        # Original logic for whl and libtorch prefixes
        for obj in BUCKET.objects.filter(Prefix=prefix):
            is_acceptable = any(
                [path.dirname(obj.key) == prefix]
                + [
                    match(f"{prefix}/{pattern}", path.dirname(obj.key))
                    for pattern in ACCEPTED_SUBDIR_PATTERNS
                ]
            ) and obj.key.endswith(ACCEPTED_FILE_EXTENSIONS)

            # Check if the subdir matches any NOT_ACCEPTED_SUBDIR_PATTERNS
            is_not_accepted = any(
                match(f"{prefix}/{pattern}", path.dirname(obj.key))
                for pattern in NOT_ACCEPTED_SUBDIR_PATTERNS
            )

            if not is_acceptable or is_not_accepted:
                continue
            obj_names.append(obj.key)
        return obj_names

    def fetch_metadata(self) -> None:
        # Add PEP 503-compatible hashes to URLs to allow clients to avoid spurious downloads, if possible.
        regex_multipart_upload = r"^[A-Za-z0-9+/=]+=-[0-9]+$"
        # Increase worker count for better parallelism (from 6 to 20)
        max_workers = min(20, len(self.objects)) if self.objects else 6
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {}
            for idx, obj in enumerate(self.objects):
                if obj.size is None:
                    future = executor.submit(
                        lambda key: CLIENT.head_object(
                            Bucket=BUCKET.name, Key=key, ChecksumMode="Enabled"
                        ),
                        obj.orig_key,
                    )
                    futures[idx] = future

            for idx, future in futures.items():
                response = future.result()
                raw = response.get("ChecksumSHA256")
                if raw and match(regex_multipart_upload, raw):
                    # Possibly part of a multipart upload, making the checksum incorrect
                    print(
                        f"WARNING: {self.objects[idx].orig_key} has bad checksum: {raw}"
                    )
                    raw = None
                sha256 = raw and base64.b64decode(raw).hex()
                # For older files, rely on checksum-sha256 metadata that can be added to the file later
                if sha256 is None:
                    sha256 = response.get("Metadata", {}).get("checksum-sha256")
                if sha256 is None:
                    sha256 = response.get("Metadata", {}).get(
                        "x-amz-meta-checksum-sha256"
                    )
                self.objects[idx].checksum = sha256
                if size := response.get("ContentLength"):
                    self.objects[idx].size = int(size)

    def fetch_pep658(self) -> None:
        def _fetch_metadata(key: str) -> str:
            try:
                response = CLIENT.head_object(
                    Bucket=BUCKET.name, Key=f"{key}.metadata", ChecksumMode="Enabled"
                )
                sha256 = base64.b64decode(response.get("ChecksumSHA256")).hex()
                return sha256
            except botocore.exceptions.ClientError as e:  # type: ignore[attr-defined]
                if e.response["Error"]["Code"] == "404":
                    return ""
                raise

        # Increase worker count for better parallelism (from 6 to 20)
        max_workers = min(20, len(self.objects)) if self.objects else 6
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            metadata_futures = {
                idx: executor.submit(
                    _fetch_metadata,
                    obj.orig_key,
                )
                for (idx, obj) in enumerate(self.objects)
            }
            for idx, future in metadata_futures.items():
                response = future.result()
                if response is not None:
                    self.objects[idx].pep658 = response

    @classmethod
    def from_S3(cls, prefix: str, with_metadata: bool = True) -> "S3Index":
        prefix = prefix.rstrip("/")
        obj_names = cls.fetch_object_names(prefix)

        def sanitize_key(key: str) -> str:
            return key.replace("+", "%2B")

        rc = cls(
            [
                S3Object(
                    key=sanitize_key(key),
                    orig_key=key,
                    checksum=None,
                    size=None,
                    pep658=None,
                )
                for key in obj_names
            ],
            prefix,
        )
        print(
            f"INFO: Retrieved {len(rc.objects)} objects from S3 for prefix '{prefix}'"
        )

        # Apply PACKAGE_ALLOW_LIST filtering to whl, whl/nightly, and whl/test
        if prefix == "whl/nightly":
            # For nightly: filter by allow list AND limit to 60 versions per package
            print(
                f"INFO: Filtering nightly packages using PACKAGE_ALLOW_LIST and version threshold (keeping {KEEP_THRESHOLD} versions per package)..."
            )
            rc.objects = rc.nightly_packages_to_show()
            print(
                f"INFO: After filtering, {len(rc.objects)} packages to show for {prefix}"
            )
        elif prefix in ("whl", "whl/test"):
            # For whl and whl/test: filter by allow list only (no version limit)
            print(
                f"INFO: Filtering packages for {prefix} using PACKAGE_ALLOW_LIST (no version limit)..."
            )
            rc.objects = rc.packages_by_allow_list()
            print(
                f"INFO: After filtering, {len(rc.objects)} packages to show for {prefix}"
            )
        if with_metadata:
            rc.fetch_metadata()
            rc.fetch_pep658()
        return rc

    @classmethod
    def undelete_prefix(cls, prefix: str) -> None:
        paginator = CLIENT.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=BUCKET.name, Prefix=prefix):
            for obj in page.get("DeleteMarkers", []):
                if not obj.get("IsLatest"):
                    continue
                obj_key, obj_version_id = obj["Key"], obj["VersionId"]
                obj_ver = S3.ObjectVersion(BUCKET.name, obj_key, obj_version_id)
                print(f"Undeleting {obj_key} deleted on {obj['LastModified']}")
                obj_ver.delete()


def _compute_and_set_checksums(matching_objects: List[str]) -> None:
    """Compute and set SHA256 checksums for a list of S3 object keys.

    Skips objects that already have checksums.

    Args:
        matching_objects: List of S3 object keys to process
    """
    # 5GB limit for single CopyObject operation
    MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024

    processed = 0
    skipped = 0
    for key in matching_objects:
        try:
            s3_obj = BUCKET.Object(key=key)

            # Check if checksum already exists
            head = CLIENT.head_object(
                Bucket=BUCKET.name, Key=key, ChecksumMode="Enabled"
            )
            existing_checksum = head.get("Metadata", {}).get("checksum-sha256")
            if not existing_checksum:
                existing_checksum = head.get("Metadata", {}).get(
                    "x-amz-meta-checksum-sha256"
                )
            if not existing_checksum:
                # Check for S3 native checksum
                raw = head.get("ChecksumSHA256")
                if raw and not match(r"^[A-Za-z0-9+/=]+=-[0-9]+$", raw):
                    existing_checksum = base64.b64decode(raw).hex()

            if existing_checksum:
                print(f"SKIP: {key} already has checksum: {existing_checksum}")
                skipped += 1
                continue

            content_length = head.get("ContentLength", 0)
            print(
                f"\nINFO: Processing {key} (size: {content_length / (1024 * 1024):.1f} MB)"
            )

            # Download and compute SHA256
            print(f"INFO: Downloading {key} to compute SHA256...")
            response = s3_obj.get()
            body = response["Body"]

            sha256_hash = hashlib.sha256()
            # Read in chunks to handle large files
            for chunk in iter(lambda: body.read(8192), b""):
                sha256_hash.update(chunk)

            sha256 = sha256_hash.hexdigest()
            print(f"INFO: Computed SHA256: {sha256}")

            # Fetch existing metadata
            existing_metadata = s3_obj.metadata.copy()

            # Add/update the checksum metadata
            existing_metadata["checksum-sha256"] = sha256

            # Copy the object to itself with updated metadata
            if content_length >= MULTIPART_THRESHOLD:
                # Use multipart copy for files >= 5GB
                print(
                    f"INFO: Using multipart copy for large file ({content_length / (1024 * 1024 * 1024):.1f} GB)..."
                )
                copy_source = {"Bucket": BUCKET.name, "Key": key}
                s3_obj.copy(
                    CopySource=copy_source,
                    ExtraArgs={
                        "Metadata": existing_metadata,
                        "MetadataDirective": "REPLACE",
                        "ACL": "public-read",
                    },
                )
            else:
                # Use simple copy for smaller files
                s3_obj.copy_from(
                    CopySource={"Bucket": BUCKET.name, "Key": key},
                    Metadata=existing_metadata,
                    MetadataDirective="REPLACE",
                    ACL="public-read",
                )
            print(f"SUCCESS: Set x-amz-meta-checksum-sha256={sha256} for {key}")
            processed += 1

        except Exception as e:
            print(f"ERROR: Failed to process {key}: {e}")
            raise

    print(
        f"\nINFO: Summary - Processed: {processed}, Skipped (already had checksum): {skipped}"
    )


def set_checksum_metadata(prefix: str, package_name: str, version: str) -> None:
    """Compute and set x-amz-meta-checksum-sha256 metadata for all objects matching package-version.

    Args:
        prefix: The S3 prefix to search in (e.g., "whl/test" or "whl")
        package_name: The package name to match (e.g., "torch", "torchvision")
        version: The version to match (e.g., "2.0.0", "2.0.0+cu118")
    """
    # Validate prefix is in whl/ or whl/test path
    if not prefix.startswith("whl"):
        raise ValueError(f"Prefix must be whl or whl/test, got: {prefix}")

    # Normalize package name (replace - with _ for matching wheel filenames)
    normalized_package = package_name.lower().replace("-", "_")
    # URL-encode the + in version for matching S3 keys
    version_pattern = version.replace("+", "%2B")

    print(f"INFO: Searching for {normalized_package}-{version} in {prefix}/")
    print(f"INFO: Version pattern (URL-encoded): {version_pattern}")

    # Find all matching objects
    matching_objects = []
    for obj in BUCKET.objects.filter(Prefix=prefix):
        key = obj.key
        # Skip non-wheel files
        if not key.endswith(".whl"):
            continue

        basename = path.basename(key)
        # Wheel filename format: {package}-{version}-{python}-{abi}-{platform}.whl
        # Check if basename starts with package-version pattern
        # Handle both URL-encoded (+) and regular versions
        basename_lower = basename.lower()
        pattern1 = f"{normalized_package}-{version_pattern.lower()}-"
        pattern2 = f"{normalized_package}-{version.lower()}-"

        if basename_lower.startswith(pattern1) or basename_lower.startswith(pattern2):
            matching_objects.append(key)

    if not matching_objects:
        print(
            f"WARNING: No matching objects found for {package_name}-{version} in {prefix}/"
        )
        return

    print(f"INFO: Found {len(matching_objects)} matching objects")
    _compute_and_set_checksums(matching_objects)


def recompute_sha256_for_pattern(
    prefix: str,
    pattern: str,
    package_name: Optional[str] = None,
    version: Optional[str] = None,
) -> None:
    """Compute SHA256 checksums for objects matching a pattern that don't have checksums.

    Args:
        prefix: The S3 prefix to search in (e.g., "whl/test")
        pattern: The pattern to match against object keys (e.g., "rocm6.4")
        package_name: Optional package name to filter (e.g., "torch", "torchvision")
        version: Optional version to filter (e.g., "2.5.0", "2.5.0+rocm7.1")
    """
    print(f"INFO: Searching in '{prefix}' for objects matching pattern '{pattern}'")
    normalized_package = None
    if package_name:
        print(f"INFO: Filtering by package name: '{package_name}'")
        # Normalize package name (replace - with _ for matching wheel filenames)
        normalized_package = package_name.lower().replace("-", "_")

    if version:
        print(f"INFO: Filtering by version: '{version}'")

    # Find all matching objects
    matching_objects = []

    # Construct the scan prefix by combining prefix and pattern
    scan_prefix = f"{prefix}/{pattern}/"
    print(f"INFO: Scanning prefix '{scan_prefix}'...")

    for obj in BUCKET.objects.filter(Prefix=scan_prefix):
        key = obj.key
        # Only process wheel files
        if key.endswith(".whl"):
            basename = path.basename(key).lower()
            # If package_name is specified, filter by it
            if normalized_package:
                # Wheel filename format: {package}-{version}-...
                if not basename.startswith(f"{normalized_package}-"):
                    continue

            # If version is specified, filter by it
            if version:
                # Check for version pattern in the filename
                # Handle both URL-encoded (+) and regular versions
                # Also handle local version specifiers (e.g., 2.9.1+rocm6.4)
                version_encoded = version.replace("+", "%2B").lower()
                version_lower = version.lower()
                # Version can be followed by - (exact match) or + or %2B (local version)
                version_match = (
                    f"-{version_encoded}-" in basename
                    or f"-{version_lower}-" in basename
                    or f"-{version_encoded}+" in basename
                    or f"-{version_lower}+" in basename
                    or f"-{version_encoded}%2b" in basename
                    or f"-{version_lower}%2b" in basename
                )
                if not version_match:
                    continue

            matching_objects.append(key)

    if not matching_objects:
        filters = []
        if package_name:
            filters.append(f"package '{package_name}'")
        if version:
            filters.append(f"version '{version}'")
        filter_msg = f" for {', '.join(filters)}" if filters else ""
        print(f"WARNING: No matching objects found for pattern '{pattern}'{filter_msg}")
        return

    print(f"INFO: Found {len(matching_objects)} matching wheel files")
    _compute_and_set_checksums(matching_objects)


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser("Manage S3 HTML indices for PyTorch")
    parser.add_argument("prefix", type=str, choices=PREFIXES + ["all"])
    parser.add_argument("--do-not-upload", action="store_true")
    parser.add_argument("--compute-sha256", action="store_true")
    parser.add_argument(
        "--set-checksum",
        action="store_true",
        help="Compute and set x-amz-meta-checksum-sha256 metadata for packages matching "
        "--package-name and --package-version in the specified prefix (whl or whl/test).",
    )
    parser.add_argument(
        "--package-name",
        type=str,
        metavar="NAME",
        help="Package name to filter (e.g., torch, torchvision). "
        "Used with --set-checksum or --recompute-sha256-pattern.",
    )
    parser.add_argument(
        "--package-version",
        type=str,
        metavar="VERSION",
        help="Package version to filter (e.g., 2.0.0, 2.0.0+cu118). "
        "Used with --set-checksum or --recompute-sha256-pattern.",
    )
    parser.add_argument(
        "--recompute-sha256-pattern",
        type=str,
        metavar="PATTERN",
        help="Compute SHA256 checksums for objects matching this pattern that don't already have "
        "checksums (e.g., 'whl/test/rocm7.1'). Objects with existing checksums are skipped.",
    )
    return parser


def main() -> None:
    parser = create_parser()
    args = parser.parse_args()

    # Handle --set-checksum command
    if args.set_checksum:
        if not args.package_name:
            parser.error(
                "--set-checksum requires --package-name to specify the package"
            )
        if not args.package_version:
            parser.error(
                "--set-checksum requires --package-version to specify the version"
            )
        set_checksum_metadata(args.prefix, args.package_name, args.package_version)
        return

    # Handle --recompute-sha256-pattern command
    if args.recompute_sha256_pattern:
        recompute_sha256_for_pattern(
            args.prefix,
            args.recompute_sha256_pattern,
            args.package_name,
            args.package_version,
        )
        return

    # Display PACKAGE_LINKS_ALLOW_LIST summary
    print(f"\n{'=' * 80}")
    print("PACKAGE_LINKS_ALLOW_LIST Configuration:")
    print(f"{'=' * 80}")
    print(
        f"Total packages in PACKAGE_LINKS_ALLOW_LIST: {len(PACKAGE_LINKS_ALLOW_LIST)}"
    )
    print("\nPackages in PACKAGE_LINKS_ALLOW_LIST will have their index.html copied")
    print("from parent directories instead of being regenerated from wheels.")
    print("\nThis is used for dependency packages (numpy, nvidia-*, intel-*, etc.)")
    print("that should point to external package sources.")
    print(f"\nPackages: {', '.join(sorted(list(PACKAGE_LINKS_ALLOW_LIST)[:10]))}...")
    print(f"{'=' * 80}\n")

    action = "Saving indices" if args.do_not_upload else "Uploading indices"
    if args.compute_sha256:
        action = "Computing checksums"

    prefixes = PREFIXES if args.prefix == "all" else [args.prefix]
    for prefix in prefixes:
        generate_pep503 = prefix.startswith("whl")
        generate_source_code = prefix.startswith("source_code")
        print(f"INFO: {action} for '{prefix}'")
        stime = time.time()
        idx = S3Index.from_S3(
            prefix=prefix, with_metadata=generate_pep503 or args.compute_sha256
        )
        etime = time.time()
        print(
            f"INFO: Processing completed for '{prefix}' in {etime - stime:.2f} seconds"
        )
        if args.compute_sha256:
            idx.compute_sha256()
        elif args.do_not_upload:
            if generate_pep503:
                idx.save_pep503_htmls()
            elif generate_source_code:
                idx.save_source_code_html()
            else:
                idx.save_libtorch_html()
        else:
            if generate_pep503:
                idx.upload_pep503_htmls()
            elif generate_source_code:
                idx.upload_source_code_html()
            else:
                idx.upload_libtorch_html()


if __name__ == "__main__":
    main()
