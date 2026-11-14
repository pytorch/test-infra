"""Tests for the published_versions.json logic in the QUICKSTART linter.

The lint only compares regenerated files with the committed ones, so a change
that leaves a stale command in place still passes it; these tests feed the
generator crafted matrices instead.
"""

import copy
import importlib.util
import unittest
from pathlib import Path

import generate_binary_build_matrix


LINTER_PATH = (
    Path(__file__).resolve().parents[1]
    / "linter"
    / "adapters"
    / "quick_start_linter.py"
)
PREVIEW_CMD = (
    "pip3 install --pre torch --index-url "
    "https://download.pytorch.org/whl/nightly/rocm-preview"
)


def load_linter():
    # A fresh module per test: acc_arch_ver_map is module-level state.
    spec = importlib.util.spec_from_file_location("quick_start_linter", LINTER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wheel(gpu_arch_type, version, desired_cuda, installation, stable="2.15.0"):
    return {
        "package_type": "manywheel",
        "gpu_arch_type": gpu_arch_type,
        "gpu_arch_version": version,
        "desired_cuda": desired_cuda,
        "installation": installation,
        "stable_version": stable,
    }


def libtorch(version, desired_cuda, installation, stable="2.15.0"):
    return {
        "package_type": "libtorch",
        "gpu_arch_type": "rocm",
        "gpu_arch_version": version,
        "desired_cuda": desired_cuda,
        "libtorch_variant": "shared-with-deps",
        "devtoolset": "cxx11-abi",
        "installation": installation,
        "stable_version": stable,
    }


def channel_matrix(rocm, preview=None, stable="2.15.0"):
    linux = [wheel("cpu", "", "cpu", f"cpu-{stable}", stable)]
    if rocm:
        linux += [
            wheel("rocm", rocm, f"rocm{rocm}", f"pip-rocm{rocm}", stable),
            libtorch(rocm, f"rocm{rocm}", f"libtorch-rocm{rocm}", stable),
        ]
    if preview:
        linux.append(wheel("rocm", preview, "rocm-preview", PREVIEW_CMD, stable))
    return {"linux": linux, "windows": [], "macos": []}


def version_entry():
    rocm_note = "<b>NOTE:</b> ROCm is not available on Windows"
    return {
        "linux": {
            "pip": {
                "accnone": {"note": None, "command": "stale"},
                "rocm5.x": {"note": None, "command": "stale"},
            },
            "libtorch": {
                "accnone": {"note": None, "versions": None},
                "rocm5.x": {
                    "note": None,
                    "versions": {"Download here (cxx11 ABI):": "stale"},
                },
            },
        },
        "windows": {
            "pip": {
                "accnone": {"note": None, "command": "stale"},
                "rocm5.x": {"note": rocm_note, "command": None},
            },
        },
    }


def published_versions():
    return {
        "latest_stable": "2.15.0",
        "versions": {"preview": version_entry(), "2.15.0": version_entry()},
    }


class TestQuickStartRocmAlpha(unittest.TestCase):
    def generate(self, linter, versions, nightly, release):
        matrix = {"nightly": nightly, "release": release}
        linter.extract_arch_ver_map(matrix)
        for chan in ("nightly", "release"):
            linter.update_versions(versions, matrix[chan], chan)
        return versions

    def test_preview_does_not_set_the_rocm_version(self):
        linter = load_linter()
        versions = self.generate(
            linter,
            published_versions(),
            channel_matrix("10.1", preview="10.3"),
            channel_matrix("10.0"),
        )
        self.assertEqual(
            linter.acc_arch_ver_map["nightly"]["rocm5.x"], ("rocm", "10.1")
        )
        self.assertEqual(
            linter.acc_arch_ver_map["nightly"]["rocm.alpha"], ("rocm", "10.3", "alpha")
        )
        self.assertNotIn("rocm.alpha", linter.acc_arch_ver_map["release"])
        pip = versions["versions"]["preview"]["linux"]["pip"]
        self.assertEqual(pip["rocm5.x"]["command"], "pip-rocm10.1")
        self.assertEqual(pip["rocm.alpha"]["command"], PREVIEW_CMD)

    def test_preview_is_matched_by_channel_not_version(self):
        versions = self.generate(
            load_linter(),
            published_versions(),
            channel_matrix("10.1", preview="10.1"),
            channel_matrix("10.0"),
        )
        pip = versions["versions"]["preview"]["linux"]["pip"]
        self.assertEqual(pip["rocm5.x"]["command"], "pip-rocm10.1")
        self.assertEqual(pip["rocm.alpha"]["command"], PREVIEW_CMD)

    def test_alpha_entries_for_libtorch_and_windows(self):
        linter = load_linter()
        versions = self.generate(
            linter,
            published_versions(),
            channel_matrix("10.1", preview="10.3"),
            channel_matrix("10.0"),
        )
        preview = versions["versions"]["preview"]
        self.assertEqual(
            preview["linux"]["libtorch"]["rocm.alpha"],
            {"note": linter.UNAVAILABLE_NOTE, "versions": None},
        )
        self.assertEqual(
            preview["windows"]["pip"]["rocm.alpha"],
            preview["windows"]["pip"]["rocm5.x"],
        )
        self.assertEqual(
            list(preview["linux"]["pip"]), ["accnone", "rocm5.x", "rocm.alpha"]
        )

    def test_stable_never_gets_alpha(self):
        versions = self.generate(
            load_linter(),
            published_versions(),
            channel_matrix("10.1", preview="10.3"),
            channel_matrix("10.0", stable="2.16.0"),
        )
        # 2.16.0 is new, so it is copied from preview, which has the alpha.
        self.assertEqual(versions["latest_stable"], "2.16.0")
        for os_vers in versions["versions"]["2.16.0"].values():
            for pkg_vers in os_vers.values():
                self.assertNotIn("rocm.alpha", pkg_vers)
        self.assertEqual(
            versions["versions"]["2.16.0"]["linux"]["pip"]["rocm5.x"]["command"],
            "pip-rocm10.0",
        )

    def test_alpha_removed_when_matrix_drops_preview(self):
        linter = load_linter()
        versions = self.generate(
            linter,
            published_versions(),
            channel_matrix("10.1", preview="10.3"),
            channel_matrix("10.0"),
        )
        versions = self.generate(
            linter,
            copy.deepcopy(versions),
            channel_matrix("10.1"),
            channel_matrix("10.0"),
        )
        self.assertNotIn("rocm.alpha", linter.acc_arch_ver_map["nightly"])
        for os_vers in versions["versions"]["preview"].values():
            for pkg_vers in os_vers.values():
                self.assertNotIn("rocm.alpha", pkg_vers)

    def test_build_matrix_contract(self):
        # The matrix script and the linter must agree on how preview rows are marked.
        linter = load_linter()
        matrix = {}
        for chan in ("nightly", "release"):
            matrix[chan] = {
                os_key: generate_binary_build_matrix.generate_build_matrix(
                    "all",
                    matrix_os,
                    chan,
                    "enable",
                    "enable",
                    "enable",
                    "disable",
                    "false",
                    "false",
                    "disable",
                    "true",
                )["include"]
                for os_key, matrix_os in (
                    ("linux", "linux"),
                    ("windows", "windows"),
                    ("macos", "macos-arm64"),
                )
            }
        versions = self.generate(
            linter, published_versions(), matrix["nightly"], matrix["release"]
        )
        nightly_rocm = max(
            generate_binary_build_matrix.ROCM_ARCHES_DICT["nightly"],
            key=generate_binary_build_matrix.parse_version,
        )
        self.assertEqual(
            linter.acc_arch_ver_map["nightly"]["rocm5.x"], ("rocm", nightly_rocm)
        )
        self.assertEqual(
            linter.acc_arch_ver_map["nightly"]["rocm.alpha"],
            ("rocm", generate_binary_build_matrix.ROCM_PREVIEW_VERSION, "alpha"),
        )
        pip = versions["versions"]["preview"]["linux"]["pip"]
        self.assertEqual(pip["rocm.alpha"]["command"], PREVIEW_CMD)
        self.assertIn(f"nightly/rocm{nightly_rocm}", pip["rocm5.x"]["command"])


if __name__ == "__main__":
    unittest.main()
