"""Tests for the size gate: the counts the ``sizecheck`` step's commands report.

The file count is checked against ``grep -a -c '^diff --git '`` itself, run on the same
bytes, rather than against a restatement of what grep should do.
"""

import dataclasses
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from replay_runner_fixtures import replay_policy
from torchci.greenlight_replay import size_gate


HEADER = b"diff --git a/x.py b/x.py\n"

# Each a diff whose file count grep and the gate must agree on.
CORPUS = (
    ("empty", b""),
    ("one file", HEADER + b"+one\n"),
    ("two files", HEADER + b"+one\n" + HEADER + b"-two\n"),
    ("a header not at a line start", b"+ diff --git a b\n" + HEADER),
    ("a NUL before a header line", b"+bin\x00ary\n" + HEADER),
    ("a NUL inside a header line", b"diff --git a/\x00 b/\x00\n"),
    ("a final header line without a newline", HEADER + b"+one\ndiff --git a/y b/y"),
    ("a carriage return", b"diff --git a/x b/x\r\n+one\r\n"),
    ("bytes that are not UTF-8", b"+\xff\xfe\n" + HEADER),
    ("a header missing its space", b"diff --gita/x\n"),
)


def grep_count(diff: bytes) -> int:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "greenlight-pr.diff"
        path.write_bytes(diff)
        completed = subprocess.run(
            ["grep", "-a", "-c", "^diff --git ", str(path)],
            capture_output=True,
            text=True,
            check=False,
            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8"},
        )
    # The step treats grep's exit 1 (no match) as a count of zero.
    if completed.returncode not in (0, 1):
        raise RuntimeError(completed.stderr)
    return int(completed.stdout.strip())


@unittest.skipUnless(shutil.which("grep"), "grep is required to check parity")
class TestFileCount(unittest.TestCase):
    """The file count is grep's, NUL bytes and an unterminated last line included."""

    def test_the_gate_counts_what_grep_counts(self):
        for name, diff in CORPUS:
            with self.subTest(name):
                self.assertEqual(size_gate.count_files(diff), grep_count(diff))

    def test_the_corpus_exercises_the_cases_that_differ_from_a_naive_count(self):
        counts = {name: size_gate.count_files(diff) for name, diff in CORPUS}
        self.assertEqual(counts["a NUL inside a header line"], 1)
        self.assertEqual(counts["a final header line without a newline"], 2)
        self.assertEqual(counts["a header not at a line start"], 1)


class TestGate(unittest.TestCase):
    """Any one cap breached declines; a cap equal to the count does not."""

    def gate(self, diff, **caps):
        policy = dataclasses.replace(replay_policy(), **caps)
        return size_gate.apply_size_gate(diff, policy, "pytorch/pytorch#1")

    def test_the_three_counts_are_wc_l_wc_c_and_the_file_count(self):
        diff = HEADER + b"+one\nunterminated"
        gate = self.gate(diff)
        self.assertEqual((gate.lines, gate.bytes, gate.files), (2, len(diff), 1))

    def test_each_cap_declines_alone(self):
        diff = HEADER + HEADER + b"+one\n"
        for caps in (
            {"max_diff_lines": 2},
            {"max_diff_bytes": len(diff) - 1},
            {"max_diff_files": 1},
        ):
            with self.subTest(caps=caps):
                self.assertTrue(self.gate(diff, **caps).too_large)

    def test_caps_equal_to_the_counts_pass(self):
        diff = HEADER + HEADER + b"+one\n"
        gate = self.gate(
            diff, max_diff_lines=3, max_diff_bytes=len(diff), max_diff_files=2
        )
        self.assertFalse(gate.too_large)

    def test_no_file_cap_never_declines_on_files(self):
        diff = HEADER * 500
        gate = self.gate(
            diff, max_diff_lines=1000, max_diff_bytes=10**6, max_diff_files=None
        )
        self.assertEqual(gate.files, 500)
        self.assertFalse(gate.too_large)

    def test_the_log_line_states_the_counts_and_the_caps(self):
        with self.assertLogs(size_gate.logger, "INFO") as logs:
            self.gate(HEADER, max_diff_files=None)
            self.gate(HEADER * 3, max_diff_files=2)
        first, second = logs.output
        self.assertIn("1 lines / 25 bytes / 1 files", first)
        self.assertIn("no file cap); proceeding with review", first)
        self.assertIn("2 files); declining automatically", second)


if __name__ == "__main__":
    unittest.main()
