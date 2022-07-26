import subprocess
import re

from datetime import datetime
from pathlib import Path
from typing import List

LEADING_V_PATTERN = re.compile("^v")
TRAILING_RC_PATTERN = re.compile("-rc[0-9]*$")
LEGACY_BASE_VERSION_SUFFIX_PATTERN = re.compile("a0$")


class NoGitTagException(Exception):
    pass


def get_root_dir() -> Path:
    return Path(
        subprocess.check_output(["git", "rev-parse", "--show-toplevel"])
        .decode("ascii")
        .strip()
    )


def get_tag() -> str:
    root = get_root_dir()
    # We're on a tag
    am_on_tag = (
        subprocess.run(
            ["git", "describe", "--tags", "--exact"],
            cwd=root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        == 0
    )
    tag = ""
    if am_on_tag:
        dirty_tag = (
            subprocess.check_output(["git", "describe"], cwd=root)
            .decode("ascii")
            .strip()
        )
        # Strip leading v that we typically do when we tag branches
        # ie: v1.7.1 -> 1.7.1
        tag = re.sub(LEADING_V_PATTERN, "", dirty_tag)
        # Strip trailing rc pattern
        # ie: 1.7.1-rc1 -> 1.7.1
        tag = re.sub(TRAILING_RC_PATTERN, "", tag)
    return tag


def get_base_version() -> str:
    root = get_root_dir()
    try:
        dirty_version = open(root / "version.txt", "r").read().strip()
    except FileNotFoundError:
        print("# WARNING: Base version not found defaulting BUILD_VERSION to 0.1.0")
        dirty_version = "0.1.0"
    # Strips trailing a0 from version.txt, not too sure why it's there in the
    # first place
    return re.sub(LEGACY_BASE_VERSION_SUFFIX_PATTERN, "", dirty_version)


class PytorchVersion:
    def __init__(
        self,
        gpu_arch_version: str,
        no_build_suffix: bool,
        base_build_version: str,
    ) -> None:
        self.gpu_arch_version = gpu_arch_version
        self.no_build_suffix = no_build_suffix
        if base_build_version == "":
            base_build_version = get_base_version()
        self.base_build_version = base_build_version

    def get_post_build_suffix(self) -> str:
        if self.no_build_suffix:
            return ""
        return f"+{self.gpu_arch_version}"

    def get_release_version(self) -> str:
        if self.base_build_version:
            return f"{self.base_build_version}{self.get_post_build_suffix()}"
        if not get_tag():
            raise NoGitTagException(
                "Not on a git tag, are you sure you want a release version?"
            )
        return f"{get_tag()}{self.get_post_build_suffix()}"

    def get_nightly_version(self) -> str:
        date_str = datetime.today().strftime("%Y%m%d")
        build_suffix = self.get_post_build_suffix()
        return f"{self.base_build_version}.dev{date_str}{build_suffix}"


def get_version_variables(
    package_type: str,
    channel: str,
    gpu_arch_version: str,
    build_version: str,
    platform: str,
) -> List[str]:
    version = PytorchVersion(
        gpu_arch_version=gpu_arch_version,
        no_build_suffix=(platform == "darwin" or package_type == "conda"),
        base_build_version=build_version,
    )
    output_version = version.get_nightly_version()
    if channel == "test":
        output_version = version.get_release_version()
    return [f"export BUILD_VERSION='{output_version}'"]
