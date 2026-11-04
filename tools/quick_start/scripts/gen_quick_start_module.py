#!/usr/bin/env python3
"""
Generates the data for the quick start module on the
https://pytorch.org/get-started/locally/ page.
Updates published_versions.json and releases.json from the getting-started
matrices of tools/scripts/generate_binary_build_matrix.py.
"""

import copy
import json
import os
import subprocess
import sys
from enum import Enum
from pathlib import Path
from typing import Dict


BASE_DIR = Path(__file__).parent.parent
MATRIX_SCRIPT = BASE_DIR.parent / "scripts" / "generate_binary_build_matrix.py"


class OperatingSystem(Enum):
    LINUX: str = "linux"
    WINDOWS: str = "windows"
    MACOS: str = "macos"


PRE_CXX11_ABI = "pre-cxx11"
CXX11_ABI = "cxx11-abi"
DEBUG = "debug"
RELEASE = "release"
DEFAULT = "default"
ENABLE = "enable"
DISABLE = "disable"
MACOS = "macos"

# Mapping json to release matrix default values
acc_arch_ver_default = {
    "nightly": {
        "accnone": ("cpu", ""),
        "cuda.x": ("cuda", "11.8"),
        "cuda.y": ("cuda", "12.1"),
        "cuda.z": ("cuda", "12.4"),
        "rocm5.x": ("rocm", "6.0"),
    },
    "release": {
        "accnone": ("cpu", ""),
        "cuda.x": ("cuda", "11.8"),
        "cuda.y": ("cuda", "12.1"),
        "cuda.z": ("cuda", "12.4"),
        "rocm5.x": ("rocm", "6.0"),
    },
}

# Initialize arch version to default values
# these default values will be overwritten by
# extracted values from the release marix
acc_arch_ver_map = acc_arch_ver_default

LIBTORCH_DWNL_INSTR = {
    PRE_CXX11_ABI: "Download here (Pre-cxx11 ABI):",
    CXX11_ABI: "Download here (cxx11 ABI):",
    RELEASE: "Download here (Release version):",
    DEBUG: "Download here (Debug version):",
    MACOS: "Download arm64 libtorch here (ROCm and CUDA are not supported):",
}

MATRIX_OS = {
    OperatingSystem.LINUX: "linux",
    OperatingSystem.WINDOWS: "windows",
    OperatingSystem.MACOS: "macos-arm64",
}

# Same inputs the getting-started page has always passed to
# .github/workflows/generate_binary_build_matrix.yml.
MATRIX_ENV = {
    "PACKAGE_TYPE": "all",
    "GETTING_STARTED": "true",
    "WITH_CUDA": ENABLE,
    "WITH_ROCM": ENABLE,
    "WITH_CPU": ENABLE,
    "WITH_XPU": DISABLE,
    "LIMIT_PR_BUILDS": "false",
    "USE_ONLY_DL_PYTORCH_ORG": "false",
    "BUILD_PYTHON_ONLY": DISABLE,
    "PYTHON_VERSIONS": "[]",
    "PYTHON_ABI3": DISABLE,
    "RUNNER_FLEET": "ec2",
}


def load_json_from_basedir(filename: str):
    try:
        with open(BASE_DIR / filename) as fptr:
            return json.load(fptr)
    except FileNotFoundError as exc:
        raise ImportError(f"File {filename} not found error: {exc.strerror}") from exc
    except json.JSONDecodeError as exc:
        raise ImportError(f"Invalid JSON {filename}") from exc


def read_published_versions():
    return load_json_from_basedir("published_versions.json")


def generate_matrix(osys: OperatingSystem, channel: str):
    env = {**os.environ, **MATRIX_ENV, "OS": MATRIX_OS[osys], "CHANNEL": channel}
    result = subprocess.run(
        [sys.executable, str(MATRIX_SCRIPT)],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)["include"]


def get_package_type(pkg_key: str, os_key: OperatingSystem) -> str:
    if pkg_key != "pip":
        return pkg_key
    return "manywheel" if os_key == OperatingSystem.LINUX.value else "wheel"


def get_gpu_info(acc_key, instr, acc_arch_map):
    if DEFAULT in instr:
        return acc_arch_map["accnone"]
    if acc_key not in acc_arch_map:
        return (None, None)
    return acc_arch_map[acc_key]


# This method is used for generating new published_versions.json file
# It will modify versions json object with installation instructions
# Provided by generate install matrix Github Workflow, stored in release_matrix
# json object.
CUDA_LABELS = ["cuda.x", "cuda.y", "cuda.z"]
UNAVAILABLE_NOTE = "<b>NOTE:</b> Not available for this build"


def sync_cuda_entries(version_entry, acc_arch_map):
    """Match the CUDA entries of a version to the channel's CUDA labels.

    A channel with fewer CUDA versions (e.g. two) drops the unused labels, so
    the entry carries no stale commands for boxes the page hides. A new stable
    is copied from preview, so any label the channel needs but the entry lacks
    is re-created from a sibling entry. Only the entry being updated (preview
    or the latest stable) is touched; older versions keep their labels.
    """
    for os_vers in version_entry.values():
        for pkg_key, pkg_vers in os_vers.items():
            siblings = [pkg_vers[k] for k in CUDA_LABELS if k in pkg_vers]
            if not siblings:
                continue
            rebuilt = {}
            for acc_key, instr in pkg_vers.items():
                if acc_key in CUDA_LABELS and acc_key not in acc_arch_map:
                    continue
                rebuilt[acc_key] = instr
                if acc_key in CUDA_LABELS:
                    # Re-add missing labels right after their predecessor so
                    # cuda.x/y/z stay in order.
                    for label in CUDA_LABELS[CUDA_LABELS.index(acc_key) + 1 :]:
                        if label in pkg_vers:
                            break
                        if label in acc_arch_map:
                            rebuilt[label] = copy.deepcopy(siblings[-1])
            os_vers[pkg_key] = rebuilt


def update_versions(versions, release_matrix, release_version):
    version = "preview"
    template = "preview"
    acc_arch_map = acc_arch_ver_map[release_version]

    if release_version != "nightly":
        version = release_matrix[OperatingSystem.LINUX.value][0]["stable_version"]
        if version not in versions["versions"]:
            versions["versions"][version] = copy.deepcopy(
                versions["versions"][template]
            )
            versions["latest_stable"] = version

    sync_cuda_entries(versions["versions"][version], acc_arch_map)

    # Perform update of the json file from release matrix
    for os_key, os_vers in versions["versions"][version].items():
        for pkg_key, pkg_vers in os_vers.items():
            for acc_key, instr in pkg_vers.items():
                package_type = get_package_type(pkg_key, os_key)
                gpu_arch_type, gpu_arch_version = get_gpu_info(
                    acc_key, instr, acc_arch_map
                )

                pkg_arch_matrix = [
                    x
                    for x in release_matrix[os_key]
                    if (x["package_type"], x["gpu_arch_type"], x["gpu_arch_version"])
                    == (package_type, gpu_arch_type, gpu_arch_version)
                ]

                if gpu_arch_type is None:
                    # The channel ships no build for this accelerator (e.g. no
                    # ROCm version in the matrix): don't keep a stale command.
                    if not instr.get("note"):
                        instr["note"] = UNAVAILABLE_NOTE
                    instr["command" if package_type != "libtorch" else "versions"] = (
                        None
                    )
                    continue

                if pkg_arch_matrix:
                    # A new stable is copied from preview; drop the note an
                    # accelerator got there while the channel lacked it.
                    if instr.get("note") == UNAVAILABLE_NOTE:
                        instr["note"] = None
                    if package_type == "libtorch" and instr.get("versions") is None:
                        instr["versions"] = {}

                # A CUDA version the channel ships but this OS does not (e.g. no
                # Windows build): say so instead of keeping a stale command.
                if gpu_arch_type == "cuda":
                    if pkg_arch_matrix:
                        instr["note"] = None
                    else:
                        instr["note"] = (
                            f"<b>NOTE:</b> CUDA {gpu_arch_version} is not available "
                            f"on {os_key.capitalize()}"
                        )
                        instr[
                            "command" if package_type != "libtorch" else "versions"
                        ] = None

                if pkg_arch_matrix:
                    if package_type != "libtorch":
                        instr["command"] = pkg_arch_matrix[0]["installation"]
                    else:
                        if os_key == OperatingSystem.LINUX.value:
                            rel_entry_dict = {
                                x["devtoolset"]: x["installation"]
                                for x in pkg_arch_matrix
                                if x["libtorch_variant"] == "shared-with-deps"
                            }
                            if instr["versions"] is not None:
                                for ver in [CXX11_ABI, PRE_CXX11_ABI]:
                                    # temporarily remove setting pre-cxx11-abi. For Release 2.7 we
                                    # should remove pre-cxx11-abi completely.
                                    if ver == PRE_CXX11_ABI:
                                        continue
                                    else:
                                        instr["versions"][LIBTORCH_DWNL_INSTR[ver]] = (
                                            rel_entry_dict[ver]
                                        )

                        elif os_key == OperatingSystem.WINDOWS.value:
                            rel_entry_dict = {
                                x["libtorch_config"]: x["installation"]
                                for x in pkg_arch_matrix
                            }
                            if instr["versions"] is not None:
                                # Windows libtorch debug builds are no longer produced, so
                                # only publish the release download and drop any stale
                                # debug entry carried over from previous versions.
                                instr["versions"][LIBTORCH_DWNL_INSTR[RELEASE]] = (
                                    rel_entry_dict[RELEASE]
                                )
                                instr["versions"].pop(LIBTORCH_DWNL_INSTR[DEBUG], None)
                        elif os_key == OperatingSystem.MACOS.value:
                            if instr["versions"] is not None:
                                instr["versions"][LIBTORCH_DWNL_INSTR[MACOS]] = (
                                    pkg_arch_matrix[0]["installation"]
                                )


# This method is used for extracting two latest verisons of cuda and
# last verion of rocm. It will modify the acc_arch_ver_map object used
# to update getting started page.
def extract_arch_ver_map(release_matrix):
    def gen_ver_list(chan, gpu_arch_type):
        return {
            x["desired_cuda"]: x["gpu_arch_version"]
            for x in release_matrix[chan]["linux"]
            if x["gpu_arch_type"] == gpu_arch_type
        }

    # Compare numerically: as strings, "7.14" sorts before "7.2".
    def version_key(ver):
        return tuple(int(part) for part in ver.split("."))

    for chan in ("nightly", "release"):
        cuda_ver_list = gen_ver_list(chan, "cuda")
        rocm_ver_list = gen_ver_list(chan, "rocm")
        cuda_list = sorted(set(cuda_ver_list.values()), key=version_key)
        if len(cuda_list) > len(CUDA_LABELS):
            raise ValueError(
                f"{chan} getting-started matrix has {len(cuda_list)} CUDA versions "
                f"({', '.join(cuda_list)}), but the page has only "
                f"{len(CUDA_LABELS)} CUDA boxes"
            )
        if rocm_ver_list:
            acc_arch_ver_map[chan]["rocm5.x"] = (
                "rocm",
                max(rocm_ver_list.values(), key=version_key),
            )
        else:
            acc_arch_ver_map[chan].pop("rocm5.x", None)
        for cuda_ver, label in zip(cuda_list, CUDA_LABELS):
            acc_arch_ver_map[chan][label] = ("cuda", cuda_ver)
        # Drop labels the channel has no CUDA version for, so the page hides
        # them instead of showing the hard-coded defaults.
        for label in CUDA_LABELS[len(cuda_list) :]:
            acc_arch_ver_map[chan].pop(label, None)


def generate() -> Dict[Path, str]:
    """Return the regenerated files as {path: content}."""
    versions = read_published_versions()

    # releases.json holds the raw matrices; the website derives the
    # per-channel CUDA/ROCm versions of the "Start Locally" picker from it.
    release_matrix = {
        chan: {osys.value: generate_matrix(osys, chan) for osys in OperatingSystem}
        for chan in ("nightly", "release")
    }

    extract_arch_ver_map(release_matrix)
    for chan in ("nightly", "release"):
        update_versions(versions, release_matrix[chan], chan)

    return {
        BASE_DIR / "releases.json": json.dumps(release_matrix, indent=2),
        BASE_DIR / "published_versions.json": json.dumps(versions, indent=2),
    }


def main():
    for path, content in generate().items():
        with open(path, "w", encoding="utf-8", newline="\n") as outfile:
            outfile.write(content)
        print(f"Wrote {path}")


if __name__ == "__main__":
    main()
