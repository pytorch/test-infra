import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]

# Execute the action's full command without touching host packages, devices, or Docker.
STUBS = r"""
record() { printf '%s\n' "$*" >> "$CALLS"; }
function .() { ID="$OS_ID"; VERSION_ID="$OS_VERSION"; }
command() {
    if [ "$*" = '-v nvidia-smi' ]; then
        [ "$MISSING_DRIVER" = 0 ] || [ -f "$INSTALLED" ] || return 1
        printf '%s\n' "$FAKE_EXECUTABLE"
    else
        builtin command "$@"
    fi
}
nvidia-smi() {
    record "nvidia-smi $*"
    case "$*" in
        *query-gpu=driver_version*)
            if [ -f "$INSTALLED" ]; then
                cat "$INSTALLED"
            else
                printf '%s\n' "$HOST_DRIVER"
                return "$VERSION_STATUS"
            fi ;;
        *query-gpu=gpu_name*)
            printf 'NVIDIA A10G\n'
            if [ ! -f "$INSTALLED" ] || [ "$REPAIR_HEALTH" = 0 ]; then
                return "$HEALTH_STATUS"
            fi ;;
        *) return 0 ;;
    esac
}
sudo() {
    record "sudo $*"
    case "$*" in
        'curl '*) return "$DOWNLOAD_STATUS" ;;
        '/bin/bash /tmp/nvidia_driver '*) printf '%s\n' "$DRIVER_VERSION" > "$INSTALLED" ;;
    esac
    return 0
}
lspci() { :; }
lsmod() { :; }
modinfo() { :; }
uname() { printf 'test-kernel\n'; }
dpkg-query() { printf 'installed\n'; }
docker() { record "docker $*"; return "$DOCKER_STATUS"; }
sleep() { :; }
"""


class TestSetupNvidia(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with (ROOT / ".github/actions/setup-nvidia/action.yml").open() as source:
            cls.action = yaml.load(source, Loader=yaml.BaseLoader)
        cls.install = next(
            step
            for step in cls.action["runs"]["steps"]
            if step.get("uses", "").startswith("nick-fields/retry@")
        )

    def run_setup(self, requested=None, **overrides):
        if requested is None:
            requested = self.action["inputs"]["driver-version"]["default"]
        with tempfile.TemporaryDirectory() as directory:
            calls = Path(directory) / "calls"
            env = {
                **os.environ,
                "CALLS": str(calls),
                "INSTALLED": str(Path(directory) / "installed"),
                "FAKE_EXECUTABLE": shutil.which("true"),
                "HOST_DRIVER": "615.71.09",
                "MISSING_DRIVER": "0",
                "VERSION_STATUS": "0",
                "HEALTH_STATUS": "0",
                "REPAIR_HEALTH": "1",
                "DOWNLOAD_STATUS": "0",
                "DOCKER_STATUS": "0",
                "OS_ID": "amzn",
                "OS_VERSION": "2023",
                **overrides,
            }
            for name, expression in self.install["env"].items():
                if expression == "${{ inputs.driver-version }}":
                    env[name] = requested
                else:
                    self.fail(f"Unexpected installer input: {name}={expression}")
            result = subprocess.run(
                ["bash", "-c", STUBS + self.install["with"]["command"]],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result, calls.read_text().splitlines() if calls.exists() else []

    def assert_retained(self, **options):
        result, calls = self.run_setup(**options)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(
            any(
                marker in call
                for call in calls
                for marker in (
                    "sudo yum remove",
                    "sudo killall",
                    "sudo curl",
                    "sudo /bin/bash",
                    "sudo tee",
                    "sudo rm",
                )
            ),
            calls,
        )
        self.assertIn(
            "nvidia-smi --query-gpu=gpu_name --format=csv,noheader --id=0", calls
        )
        self.assertIn("sudo nvidia-persistenced", calls)
        self.assertEqual(
            calls[-1],
            "docker run --rm -t --gpus=all public.ecr.aws/docker/library/python:3.13 nvidia-smi",
        )
        return calls

    def assert_installed(self, expected="580.65.06", **options):
        result, calls = self.run_setup(**options)
        self.assertEqual(result.returncode, 0, result.stderr)
        download = (
            "sudo curl -fsL -o /tmp/nvidia_driver "
            "https://s3.amazonaws.com/ossci-linux/nvidia_driver/"
            f"NVIDIA-Linux-x86_64-{expected}.run"
        )
        self.assertIn(download, calls)
        self.assertIn("sudo /bin/bash /tmp/nvidia_driver -s --no-drm", calls)
        return calls

    def test_default_preserves_sufficient_healthy_drivers(self):
        for driver in (
            "580.65.06",
            "580.82.07",
            "580.100.01",
            "580.178.04",
            "615.71.09",
        ):
            with self.subTest(driver=driver):
                self.assert_retained(HOST_DRIVER=driver)

    def test_explicit_version_keeps_exact_selection(self):
        for version in ("580.65.06", "615.71.09"):
            with self.subTest(version=version):
                self.assert_retained(requested=version, HOST_DRIVER=version)
        self.assert_installed(requested="580.65.06", HOST_DRIVER="615.71.09")
        self.assert_installed(
            requested="615.71.09", HOST_DRIVER="580.65.06", expected="615.71.09"
        )

    def test_default_repairs_missing_old_or_invalid_driver(self):
        for options in (
            {"MISSING_DRIVER": "1"},
            {"HOST_DRIVER": "570.133.07"},
            {"HOST_DRIVER": "580.9.10"},
            {"HOST_DRIVER": "580.65.05"},
            {"HOST_DRIVER": ""},
            {"HOST_DRIVER": "N/A"},
            {"HOST_DRIVER": "615.71.09\n615.71.09"},
            {"VERSION_STATUS": "9"},
            {"HEALTH_STATUS": "9"},
        ):
            with self.subTest(options=options):
                self.assert_installed(**options)

    def test_allowed_nvidia_query_status_is_preserved(self):
        self.assert_retained(VERSION_STATUS="14", HEALTH_STATUS="14")

    def test_package_removal_follows_driver_decision(self):
        calls = self.assert_installed(HOST_DRIVER="570.133.07")
        self.assertLess(
            calls.index(
                "nvidia-smi --query-gpu=driver_version --format=csv,noheader --id=0"
            ),
            calls.index("sudo yum remove -y nvidia-driver-latest-dkms"),
        )
        self.assertLess(
            calls.index("sudo yum remove -y nvidia-driver-latest-dkms"),
            calls.index("sudo /bin/bash /tmp/nvidia_driver -s --no-drm"),
        )
        self.assert_retained()

    def test_ubuntu_preserves_driver_without_rpm_commands(self):
        calls = self.assert_retained(OS_ID="ubuntu", OS_VERSION="20.04")
        self.assertFalse(any("sudo yum" in call for call in calls), calls)
        calls = self.assert_installed(
            OS_ID="ubuntu", OS_VERSION="20.04", HOST_DRIVER="570.133.07"
        )
        self.assertFalse(any("sudo yum" in call for call in calls), calls)

    def test_failures_still_fail_setup(self):
        for options, expected in (
            ({"HOST_DRIVER": "570.133.07", "DOWNLOAD_STATUS": "22"}, 22),
            ({"HEALTH_STATUS": "9", "REPAIR_HEALTH": "0"}, 9),
            ({"DOCKER_STATUS": "42"}, 42),
            ({"OS_ID": "unsupported", "OS_VERSION": "1"}, 1),
        ):
            with self.subTest(options=options):
                result, _ = self.run_setup(**options)
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_gpu_detection_paths(self):
        detect = next(
            step
            for step in self.action["runs"]["steps"]
            if step.get("id") == "detect-gpu"
        )
        stubs = r"""
command() { return 0; }
nvidia-smi() { [ "$GPU_SOURCE" = smi ] && printf 'GPU 0: NVIDIA A10G\n'; }
ls() { [ "$GPU_SOURCE" = device ] && printf '/dev/nvidia0\n'; }
lspci() { [ "$GPU_SOURCE" = pci ] && printf 'NVIDIA Corporation\n'; }
"""
        for source in ("smi", "device", "pci", "none"):
            with self.subTest(source=source):
                with tempfile.TemporaryDirectory() as directory:
                    output = Path(directory) / "output"
                    command = detect["run"].replace(
                        "/tmp/nvidia_devices", str(Path(directory) / "devices")
                    )
                    subprocess.run(
                        ["bash", "-c", stubs + command],
                        env={
                            **os.environ,
                            "GPU_SOURCE": source,
                            "GITHUB_OUTPUT": str(output),
                        },
                        check=True,
                        capture_output=True,
                        text=True,
                    )
                    self.assertIn(
                        f"HAS_NVIDIA={'false' if source == 'none' else 'true'}\n",
                        output.read_text(),
                    )

    def test_container_guard_and_gpu_flag(self):
        self.assertEqual(
            self.install["if"],
            "${{ steps.detect-gpu.outputs.HAS_NVIDIA == 'true' && "
            "steps.check-container.outputs.IN_CONTAINER_RUNNER != 'true' }}",
        )
        marker_step = next(
            step
            for step in self.action["runs"]["steps"]
            if step.get("id") == "check-container"
        )
        export_step = next(
            step
            for step in self.action["runs"]["steps"]
            if step.get("name") == "Export GPU detection result"
        )
        for marker in ("", "/.inarc", "/.incontainer"):
            with self.subTest(
                marker=marker
            ), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "output"
                result = subprocess.run(
                    [
                        "bash",
                        "-c",
                        '[() { [[ "$1" = "-f" && "$2" = "$MARKER" ]]; }; '
                        + marker_step["run"],
                    ],
                    env={**os.environ, "MARKER": marker, "GITHUB_OUTPUT": str(output)},
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.assertEqual(
                    output.read_text(),
                    f"IN_CONTAINER_RUNNER={'true' if marker else 'false'}\n",
                    result.stderr,
                )
        for has_gpu in ("true", "false"):
            with self.subTest(
                has_gpu=has_gpu
            ), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "env"
                subprocess.run(
                    ["bash", "-c", export_step["run"]],
                    env={
                        **os.environ,
                        "HAS_NVIDIA": has_gpu,
                        "GITHUB_ENV": str(output),
                    },
                    check=True,
                )
                self.assertIn(f"HAS_NVIDIA_GPU={has_gpu}\n", output.read_text())
                self.assertEqual("GPU_FLAG=" in output.read_text(), has_gpu == "true")


if __name__ == "__main__":
    unittest.main()
