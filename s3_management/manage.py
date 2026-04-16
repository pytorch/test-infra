#!/usr/bin/env python

import argparse
import base64
import concurrent.futures
import dataclasses
import functools
import time
from collections import defaultdict
from os import makedirs, path
from re import match, sub
from typing import Dict, Iterable, List, Optional, Set, TypeVar

import boto3  # type: ignore[import]
import botocore  # type: ignore[import]
from packaging.version import InvalidVersion, parse as _parse_version, Version


S3 = boto3.resource("s3")
CLIENT = boto3.client("s3")

# bucket for download.pytorch.org
BUCKET = S3.Bucket("pytorch")
# bucket mirror just to hold index used with META CDN
BUCKET_META_CDN = S3.Bucket("pytorch-test")
INDEX_BUCKETS = {BUCKET, BUCKET_META_CDN}

ACCEPTED_FILE_EXTENSIONS = ("whl", "zip", "tar.gz", "json")
ACCEPTED_SUBDIR_PATTERNS = [
    r"cu[0-9]+",  # for cuda
    r"rocm[0-9]+\.[0-9]+",  # for rocm
    "cpu",
    "xpu",
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
        # ---- torch xpu additional packages ----
        "dpcpp_cpp_rt",
        "intel_cmplr_lib_rt",
        "intel_cmplr_lib_ur",
        "intel_cmplr_lic_rt",
        "intel_opencl_rt",
        "intel_sycl_rt",
        "intel_openmp",
        "tcmlib",
        "umf",
        "intel_pti",
        "oneccl_devel",
        "oneccl",
        "impi_rt",
        "onemkl_sycl_blas",
        "onemkl_sycl_dft",
        "onemkl_sycl_lapack",
        "onemkl_sycl_sparse",
        "onemkl_sycl_rng",
        "onemkl_license",
        # ----
        "Pillow",
        "certifi",
        "charset_normalizer",
        "cmake",
        "colorama",
        "cuda_bindings",
        "fbgemm_gpu",
        "fbgemm_gpu_genai",
        "filelock",
        "fsspec",
        "idna",
        "iopath",
        "intel_openmp",
        "Jinja2",
        "lit",
        "lightning_utilities",
        "MarkupSafe",
        "mpmath",
        "mkl",
        "mypy_extensions",
        "nestedtensor",
        "networkx",
        "numpy",
        "nvidia_cublas_cu11",
        "nvidia_cuda_cupti_cu11",
        "nvidia_cuda_nvrtc_cu11",
        "nvidia_cuda_runtime_cu11",
        "nvidia_cudnn_cu11",
        "nvidia_cufft_cu11",
        "nvidia_curand_cu11",
        "nvidia_cusolver_cu11",
        "nvidia_cusparse_cu11",
        "nvidia_nccl_cu11",
        "nvidia_nvtx_cu11",
        "nvidia_cublas_cu12",
        "nvidia_cuda_cupti_cu12",
        "nvidia_cuda_nvrtc_cu12",
        "nvidia_cuda_runtime_cu12",
        "nvidia_cudnn_cu12",
        "nvidia_cufft_cu12",
        "nvidia_cufile_cu12",
        "nvidia_nvshmem_cu12",
        "nvidia_curand_cu12",
        "nvidia_cusolver_cu12",
        "nvidia_cusparse_cu12",
        "nvidia_cusparselt_cu12",
        "nvidia_nccl_cu12",
        "nvidia_nvtx_cu12",
        "nvidia_nvjitlink_cu12",
        "nvidia_cublas",
        "nvidia_cuda_cupti",
        "nvidia_cuda_nvrtc",
        "nvidia_cuda_runtime",
        "nvidia_cudnn_cu13",
        "nvidia_cufft",
        "nvidia_cufile",
        "nvidia_nvshmem_cu13",
        "nvidia_curand",
        "nvidia_cusolver",
        "nvidia_cusparse",
        "nvidia_cusparselt_cu13",
        "nvidia_nccl_cu13",
        "nvidia_nvtx",
        "nvidia_nvjitlink",
        "packaging",
        "portalocker",
        "pyre_extensions",
        "pytorch_triton",
        "pytorch_triton_rocm",
        "pytorch_triton_xpu",
        "requests",
        "sympy",
        "tbb",
        "torch_no_python",
        "torch",
        "torch_tensorrt",
        "torch_tensorrt_rtx",
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
        "typing_extensions",
        "typing_inspect",
        "urllib3",
        "xformers",
        "executorch",
        "setuptools",
        "setuptools_scm",
        "wheel",
        # vllm
        "ninja",
        "cuda_python",
        "cuda_bindings",
        "cuda_pathfinder",
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
        "pillow",
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

    def normalize_package_version(self, obj: S3Object) -> str:
        # removes the GPU specifier from the package name as well as
        # unnecessary things like the file extension, architecture name, etc.
        return sub(r"%2B.*", "", "-".join(path.basename(obj.key).split("-")[:2]))

    def obj_to_package_name(self, obj: S3Object) -> str:
        return path.basename(obj.key).split("-", 1)[0].lower()

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

    def to_simple_package_html(self, subdir: Optional[str], package_name: str) -> str:
        """Generates a string that can be used as the package simple HTML index"""
        out: List[str] = []
        # Adding html header
        out.append("<!DOCTYPE html>")
        out.append("<html>")
        out.append("  <body>")
        out.append(
            "    <h1>Links for {}</h1>".format(package_name.lower().replace("_", "-"))
        )
        for obj in sorted(self.gen_file_list(subdir, package_name)):
            # Do not include checksum for nightly packages, see
            # https://github.com/pytorch/test-infra/pull/6307
            maybe_fragment = (
                f"#sha256={obj.checksum}"
                if obj.checksum and not obj.orig_key.startswith("whl/nightly")
                else ""
            )
            attributes = ""
            if obj.pep658:
                pep658_sha = f"sha256={obj.pep658}"
                # pep714 renames the attribute to data-core-metadata
                attributes = f' data-dist-info-metadata="{pep658_sha}" data-core-metadata="{pep658_sha}"'
            # Ugly hack: mark networkx-3.3, 3.4.2 as Python-3.10+ only to unblock https://github.com/pytorch/pytorch/issues/152191
            if any(
                obj.key.endswith(x)
                for x in (
                    "networkx-3.3-py3-none-any.whl",
                    "networkx-3.4.2-py3-none-any.whl",
                )
            ):
                attributes += ' data-requires-python="&gt;=3.10"'

            out.append(
                f'    <a href="/{obj.key}{maybe_fragment}"{attributes}>{path.basename(obj.key).replace("%2B", "+")}</a><br/>'
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
        for obj in BUCKET.objects.filter(Prefix=prefix_to_search):
            # Check if this is a packagename/index.html file
            relative_key = obj.key[len(prefix_to_search) :]
            parts = relative_key.split("/")
            if len(parts) == 2 and parts[1] == "index.html":
                package_name = parts[0].replace("-", "_")
                # Convert back to the format used in wheel names (use _ not -)
                # But we need to check if this package already has wheels
                if package_name.lower() not in {
                    p.lower() for p in packages_from_wheels
                }:
                    packages_with_index_only.add(package_name)
                    print(
                        f"INFO: Including package '{package_name}' in {prefix_to_search} (has index.html but no wheels)"
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
        for subdir in self.subdirs:
            index_html = self.to_libtorch_html(subdir=subdir)
            for bucket in INDEX_BUCKETS:
                print(f"INFO Uploading {subdir}/{self.html_name} to {bucket.name}")
                bucket.Object(key=f"{subdir}/{self.html_name}").put(
                    ACL="public-read",
                    CacheControl="no-cache,no-store,must-revalidate",
                    ContentType="text/html",
                    Body=index_html,
                )

    def upload_pep503_htmls(self) -> None:
        for subdir in self.subdirs:
            index_html = self.to_simple_packages_html(subdir=subdir)

            for bucket in INDEX_BUCKETS:
                print(f"INFO Uploading {subdir}/index.html to {bucket.name}")
                bucket.Object(key=f"{subdir}/index.html").put(
                    ACL="public-read",
                    CacheControl="no-cache,no-store,must-revalidate",
                    ContentType="text/html",
                    Body=index_html,
                )
            for pkg_name in self.get_package_names(subdir=subdir):
                compat_pkg_name = pkg_name.lower().replace("_", "-")
                index_html = self.to_simple_package_html(
                    subdir=subdir, package_name=pkg_name
                )
                for bucket in INDEX_BUCKETS:
                    print(
                        f"INFO Uploading {subdir}/{compat_pkg_name}/index.html to {bucket.name}"
                    )
                    bucket.Object(key=f"{subdir}/{compat_pkg_name}/index.html").put(
                        ACL="public-read",
                        CacheControl="no-cache,no-store,must-revalidate",
                        ContentType="text/html",
                        Body=index_html,
                    )

    def save_libtorch_html(self) -> None:
        for subdir in self.subdirs:
            print(f"INFO Saving {subdir}/{self.html_name}")
            makedirs(subdir, exist_ok=True)
            with open(
                path.join(subdir, self.html_name), mode="w", encoding="utf-8"
            ) as f:
                f.write(self.to_libtorch_html(subdir=subdir))

    def save_pep503_htmls(self) -> None:
        for subdir in self.subdirs:
            print(f"INFO Saving {subdir}/index.html")
            makedirs(subdir, exist_ok=True)
            with open(path.join(subdir, "index.html"), mode="w", encoding="utf-8") as f:
                f.write(self.to_simple_packages_html(subdir=subdir))
            for pkg_name in self.get_package_names(subdir=subdir):
                makedirs(path.join(subdir, pkg_name), exist_ok=True)
                with open(
                    path.join(subdir, pkg_name, "index.html"),
                    mode="w",
                    encoding="utf-8",
                ) as f:
                    f.write(
                        self.to_simple_package_html(
                            subdir=subdir, package_name=pkg_name
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
        for obj in BUCKET.objects.filter(Prefix=prefix):
            is_acceptable = any(
                [path.dirname(obj.key) == prefix]
                + [
                    match(f"{prefix}/{pattern}", path.dirname(obj.key))
                    for pattern in ACCEPTED_SUBDIR_PATTERNS
                ]
            ) and obj.key.endswith(ACCEPTED_FILE_EXTENSIONS)
            if not is_acceptable:
                continue
            obj_names.append(obj.key)
        return obj_names

    def fetch_metadata(self) -> None:
        # Add PEP 503-compatible hashes to URLs to allow clients to avoid spurious downloads, if possible.
        regex_multipart_upload = r"^[A-Za-z0-9+/=]+=-[0-9]+$"
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
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

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
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
        if prefix == "whl/nightly":
            rc.objects = rc.nightly_packages_to_show()
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


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser("Manage S3 HTML indices for PyTorch")
    parser.add_argument("prefix", type=str, choices=PREFIXES + ["all"])
    parser.add_argument("--do-not-upload", action="store_true")
    parser.add_argument("--compute-sha256", action="store_true")
    return parser


def main() -> None:
    parser = create_parser()
    args = parser.parse_args()
    action = "Saving indices" if args.do_not_upload else "Uploading indices"
    if args.compute_sha256:
        action = "Computing checksums"

    prefixes = PREFIXES if args.prefix == "all" else [args.prefix]
    for prefix in prefixes:
        generate_pep503 = prefix.startswith("whl")
        print(f"INFO: {action} for '{prefix}'")
        stime = time.time()
        idx = S3Index.from_S3(
            prefix=prefix, with_metadata=generate_pep503 or args.compute_sha256
        )
        etime = time.time()
        print(
            f"DEBUG: Fetched {len(idx.objects)} objects for '{prefix}' in {etime - stime:.2f} seconds"
        )
        if args.compute_sha256:
            idx.compute_sha256()
        elif args.do_not_upload:
            if generate_pep503:
                idx.save_pep503_htmls()
            else:
                idx.save_libtorch_html()
        else:
            if generate_pep503:
                idx.upload_pep503_htmls()
            else:
                idx.upload_libtorch_html()


if __name__ == "__main__":
    main()
