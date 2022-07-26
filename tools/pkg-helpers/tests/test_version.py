from datetime import datetime

import pytest

from pytorch_pkg_helpers.version import get_version_variables

DATE_STR = datetime.today().strftime("%Y%m%d")


@pytest.mark.parametrize(
    "platform,channel,gpu_arch_version,expected",
    [
        ("linux", "nightly", "cpu", f"0.1.0.dev{DATE_STR}"),
        ("linux", "test", "cpu", "0.1.0"),
        ("linux", "nightly", "cu116", f"0.1.0.dev{DATE_STR}"),
        ("linux", "test", "cu116", "0.1.0"),
        ("win32", "nightly", "cpu", f"0.1.0.dev{DATE_STR}"),
        ("win32", "test", "cpu", "0.1.0"),
        ("win32", "nightly", "cu116", f"0.1.0.dev{DATE_STR}"),
        ("win32", "test", "cu116", "0.1.0"),
        ("darwin", "nightly", "cpu", f"0.1.0.dev{DATE_STR}"),
        ("darwin", "test", "cpu", "0.1.0"),
    ],
)
def test_get_version_variables_conda(platform, channel, gpu_arch_version, expected):
    assert get_version_variables(
        package_type="conda",
        channel=channel,
        gpu_arch_version=gpu_arch_version,
        build_version="0.1.0",
        platform=platform,
    ) == [f"export BUILD_VERSION='{expected}'"]


@pytest.mark.parametrize(
    "platform,channel,gpu_arch_version,expected",
    [
        ("linux", "nightly", "cpu", f"0.1.0.dev{DATE_STR}+cpu"),
        ("linux", "test", "cpu", "0.1.0+cpu"),
        ("linux", "nightly", "cu116", f"0.1.0.dev{DATE_STR}+cu116"),
        ("linux", "test", "cu116", "0.1.0+cu116"),
        ("linux", "nightly", "rocm5.4.1", f"0.1.0.dev{DATE_STR}+rocm5.4.1"),
        ("linux", "test", "rocm5.4.1", "0.1.0+rocm5.4.1"),
        ("win32", "nightly", "cpu", f"0.1.0.dev{DATE_STR}+cpu"),
        ("win32", "test", "cpu", "0.1.0+cpu"),
        ("win32", "nightly", "cu116", f"0.1.0.dev{DATE_STR}+cu116"),
        ("win32", "test", "cu116", "0.1.0+cu116"),
        ("darwin", "nightly", "cpu", f"0.1.0.dev{DATE_STR}"),
        ("darwin", "test", "cpu", "0.1.0"),
    ],
)
def test_get_version_variables_wheel(platform, channel, gpu_arch_version, expected):
    assert get_version_variables(
        package_type="wheel",
        channel=channel,
        gpu_arch_version=gpu_arch_version,
        build_version="0.1.0",
        platform=platform,
    ) == [f"export BUILD_VERSION='{expected}'"]
