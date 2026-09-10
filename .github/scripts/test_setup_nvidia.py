import os
import subprocess
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


class TestSetupNvidia(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with (ROOT / ".github/actions/setup-nvidia/action.yml").open() as source:
            cls.action = yaml.load(source, Loader=yaml.BaseLoader)
        with (ROOT / ".github/workflows/linux_job_v2.yml").open() as source:
            cls.workflow = yaml.load(source, Loader=yaml.BaseLoader)

    def test_workflow_forwards_driver_inputs_with_existing_defaults(self):
        inputs = self.workflow["on"]["workflow_call"]["inputs"]
        step = next(
            step
            for step in self.workflow["jobs"]["job"]["steps"]
            if step.get("id") == "install-nvidia-driver"
        )
        for name in ("driver-version", "driver-download-url"):
            with self.subTest(name=name):
                self.assertEqual(
                    inputs[name]["default"], self.action["inputs"][name]["default"]
                )
                self.assertEqual(step["with"][name], "${{ inputs." + name + " }}")
        self.assertEqual(inputs["driver-version"]["default"], "580.65.06")
        self.assertEqual(inputs["driver-download-url"]["default"], "")

    def test_download_uses_default_or_explicit_source(self):
        step = next(
            step
            for step in self.action["runs"]["steps"]
            if step.get("uses", "").startswith("nick-fields/retry@")
        )
        self.assertEqual(
            step["env"]["DRIVER_DOWNLOAD_URL"], "${{ inputs.driver-download-url }}"
        )
        command = next(
            line.strip()
            for line in step["with"]["command"].splitlines()
            if "sudo curl -fsL -o /tmp/nvidia_driver" in line
        )
        driver_file = "NVIDIA-Linux-x86_64-615.71.09.run"
        mirror = "https://s3.amazonaws.com/ossci-linux/nvidia_driver/" + driver_file
        official = (
            "https://download.nvidia.com/XFree86/Linux-x86_64/615.71.09/" + driver_file
        )
        for url, expected in (("", mirror), (official, official)):
            with self.subTest(url=url):
                result = subprocess.run(
                    ["bash", "-c", 'sudo() { printf "%s\\n" "$@"; }; ' + command],
                    env={
                        **os.environ,
                        "DRIVER_FN": driver_file,
                        "DRIVER_DOWNLOAD_URL": url,
                    },
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(
                    result.stdout.splitlines(),
                    ["curl", "-fsL", "-o", "/tmp/nvidia_driver", expected],
                )


if __name__ == "__main__":
    unittest.main()
