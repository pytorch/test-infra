import argparse
import json
import os
import sys
from unittest import main, TestCase

from tools.scripts.generate_binary_build_matrix import (
    generate_build_matrix,
    parse_version,
    ROCM_ARCHES_DICT,
)


ASSETS_DIR = "tools/tests/assets"


class GenerateBuildMatrixTest(TestCase):
    update_reference_files = False

    def matrix_compare_helper(
        self,
        package_type: str,
        operating_system: str,
        cuda: bool,
        rocm: bool,
        cpu: bool,
        xpu: bool,
        reference_output_file: str,
        build_python_only: bool = False,
    ) -> None:
        out = generate_build_matrix(
            package_type,
            operating_system,
            "nightly",
            "enable" if cuda else "disable",
            "enable" if rocm else "disable",
            "enable" if cpu else "disable",
            "enable" if xpu else "disable",
            "false",
            "false",
            "enable" if build_python_only else "disable",
        )

        expected_json_filename = os.path.join(ASSETS_DIR, reference_output_file)

        if self.update_reference_files:
            with open(expected_json_filename, "w") as f:
                json.dump(out, f, indent=2)

        with open(expected_json_filename) as f:
            expected = json.load(f)

        self.maxDiff = None
        self.assertEqual(out, expected)

    def test_linux_wheel_cuda(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="linux",
            cuda=True,
            rocm=True,
            cpu=True,
            xpu=False,
            reference_output_file="build_matrix_linux_wheel_cuda.json",
        )

    def test_macos_wheel(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="macos",
            cuda=False,
            rocm=False,
            cpu=True,
            xpu=False,
            reference_output_file="build_matrix_macos_wheel.json",
        )

    def test_windows_wheel_cuda(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="windows",
            cuda=True,
            rocm=True,
            cpu=True,
            xpu=True,
            reference_output_file="build_matrix_windows_wheel_cuda.json",
        )

    def test_windows_wheel_xpu(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="windows",
            cuda=False,
            rocm=False,
            cpu=True,
            xpu=True,
            reference_output_file="build_matrix_windows_wheel_xpu.json",
        )

    def test_linux_wheel_cuda_norocm(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="linux",
            cuda=True,
            rocm=False,
            cpu=True,
            xpu=False,
            reference_output_file="build_matrix_linux_wheel_cuda_norocm.json",
        )

    def test_linux_wheel_cuda_rocm_nocpu(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="linux",
            cuda=True,
            rocm=True,
            cpu=False,
            xpu=False,
            reference_output_file="build_matrix_linux_wheel_nocpu.json",
        )

    def test_linux_wheel_cuda_xpu_nocpu(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="linux",
            cuda=True,
            rocm=False,
            cpu=False,
            xpu=True,
            reference_output_file="build_matrix_linux_wheel_xpu.json",
        )

    def _test_channel_python_versions(
        self,
        operating_system: str,
        channel: str = "test",
        python_abi3: bool = False,
        getting_started: bool = False,
    ) -> set:
        out = generate_build_matrix(
            "wheel",
            operating_system,
            channel,
            "enable",
            "enable" if operating_system in ("linux",) else "disable",
            "enable",
            "enable" if operating_system in ("linux", "windows") else "disable",
            "false",
            "false",
            "disable",
            "true" if getting_started else "false",
            None,
            "enable" if python_abi3 else "disable",
        )
        return {entry["python_version"] for entry in out["include"]}

    def test_python_3_15_enabled_by_default(self):
        # 3.15 / 3.15t are in the default matrix for the nightly and test
        # channels, on every operating system.
        for channel in ("nightly", "test"):
            for operating_system in (
                "linux",
                "linux-aarch64",
                "windows",
                "macos-arm64",
            ):
                versions = self._test_channel_python_versions(
                    operating_system, channel=channel
                )
                self.assertIn("3.15", versions)
                self.assertIn("3.15t", versions)

    def test_python_3_15_enabled_on_release_channel(self):
        # 2.14 ships 3.15 / 3.15t wheels, so they belong in the release matrix.
        for operating_system in ("linux", "linux-aarch64", "windows", "macos-arm64"):
            versions = self._test_channel_python_versions(
                operating_system, channel="release"
            )
            self.assertIn("3.15", versions)
            self.assertIn("3.15t", versions)

    def test_python_3_15_excluded_from_getting_started(self):
        # 3.15 is still a CPython pre-release, so it must stay off the
        # getting-started page on every channel.
        for channel in ("nightly", "test", "release"):
            for operating_system in (
                "linux",
                "linux-aarch64",
                "windows",
                "macos-arm64",
            ):
                versions = self._test_channel_python_versions(
                    operating_system, channel=channel, getting_started=True
                )
                self.assertNotIn("3.15", versions)
                self.assertNotIn("3.15t", versions)

    def test_python_3_15_excluded_on_windows_arm64(self):
        # windows-arm64 pins its own short version list.
        versions = self._test_channel_python_versions("windows-arm64")
        self.assertNotIn("3.15", versions)
        self.assertNotIn("3.15t", versions)

    def test_python_abi3_keeps_oldest_and_free_threaded(self):
        # A single abi3 wheel covers every later CPython, but free-threaded
        # interpreters reject abi3 wheels and still need one wheel each.
        for operating_system in ("linux", "linux-aarch64", "windows"):
            self.assertEqual(
                self._test_channel_python_versions(
                    operating_system, channel="nightly", python_abi3=True
                ),
                {"3.10", "3.14t", "3.15t"},
            )
            self.assertEqual(
                self._test_channel_python_versions(
                    operating_system, channel="release", python_abi3=True
                ),
                {"3.10", "3.14t", "3.15t"},
            )

        # macOS pins .0 point versions, see MACOS_PYTHON_POINT_VERSIONS.
        self.assertEqual(
            self._test_channel_python_versions(
                "macos-arm64", channel="nightly", python_abi3=True
            ),
            {"3.10.19", "3.14t", "3.15t"},
        )

    def test_python_abi3_disabled_by_default(self):
        self.assertEqual(
            self._test_channel_python_versions("linux", channel="nightly"),
            {"3.10", "3.11", "3.12", "3.13", "3.14", "3.14t", "3.15", "3.15t"},
        )

    def test_torch_only_install_command_for_torch_only_arches(self):
        out = generate_build_matrix(
            "wheel",
            "linux",
            "test",
            "enable",
            "enable",
            "enable",
            "enable",
            "false",
            "false",
            "disable",
            "false",
            None,
        )
        for entry in out["include"]:
            if entry["python_version"] in ("3.15", "3.15t"):
                # torchvision is not published for these versions yet.
                self.assertNotIn("torchvision", entry["installation"])
                self.assertIn("torch", entry["installation"])

    def _rocm_versions(self, channel: str, getting_started: str) -> set:
        out = generate_build_matrix(
            "wheel",
            "linux",
            channel,
            "enable",
            "enable",
            "enable",
            "enable",
            "false",
            "false",
            "disable",
            getting_started,
            None,
        )
        return {
            entry["gpu_arch_version"]
            for entry in out["include"]
            if entry["gpu_arch_type"] == "rocm"
        }

    def _cuda_versions(
        self,
        package_type: str,
        operating_system: str,
        channel: str,
        getting_started: str,
    ) -> set:
        out = generate_build_matrix(
            package_type,
            operating_system,
            channel,
            "enable",
            "enable",
            "enable",
            "enable",
            "false",
            "false",
            "disable",
            getting_started,
            None,
        )
        return {entry["desired_cuda"] for entry in out["include"]}

    def test_getting_started_excludes_cuda_13_4(self):
        # Covers linux-aarch64 too: CUDA_AARCH64_ARCHES used to be a separate
        # hand-maintained list that bypassed CUDA_ARCHES_NO_GETTING_STARTED.
        for package_type in ("wheel", "libtorch"):
            for operating_system in ("linux", "linux-aarch64"):
                for channel in ("nightly", "test", "release"):
                    self.assertNotIn(
                        "cu134",
                        self._cuda_versions(
                            package_type, operating_system, channel, "true"
                        ),
                        f"{package_type}/{operating_system}/{channel}",
                    )

    def test_cuda_13_4_still_built_on_nightly_and_test(self):
        for operating_system in ("linux", "linux-aarch64"):
            for channel in ("nightly", "test"):
                self.assertIn(
                    "cu134",
                    self._cuda_versions("wheel", operating_system, channel, "false"),
                    f"{operating_system}/{channel}",
                )

    def test_release_channel_has_no_cuda_13_4(self):
        # 13.4 is not published to download.pytorch.org prod.
        for operating_system in ("linux", "linux-aarch64"):
            self.assertNotIn(
                "cu134",
                self._cuda_versions("wheel", operating_system, "release", "false"),
                operating_system,
            )

    def test_parse_version_orders_double_digit_minors(self):
        self.assertGreater(parse_version("7.14"), parse_version("7.2"))
        self.assertEqual(
            max(["7.2", "7.14"], key=parse_version),
            "7.14",
        )

    def test_getting_started_ships_newest_rocm_per_channel(self):
        for channel in ("nightly", "test", "release"):
            versions = self._rocm_versions(channel, "true")
            self.assertEqual(
                versions,
                {max(ROCM_ARCHES_DICT[channel], key=parse_version)},
                channel,
            )

    def test_builds_keep_every_rocm(self):
        for channel in ("nightly", "test", "release"):
            versions = self._rocm_versions(channel, "false")
            self.assertEqual(versions, set(ROCM_ARCHES_DICT[channel]), channel)
            self.assertGreater(len(versions), 1, channel)


def parse_args():
    parser = argparse.ArgumentParser(description="Test generate build matrix")
    parser.add_argument(
        "--update-reference-files",
        action="store_true",
        help="Update reference files with the generated output",
    )
    return parser.parse_known_args()


if __name__ == "__main__":
    args, unittest_args = parse_args()
    GenerateBuildMatrixTest.update_reference_files = args.update_reference_files
    main(argv=[sys.argv[0]] + unittest_args)
