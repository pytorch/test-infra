import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import List


LEADING_V_PATTERN = re.compile("^v")
TRAILING_RC_PATTERN = re.compile("-rc[0-9]*$")
LEGACY_BASE_VERSION_SUFFIX_PATTERN = re.compile("a0$")
NIGHTLY_DATE_FORMAT = "%Y%m%d"


class NoGitTagException(Exception):
    pass


def get_nightly_date(nightly_date: str = "") -> str:
    # The day normally comes from the job that generated the build matrix, so
    # that a row rebuilt after midnight keeps the day of its own set. Without
    # one, fall back to this machine's clock, which is the older behaviour.
    nightly_date = nightly_date.strip()
    if not nightly_date:
        return datetime.today().strftime(NIGHTLY_DATE_FORMAT)
    try:
        day = datetime.strptime(nightly_date, NIGHTLY_DATE_FORMAT)
    except ValueError:
        day = None
    if day is None or day.strftime(NIGHTLY_DATE_FORMAT) != nightly_date:
        raise ValueError(
            f"Nightly date must be a real date as YYYYMMDD: {nightly_date!r}"
        )
    # A future date is a valid version number that sorts above every real
    # nightly, so pip would serve it as the newest one. Compared in UTC because
    # that is the zone the matrix job stamps in.
    if day.date() > datetime.now(timezone.utc).date():
        raise ValueError(f"Nightly date is in the future: {nightly_date!r}")
    return nightly_date


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
        nightly_date: str = "",
    ) -> None:
        self.gpu_arch_version = gpu_arch_version
        self.no_build_suffix = no_build_suffix
        self.nightly_date = nightly_date
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
        date_str = get_nightly_date(self.nightly_date)
        build_suffix = self.get_post_build_suffix()
        return f"{self.base_build_version}.dev{date_str}{build_suffix}"


def get_version_variables(
    package_type: str,
    channel: str,
    gpu_arch_version: str,
    base_build_version: str,
    platform: str,
    nightly_date: str = "",
) -> List[str]:
    version = PytorchVersion(
        gpu_arch_version=gpu_arch_version,
        no_build_suffix=(platform == "darwin"),
        base_build_version=base_build_version,
        nightly_date=nightly_date,
    )
    # A release version carries no date, so computing one here would only risk
    # failing the build on a value it then throws away.
    if channel == "test":
        output_version = version.get_release_version()
    else:
        output_version = version.get_nightly_version()
    return [f"export BUILD_VERSION='{output_version}'"]
