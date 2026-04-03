#!/usr/bin/env python3
"""Unit tests for build.py pure helper functions."""

import textwrap
from pathlib import Path

import pytest
from build import (
    cp_tag,
    load_skip_list,
    normalize_name,
    python_path,
    wheel_matches,
    write_failure_summary,
)


# ---------------------------------------------------------------------------
# python_path
# ---------------------------------------------------------------------------


class TestPythonPath:
    def test_standard(self):
        assert python_path("3.13") == "/opt/python/cp313-cp313/bin/python"

    def test_free_threaded(self):
        assert python_path("3.13t") == "/opt/python/cp313-cp313t/bin/python"

    def test_old_version(self):
        assert python_path("3.10") == "/opt/python/cp310-cp310/bin/python"

    def test_future_free_threaded(self):
        assert python_path("3.14t") == "/opt/python/cp314-cp314t/bin/python"


# ---------------------------------------------------------------------------
# cp_tag
# ---------------------------------------------------------------------------


class TestCpTag:
    def test_standard(self):
        assert cp_tag("3.13") == "cp313"

    def test_free_threaded(self):
        assert cp_tag("3.13t") == "cp313t"

    def test_old(self):
        assert cp_tag("3.10") == "cp310"

    def test_future(self):
        assert cp_tag("3.14t") == "cp314t"


# ---------------------------------------------------------------------------
# normalize_name
# ---------------------------------------------------------------------------


class TestNormalizeName:
    def test_uppercase(self):
        assert normalize_name("PyYAML") == "pyyaml"

    def test_dashes(self):
        assert normalize_name("my-pkg") == "my_pkg"

    def test_dots(self):
        assert normalize_name("a.b.c") == "a_b_c"

    def test_mixed_separators(self):
        assert normalize_name("a.b__c-d") == "a_b_c_d"

    def test_already_normalized(self):
        assert normalize_name("numpy") == "numpy"


# ---------------------------------------------------------------------------
# wheel_matches
# ---------------------------------------------------------------------------

SAMPLE_LISTING = [
    "numpy-2.4.4-cp313-cp313-manylinux_2_28_x86_64.whl",
    "PyYAML-6.0.1-cp312-cp312-manylinux_2_28_x86_64.whl",
    "requests-2.31.0-py3-none-any.whl",
    "uv-0.1.0-py3-none-manylinux_2_28_x86_64.whl",
    "setuptools-69.0.0-py2.py3-none-any.whl",
    "numpy-2.4.4-1-cp313-cp313-manylinux_2_28_x86_64.whl",  # build tag
]


class TestWheelMatches:
    def test_native_cpython_match(self):
        assert wheel_matches("numpy", "2.4.4", "cp313", "x86_64", SAMPLE_LISTING)

    def test_native_cpython_no_match_wrong_tag(self):
        # cp313t should NOT match cp313
        assert not wheel_matches("numpy", "2.4.4", "cp313t", "x86_64", SAMPLE_LISTING)

    def test_pure_python_match(self):
        assert wheel_matches("requests", "2.31.0", "cp313", "x86_64", SAMPLE_LISTING)

    def test_pure_python_py2_py3(self):
        assert wheel_matches("setuptools", "69.0.0", "cp312", "x86_64", SAMPLE_LISTING)

    def test_platform_specific_python_agnostic(self):
        assert wheel_matches("uv", "0.1.0", "cp313", "x86_64", SAMPLE_LISTING)

    def test_no_match_wrong_version(self):
        assert not wheel_matches("numpy", "1.99.0", "cp313", "x86_64", SAMPLE_LISTING)

    def test_no_match_wrong_arch(self):
        assert not wheel_matches("numpy", "2.4.4", "cp313", "aarch64", SAMPLE_LISTING)

    def test_case_insensitive(self):
        # "pyyaml" (normalized) should match "PyYAML" in listing
        assert wheel_matches("pyyaml", "6.0.1", "cp312", "x86_64", SAMPLE_LISTING)

    def test_name_with_plus(self):
        listing = ["c__utilities-1.0-cp313-cp313-manylinux_2_28_x86_64.whl"]
        assert wheel_matches("c__utilities", "1.0", "cp313", "x86_64", listing)

    def test_version_with_plus(self):
        listing = ["torch-2.0+cu128-cp313-cp313-manylinux_2_28_x86_64.whl"]
        assert wheel_matches("torch", "2.0+cu128", "cp313", "x86_64", listing)

    def test_build_tag_match(self):
        assert wheel_matches("numpy", "2.4.4", "cp313", "x86_64", SAMPLE_LISTING)

    def test_empty_listing(self):
        assert not wheel_matches("numpy", "2.4.4", "cp313", "x86_64", [])


# ---------------------------------------------------------------------------
# load_skip_list
# ---------------------------------------------------------------------------


class TestLoadSkipList:
    def test_basic(self, tmp_path: Path):
        skip = tmp_path / "skip.txt"
        skip.write_text(
            textwrap.dedent("""\
            # Comment line
            numpy==2.4.4  3.10
            numba==0.60.0  3.13 3.13t
        """)
        )
        result = load_skip_list(skip)
        assert result == {
            "numpy==2.4.4:3.10",
            "numba==0.60.0:3.13",
            "numba==0.60.0:3.13t",
        }

    def test_blank_lines_and_comments(self, tmp_path: Path):
        skip = tmp_path / "skip.txt"
        skip.write_text(
            textwrap.dedent("""\

            # Only comments

            numpy==2.4.4  3.10  # inline comment
        """)
        )
        result = load_skip_list(skip)
        assert result == {"numpy==2.4.4:3.10"}

    def test_missing_file(self, tmp_path: Path):
        result = load_skip_list(tmp_path / "nonexistent.txt")
        assert result == set()

    def test_normalizes_name(self, tmp_path: Path):
        skip = tmp_path / "skip.txt"
        skip.write_text("PyYAML==6.0  3.13\n")
        result = load_skip_list(skip)
        assert "pyyaml==6.0:3.13" in result

    def test_skips_malformed(self, tmp_path: Path):
        skip = tmp_path / "skip.txt"
        skip.write_text("not-a-spec 3.13\n")
        result = load_skip_list(skip)
        assert result == set()


# ---------------------------------------------------------------------------
# write_failure_summary
# ---------------------------------------------------------------------------


class TestWriteFailureSummary:
    def test_no_failures(self, tmp_path: Path):
        out = tmp_path / "summary.txt"
        write_failure_summary([], out)
        assert out.read_text() == ""

    def test_grouped_output(self, tmp_path: Path):
        out = tmp_path / "summary.txt"
        failures = [
            ("numpy==2.4.4", "3.13"),
            ("numpy==2.4.4", "3.10"),
            ("scipy==1.14.1", "3.13t"),
        ]
        write_failure_summary(failures, out)
        text = out.read_text()
        assert "numpy==2.4.4:" in text
        assert "  - 3.10" in text
        assert "  - 3.13" in text
        assert "scipy==1.14.1:" in text
        assert "  - 3.13t" in text

    def test_sorted_by_package(self, tmp_path: Path):
        out = tmp_path / "summary.txt"
        failures = [
            ("zlib==1.0", "3.13"),
            ("aiohttp==3.9", "3.12"),
        ]
        write_failure_summary(failures, out)
        text = out.read_text()
        assert text.index("aiohttp") < text.index("zlib")
