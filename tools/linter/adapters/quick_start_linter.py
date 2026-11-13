"""
QUICKSTART: Checks that the generated files in tools/quick_start are up to date.

This is the source of truth for how they are generated. From the build matrices of
tools/scripts/generate_binary_build_matrix.py it builds `published_versions.json` and
`releases.json`, the data behind the install selector on
https://pytorch.org/get-started/locally/. From `_additional_platforms/*.json` and
`_get_started/additional_platforms/*.md` it builds `additional-platforms.json`, the
bundle for the https://pytorch.org/get-started/additional-platforms/ page. Run
`lintrunner --take QUICKSTART --all-files -a` to regenerate them.
"""

import argparse
import contextlib
import copy
import json
import os
import re
import subprocess
import sys
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Set

import markdown
from markdown.extensions.codehilite import CodeHiliteExtension


LINTER_CODE = "QUICKSTART"
REPO_ROOT = Path(__file__).resolve().parents[3]
QUICK_START_DIR = REPO_ROOT / "tools" / "quick_start"
MATRIX_SCRIPT = REPO_ROOT / "tools" / "scripts" / "generate_binary_build_matrix.py"
ADDITIONAL_PLATFORM_DIR = QUICK_START_DIR / "_additional_platforms"
MARKDOWN_DIR = QUICK_START_DIR / "_get_started" / "additional_platforms"


class LintSeverity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    ADVICE = "advice"
    DISABLED = "disabled"


class LintMessage(NamedTuple):
    path: Optional[str]
    line: Optional[int]
    char: Optional[int]
    code: str
    severity: LintSeverity
    name: str
    original: Optional[str]
    replacement: Optional[str]
    description: Optional[str]


# ---- published_versions.json and releases.json ----


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

# CUDA and ROCm entries are filled in from the matrix by extract_arch_ver_map().
acc_arch_ver_map = {
    "nightly": {"accnone": ("cpu", "")},
    "release": {"accnone": ("cpu", "")},
}

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
        with open(QUICK_START_DIR / filename) as fptr:
            return json.load(fptr)
    except FileNotFoundError as exc:
        raise ImportError(f"File {filename} not found error: {exc.strerror}") from exc
    except json.JSONDecodeError as exc:
        raise ImportError(f"Invalid JSON {filename}") from exc


def read_published_versions():
    return load_json_from_basedir("published_versions.json")


def generate_matrix(osys: OperatingSystem, channel: str):
    # GITHUB_REF makes the script treat release branches differently; the result
    # must not depend on the branch this runs on.
    inherited = {k: v for k, v in os.environ.items() if k != "GITHUB_REF"}
    env = {**inherited, **MATRIX_ENV, "OS": MATRIX_OS[osys], "CHANNEL": channel}
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
    return acc_arch_map[acc_key][:2]


def is_rocm_preview(matrix_entry):
    return matrix_entry.get("desired_cuda") == ROCM_PREVIEW_DESIRED_CUDA


# This method is used for generating new published_versions.json file
# It will modify versions json object with installation instructions
# Provided by generate install matrix Github Workflow, stored in release_matrix
# json object.
CUDA_LABELS = ["cuda.x", "cuda.y", "cuda.z"]
UNAVAILABLE_NOTE = "<b>NOTE:</b> Not available for this build"

# ROCm preview (TheRock alpha) wheels; the matrix marks them with this
# desired_cuda, and the page shows them as a second ROCm box.
ROCM_PREVIEW_DESIRED_CUDA = "rocm-preview"
ROCM_LABEL = "rocm5.x"
ROCM_ALPHA_LABEL = "rocm.alpha"


def sync_rocm_alpha_entries(version_entry, acc_arch_map):
    """Add the ROCm alpha box to an entry when the channel ships it, else drop it.

    It is seeded from the ROCm entry so OSes without ROCm keep their notes.
    """
    for os_vers in version_entry.values():
        for pkg_key, pkg_vers in os_vers.items():
            if ROCM_ALPHA_LABEL not in acc_arch_map:
                pkg_vers.pop(ROCM_ALPHA_LABEL, None)
                continue
            if ROCM_ALPHA_LABEL in pkg_vers or ROCM_LABEL not in pkg_vers:
                continue
            rebuilt = {}
            for acc_key, instr in pkg_vers.items():
                rebuilt[acc_key] = instr
                if acc_key == ROCM_LABEL:
                    rebuilt[ROCM_ALPHA_LABEL] = copy.deepcopy(instr)
            os_vers[pkg_key] = rebuilt


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
    sync_rocm_alpha_entries(versions["versions"][version], acc_arch_map)

    # Perform update of the json file from release matrix
    for os_key, os_vers in versions["versions"][version].items():
        for pkg_key, pkg_vers in os_vers.items():
            for acc_key, instr in pkg_vers.items():
                package_type = get_package_type(pkg_key, os_key)
                gpu_arch_type, gpu_arch_version = get_gpu_info(
                    acc_key, instr, acc_arch_map
                )
                want_preview = acc_key == ROCM_ALPHA_LABEL and DEFAULT not in instr

                pkg_arch_matrix = [
                    x
                    for x in release_matrix[os_key]
                    if (x["package_type"], x["gpu_arch_type"], x["gpu_arch_version"])
                    == (package_type, gpu_arch_type, gpu_arch_version)
                    and is_rocm_preview(x) == want_preview
                ]

                if (
                    want_preview
                    and not pkg_arch_matrix
                    and os_key == OperatingSystem.LINUX.value
                ):
                    # The alpha ships pip wheels only, no libtorch.
                    instr["note"] = UNAVAILABLE_NOTE
                    instr["command" if package_type != "libtorch" else "versions"] = (
                        None
                    )
                    continue

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
            if x["gpu_arch_type"] == gpu_arch_type and not is_rocm_preview(x)
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
            acc_arch_ver_map[chan].pop(ROCM_LABEL, None)
        rocm_preview = [
            x["gpu_arch_version"]
            for x in release_matrix[chan]["linux"]
            if is_rocm_preview(x)
        ]
        if rocm_preview:
            acc_arch_ver_map[chan][ROCM_ALPHA_LABEL] = (
                "rocm",
                rocm_preview[0],
                "alpha",
            )
        else:
            acc_arch_ver_map[chan].pop(ROCM_ALPHA_LABEL, None)
        for cuda_ver, label in zip(cuda_list, CUDA_LABELS):
            acc_arch_ver_map[chan][label] = ("cuda", cuda_ver)


def generate_versions() -> Dict[Path, str]:
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
        QUICK_START_DIR / "releases.json": json.dumps(release_matrix, indent=2) + "\n",
        QUICK_START_DIR / "published_versions.json": json.dumps(versions, indent=2)
        + "\n",
    }


# ---- additional-platforms.json ----

# External consumer JSON bundle
# Bump SCHEMA_VERSION on any breaking change
# to the `platforms` / `html` shape.
SCHEMA_VERSION = 1
JSON_OUT_PATH = "additional-platforms.json"

# Schema definitions derived from additional_platforms.md
REQUIRED_TOP_LEVEL_FIELDS: Set[str] = {"name", "support_channel", "stable"}
ALLOWED_TOP_LEVEL_FIELDS: Set[str] = {"name", "support_channel", "stable", "preview"}
# At least one OS key from ALLOWED_INSTALL_KEYS must be present in stable/preview
ALLOWED_INSTALL_KEYS: Set[str] = {"linux", "windows"}
MAX_MARKDOWN_LINES: int = 200


def validate_platform_json(
    platform_id: str, data: Dict[str, Any], filename: str
) -> None:
    """Validate a platform JSON against the schema defined in additional_platforms.md.

    Checks that:
    1. All required top-level fields are present (name, support_channel, stable; preview is optional)
    2. No extra/unknown top-level fields are present
    3. 'stable' and 'preview' objects (if present) contain at least one OS key ('linux' or 'windows')
    4. 'stable' and 'preview' objects (if present) only contain allowed keys ('linux', 'windows')

    Raises RuntimeError if any validation check fails.
    """
    errors: List[str] = []

    # Check required top-level fields
    present_fields = set(data.keys())
    missing_fields = REQUIRED_TOP_LEVEL_FIELDS - present_fields
    if missing_fields:
        errors.append(
            f"Missing required fields: {sorted(missing_fields)}. "
            f"Required fields are: {sorted(REQUIRED_TOP_LEVEL_FIELDS)}"
        )

    # Check for extra/unknown top-level fields
    extra_fields = present_fields - ALLOWED_TOP_LEVEL_FIELDS
    if extra_fields:
        errors.append(
            f"Unknown fields: {sorted(extra_fields)}. "
            f"Only allowed fields are: {sorted(ALLOWED_TOP_LEVEL_FIELDS)}"
        )

    # Validate 'stable' and 'preview' objects
    for field in ["stable", "preview"]:
        if field in data:
            install_data = data[field]
            if not isinstance(install_data, dict):
                errors.append(
                    f"Field '{field}' must be an object, got {type(install_data).__name__}"
                )
            else:
                install_keys = set(install_data.keys())

                # Check that at least one allowed OS key is present
                present_install_keys = install_keys & ALLOWED_INSTALL_KEYS
                if not present_install_keys:
                    errors.append(
                        f"Field '{field}' must contain at least one OS key from "
                        f"{sorted(ALLOWED_INSTALL_KEYS)}, but found none. "
                        f"Existing keys: {sorted(install_keys)}"
                    )

                # Check for unknown install keys
                extra_install_keys = install_keys - ALLOWED_INSTALL_KEYS
                if extra_install_keys:
                    errors.append(
                        f"Field '{field}' contains unknown OS key(s): "
                        f"{sorted(extra_install_keys)}. "
                        f"Only allowed OS keys are: {sorted(ALLOWED_INSTALL_KEYS)}"
                    )

    if errors:
        error_msg = "\n  - ".join(errors)
        raise RuntimeError(
            f"Validation error in {filename} (platform_id: {platform_id}):\n  - {error_msg}"
        )


def read_platform_json_files() -> Dict[str, Any]:
    """Read all JSON files from _additional_platforms directory and validate them."""
    platform_data: Dict[str, Any] = {}

    if not ADDITIONAL_PLATFORM_DIR.exists():
        print(f"Warning: {ADDITIONAL_PLATFORM_DIR} does not exist")
        return platform_data

    for json_file in sorted(ADDITIONAL_PLATFORM_DIR.glob("*.json")):
        try:
            content = json_file.read_text(encoding="utf-8")
            data = json.loads(content)
            # Use filename (without .json) as platform_id
            platform_id = json_file.stem
            # Validate the JSON data against the schema
            validate_platform_json(platform_id, data, json_file.name)
            platform_data[platform_id] = data
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Error parsing {json_file.name}: {e}")

    return platform_data


def convert_markdown_to_html(markdown_text: str) -> str:
    """Convert markdown to HTML with syntax highlighting.

    Uses Python markdown library with codehilite extension for syntax highlighting.
    This produces HTML similar to Jekyll's markdownify filter.
    """
    # Remove Jekyll/Kramdown special syntax (e.g., {:.no_toc}, {: #id})
    html_text = re.sub(r"\{:[^}]*\}", "", markdown_text)

    # Convert markdown to HTML with codehilite extension
    # Codehilite uses Pygments for syntax highlighting (similar to Rouge used by Jekyll)
    md = markdown.Markdown(
        extensions=[
            CodeHiliteExtension(
                css_class="highlight", guess_lang=False, linenums=False
            ),
            "fenced_code",
            "tables",
            "toc",
        ]
    )

    html = md.convert(html_text)
    return html


def validate_markdown_file(platform_id: str, content: str, filename: str) -> None:
    """Validate a markdown file against the rules defined in additional_platforms.md.

    Checks that:
    1. The markdown file does not exceed 200 lines

    Raises RuntimeError if any validation check fails.
    """
    errors: List[str] = []

    line_count = len(content.splitlines())
    if line_count > MAX_MARKDOWN_LINES:
        errors.append(
            f"Markdown file exceeds maximum line limit: {line_count} lines "
            f"(maximum allowed: {MAX_MARKDOWN_LINES} lines)"
        )

    if errors:
        error_msg = "\n  - ".join(errors)
        raise RuntimeError(
            f"Validation error in {filename} (platform_id: {platform_id}):\n  - {error_msg}"
        )


def read_markdown_files() -> Dict[str, str]:
    """Read all markdown files from _get_started/additional_platforms directory,
    validate them, and convert them to HTML with syntax highlighting."""
    html_content: Dict[str, str] = {}

    if not MARKDOWN_DIR.exists():
        print(f"Warning: {MARKDOWN_DIR} does not exist")
        return html_content

    for md_file in sorted(MARKDOWN_DIR.glob("*.md")):
        try:
            content = md_file.read_text(encoding="utf-8")
            # Use filename (without .md) as platform_id
            platform_id = md_file.stem
            # Validate the markdown content
            validate_markdown_file(platform_id, content, md_file.name)
            # Convert markdown to HTML with syntax highlighting
            html = convert_markdown_to_html(content)
            html_content[platform_id] = html
        except Exception as e:
            raise RuntimeError(f"Error processing {md_file.name}: {e}")

    return html_content


def generate_additional_platforms() -> Dict[Path, str]:
    """Return the regenerated files as {path: content}."""
    payload = {
        "schema_version": SCHEMA_VERSION,
        "platforms": read_platform_json_files(),
        "html": read_markdown_files(),
    }
    content = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    return {QUICK_START_DIR / JSON_OUT_PATH: content}


# Each generator returns {path: content} for the files it owns.
GENERATORS = {
    "published_versions.json and releases.json": generate_versions,
    "additional-platforms.json": generate_additional_platforms,
}


def check_generator(name: str, generate: Any) -> List[LintMessage]:
    try:
        # stdout is reserved for lint messages.
        with contextlib.redirect_stdout(sys.stderr):
            files = generate()
    except Exception as err:
        detail = err.stderr if isinstance(err, subprocess.CalledProcessError) else ""
        return [
            LintMessage(
                path=None,
                line=None,
                char=None,
                code=LINTER_CODE,
                severity=LintSeverity.ERROR,
                name="Generator failed",
                original=None,
                replacement=None,
                description=f"Generating {name} failed with {err.__class__.__name__}: {err}\n{detail}",
            )
        ]

    messages = []
    for path, replacement in files.items():
        original = path.read_text(encoding="utf-8") if path.exists() else ""
        if original != replacement:
            messages.append(
                LintMessage(
                    path=path.relative_to(REPO_ROOT).as_posix(),
                    line=None,
                    char=None,
                    code=LINTER_CODE,
                    severity=LintSeverity.ERROR,
                    name="Generated file out of date",
                    original=original,
                    replacement=replacement,
                    description="Regenerated by tools/linter/adapters/quick_start_linter.py. "
                    "Run `lintrunner -a --take QUICKSTART` to apply changes.",
                )
            )
    return messages


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="tools/quick_start generated files linter",
        fromfile_prefix_chars="@",
    )
    # Only used by lintrunner to decide whether to run; every generator always runs.
    parser.add_argument("filenames", nargs="*", help="paths to lint")
    parser.parse_args()

    for generator_name, generator in GENERATORS.items():
        for lint_message in check_generator(generator_name, generator):
            print(json.dumps(lint_message._asdict()), flush=True)
