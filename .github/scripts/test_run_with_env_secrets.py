import os
import tempfile
import unittest
from unittest import mock

import run_with_env_secrets as m


class TestLoadMatrixEnv(unittest.TestCase):
    """The env file export-matrix-variables writes has to reach the script.

    Only `docker run --env-file` ever applied it, so a job already inside a
    container -- which has no docker daemon -- saw no MATRIX_* at all and
    binary-matrix silently did nothing.
    """

    def _env_file(self, body: str) -> str:
        tmp = tempfile.mkdtemp()
        with open(os.path.join(tmp, "github_env_42"), "w") as f:
            f.write(body)
        return tmp

    def _load(self, body: str, extra: dict = None) -> None:
        tmp = self._env_file(body)
        env = {"RUNNER_TEMP": tmp, "GITHUB_RUN_ID": "42"}
        env.update(extra or {})
        self._tmp = tmp
        with mock.patch.dict(os.environ, env, clear=True):
            m.load_matrix_env()
            self._result = dict(os.environ)

    def test_values_with_spaces_survive(self):
        """MATRIX_INSTALLATION is a whole pip command, not a single token."""
        self._load(
            "MATRIX_INSTALLATION=pip3 install --pre torch --index-url https://x\n"
        )
        self.assertEqual(
            self._result["MATRIX_INSTALLATION"],
            "pip3 install --pre torch --index-url https://x",
        )

    def test_empty_value_round_trips(self):
        self._load("MATRIX_GPU_ARCH_VERSION=\n")
        self.assertEqual(self._result["MATRIX_GPU_ARCH_VERSION"], "")

    def test_existing_values_are_not_clobbered(self):
        """setup-linux appends the runner's RUNNER_* captured outside the
        container; overwriting would swap a correct path for a host one."""
        self._load("RUNNER_TEMP=/host/path\nMATRIX_CHANNEL=nightly\n")
        self.assertEqual(self._result["RUNNER_TEMP"], self._tmp)
        self.assertEqual(self._result["MATRIX_CHANNEL"], "nightly")

    def test_missing_file_is_not_an_error(self):
        """binary-matrix is optional, so most jobs have no file at all."""
        with mock.patch.dict(
            os.environ,
            {"RUNNER_TEMP": "/nonexistent", "GITHUB_RUN_ID": "42"},
            clear=True,
        ):
            m.load_matrix_env()

    def test_blank_and_malformed_lines_are_skipped(self):
        self._load("\nnot-an-assignment\nMATRIX_OK=1\n")
        self.assertEqual(self._result["MATRIX_OK"], "1")


class TestNoDockerBranchAppliesIt(unittest.TestCase):
    """The function existing is not enough -- main() has to call it.

    This is the regression that matters: the docker branch gets the env file
    via --env-file, and the branch without docker has to do the equivalent.
    """

    def test_script_runs_with_matrix_env_applied(self):
        tmp = tempfile.mkdtemp()
        with open(os.path.join(tmp, "github_env_42"), "w") as f:
            f.write("MATRIX_PACKAGE_TYPE=manywheel\n")

        seen = {}

        def fake_run(cmd):
            seen["MATRIX_PACKAGE_TYPE"] = os.environ.get("MATRIX_PACKAGE_TYPE")
            return ""

        env = {
            "RUNNER_TEMP": tmp,
            "GITHUB_RUN_ID": "42",
            "ALL_SECRETS": "{}",
        }
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(
            m.shutil, "which", return_value=None
        ), mock.patch.object(m, "run_cmd_or_die", fake_run), mock.patch.object(
            m.sys, "argv", ["run_with_env_secrets.py", ""]
        ):
            m.main()

        self.assertEqual(
            seen["MATRIX_PACKAGE_TYPE"],
            "manywheel",
            "main() must apply the env file before running the script",
        )


if __name__ == "__main__":
    unittest.main()
