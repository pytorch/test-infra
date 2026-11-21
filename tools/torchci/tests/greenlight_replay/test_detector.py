"""Tests for running the policy's instruction-loading detector over a run directory.

The detector is this repository's real ``assert-loaded-instructions.py``; the manifest
and sentinel are written here the way the review job's hooks write them.
"""

import json
import tempfile
import unittest
from pathlib import Path

from replay_runner_fixtures import REPO_ROOT
from torchci.greenlight_replay import detector, workflow_steps


DETECTOR = REPO_ROOT / workflow_steps.DETECTOR_RELPATH


class DetectorTestCase(unittest.TestCase):
    def scratch(self):
        made = tempfile.TemporaryDirectory(prefix="greenlight-detector-test-")
        self.addCleanup(made.cleanup)
        return Path(made.name)

    def setUp(self):
        self.run_dir = self.scratch()
        self.workspace = self.scratch()
        self.untrusted = self.workspace / "pytorch"

    def detect(self):
        return detector.run_detector(DETECTOR, self.run_dir, self.untrusted)

    def sentinel(self):
        (self.run_dir / workflow_steps.SENTINEL_BASENAME).write_text("ok\n")

    def load(self, path):
        with open(self.run_dir / workflow_steps.MANIFEST_BASENAME, "a") as manifest:
            manifest.write(json.dumps({"file_path": str(path)}) + "\n")


class TestRunDetector(DetectorTestCase):
    """Its two failures are told apart: hooks that never ran, and a file that loaded."""

    def test_hooks_that_ran_and_loaded_nothing_pass(self):
        self.sentinel()
        self.assertIsNone(self.detect())

    def test_a_missing_sentinel_fails_as_hooks_that_never_ran(self):
        failure = self.detect()
        self.assertFalse(failure.hooks_ran)
        self.assertIn("sentinel", failure.message)

    def test_a_dangling_sentinel_link_counts_as_missing(self):
        (self.run_dir / workflow_steps.SENTINEL_BASENAME).symlink_to(
            self.run_dir / "gone"
        )
        self.assertFalse(self.detect().hooks_ran)

    def test_an_instruction_file_from_the_untrusted_checkout_fails_with_hooks_run(self):
        self.sentinel()
        self.load(self.untrusted / "torch" / "CLAUDE.md")
        failure = self.detect()
        self.assertTrue(failure.hooks_ran)
        self.assertIn("CLAUDE.md", failure.message)

    def test_a_missing_sentinel_is_reported_even_with_a_violation_in_the_manifest(self):
        self.load(self.untrusted / "CLAUDE.md")
        self.assertFalse(self.detect().hooks_ran)

    def test_an_instruction_file_outside_it_passes(self):
        self.sentinel()
        self.load(self.workspace / "target" / "CLAUDE.md")
        self.assertIsNone(self.detect())


class TestClearDetectorFiles(DetectorTestCase):
    """Each attempt starts with no manifest or sentinel an earlier one left."""

    def test_both_files_and_a_link_go_but_not_the_links_target(self):
        kept = self.scratch() / "kept"
        kept.write_text("ok\n")
        (self.run_dir / workflow_steps.SENTINEL_BASENAME).symlink_to(kept)
        self.load(self.untrusted / "CLAUDE.md")
        detector.clear_detector_files(self.run_dir)
        self.assertEqual(list(self.run_dir.iterdir()), [])
        self.assertTrue(kept.is_file())

    def test_a_directory_is_refused_and_nothing_there_is_fine(self):
        detector.clear_detector_files(self.run_dir)
        (self.run_dir / workflow_steps.SENTINEL_BASENAME).mkdir()
        with self.assertRaises(ValueError):
            detector.clear_detector_files(self.run_dir)


if __name__ == "__main__":
    unittest.main()
