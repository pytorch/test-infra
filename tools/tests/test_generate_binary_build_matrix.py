import argparse
import json
import os
import sys
from unittest import main, TestCase

from tools.scripts.generate_binary_build_matrix import generate_build_matrix


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
        include_preview: str = "disable",
        channel: str = "test",
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
            "false",
            None,
            include_preview,
        )
        return {entry["python_version"] for entry in out["include"]}

    def test_preview_python_versions_opt_in_on_linux(self):
        # 3.15 / 3.15t are validated on Linux x86 and aarch64 for the nightly and
        # test channels when explicitly opted in.
        for channel in ("nightly", "test"):
            for operating_system in ("linux", "linux-aarch64"):
                versions = self._test_channel_python_versions(
                    operating_system, include_preview="enable", channel=channel
                )
                self.assertIn("3.15", versions)
                self.assertIn("3.15t", versions)

    def test_preview_python_versions_off_by_default(self):
        # Without opt-in the shared default is unchanged (e.g. torchvision builds).
        for operating_system in ("linux", "linux-aarch64"):
            versions = self._test_channel_python_versions(operating_system)
            self.assertNotIn("3.15", versions)
            self.assertNotIn("3.15t", versions)

    def test_preview_python_versions_excluded_on_non_linux(self):
        # Windows and macOS must not pick up the preview versions even when opted in.
        for operating_system in ("windows", "macos"):
            versions = self._test_channel_python_versions(
                operating_system, include_preview="enable"
            )
            self.assertNotIn("3.15", versions)
            self.assertNotIn("3.15t", versions)

    def test_preview_python_versions_excluded_on_release_channel(self):
        # Preview versions are defined for the nightly and test channels only,
        # never for the release channel.
        versions = self._test_channel_python_versions(
            "linux", include_preview="enable", channel="release"
        )
        self.assertNotIn("3.15", versions)
        self.assertNotIn("3.15t", versions)

    def test_torch_only_install_command_for_preview_arches(self):
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
            "enable",
        )
        for entry in out["include"]:
            if entry["python_version"] in ("3.15", "3.15t"):
                # torchvision is not published for these versions yet.
                self.assertNotIn("torchvision", entry["installation"])
                self.assertIn("torch", entry["installation"])


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
