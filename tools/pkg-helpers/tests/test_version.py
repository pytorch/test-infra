import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pytest  # type: ignore[import-not-found]
from pytorch_pkg_helpers import version
from pytorch_pkg_helpers.version import get_version_variables


PACKAGE_ROOT = Path(__file__).resolve().parent.parent


DATE_STR = datetime.today().strftime("%Y%m%d")


@pytest.mark.parametrize(
    "platform,channel,gpu_arch_version,expected",
    [
        ("linux", "nightly", "cpu", f"0.12.1.dev{DATE_STR}+cpu"),
        ("linux", "test", "cpu", "0.12.1+cpu"),
        ("linux", "nightly", "cu116", f"0.12.1.dev{DATE_STR}+cu116"),
        ("linux", "test", "cu116", "0.12.1+cu116"),
        ("linux", "nightly", "rocm5.4.1", f"0.12.1.dev{DATE_STR}+rocm5.4.1"),
        ("linux", "test", "rocm5.4.1", "0.12.1+rocm5.4.1"),
        ("win32", "nightly", "cpu", f"0.12.1.dev{DATE_STR}+cpu"),
        ("win32", "test", "cpu", "0.12.1+cpu"),
        ("win32", "nightly", "cu116", f"0.12.1.dev{DATE_STR}+cu116"),
        ("win32", "test", "cu116", "0.12.1+cu116"),
        ("darwin", "nightly", "cpu", f"0.12.1.dev{DATE_STR}"),
        ("darwin", "test", "cpu", "0.12.1"),
    ],
)
def test_get_version_variables_wheel(platform, channel, gpu_arch_version, expected):
    assert get_version_variables(
        package_type="wheel",
        channel=channel,
        gpu_arch_version=gpu_arch_version,
        base_build_version="0.12.1",
        platform=platform,
    ) == [f"export BUILD_VERSION='{expected}'"]


# Fixed point in time so the tests do not depend on the day they run on, which
# otherwise makes the future-date cases meaningless and flakes at midnight.
FROZEN_TODAY = datetime(2026, 10, 8, 12, 0, 0)


class FrozenDatetime(datetime):
    @classmethod
    def today(cls):
        return FROZEN_TODAY

    @classmethod
    def now(cls, tz=None):
        return FROZEN_TODAY.replace(tzinfo=tz)


@pytest.fixture
def frozen_clock(monkeypatch):
    monkeypatch.setattr(version, "datetime", FrozenDatetime)


def build_version(channel="nightly", nightly_date=""):
    return get_version_variables(
        package_type="wheel",
        channel=channel,
        gpu_arch_version="cpu",
        base_build_version="0.12.1",
        platform="linux",
        nightly_date=nightly_date,
    )


@pytest.mark.parametrize("unset", ["", "   "])
def test_nightly_date_defaults_to_today(frozen_clock, unset):
    assert build_version(nightly_date=unset) == [
        "export BUILD_VERSION='0.12.1.dev20261008+cpu'"
    ]


@pytest.mark.parametrize("given", ["20250101", "  20250101  ", "20240229", "20261008"])
def test_nightly_date_pins_the_stamp(frozen_clock, given):
    assert build_version(nightly_date=given) == [
        f"export BUILD_VERSION='0.12.1.dev{given.strip()}+cpu'"
    ]


@pytest.mark.parametrize(
    "bad",
    [
        "2025-01-01",
        "notadate",
        "202501011",
        "2025011",
        "20250230",  # February never has 30 days
        "99999999",
    ],
)
def test_nightly_date_rejects_dates_that_cannot_exist(frozen_clock, bad):
    with pytest.raises(ValueError):
        build_version(nightly_date=bad)


@pytest.mark.parametrize("ahead", ["20261009", "20991231"])
def test_nightly_date_rejects_the_future(frozen_clock, ahead):
    with pytest.raises(ValueError):
        build_version(nightly_date=ahead)


@pytest.mark.parametrize("given", ["notadate", "99999999"])
def test_release_version_never_looks_at_the_date(frozen_clock, given):
    # A release build has no date in its version, so a bad value left in a
    # workflow must not fail it.
    assert build_version(channel="test", nightly_date=given) == [
        "export BUILD_VERSION='0.12.1+cpu'"
    ]


def test_main_reads_the_date_from_the_environment(tmp_path):
    # The only check that the command line default is wired to the variable the
    # build workflows set from the matrix.
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytorch_pkg_helpers",
            "--package-type=wheel",
            "--channel=nightly",
            "--gpu-arch-version=cpu",
            "--platform=linux",
            "--base-build-version=0.12.1",
        ],
        env={
            **os.environ,
            "NIGHTLY_DATE": "20250101",
            # Run from an empty directory so the base version cannot come from
            # a checkout, and point at the package so it need not be installed.
            "PYTHONPATH": str(PACKAGE_ROOT),
        },
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "export BUILD_VERSION='0.12.1.dev20250101+cpu'" in result.stdout
