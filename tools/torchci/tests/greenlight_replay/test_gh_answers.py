"""Tests for recording GitHub's answers once and answering the replay jobs from them.

The first cases pin ``gh_answers``' three modes against a stand-in for
``subprocess.run``. ``TestReplayedInputs`` then runs the real ``inputs.build_inputs``
twice against a fake ``gh``, recording and then replaying, and holds the files the two
runs wrote to each other. ``TestSharedRecord`` does the same for two stacked pull
requests under four policies that share one record, as both arms of a CI run do.
"""

import contextlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_inputs import (
    comment,
    completed,
    CUTOFF,
    FakeGh,
    GHSTACK_BASE_REF,
    HEAD_SHA,
    make_policy,
    PR_NUMBER,
    pr_payload,
    REPO,
)
from test_stack import (
    BEFORE,
    compare,
    ghstack_policy,
    head_oid,
    listed_page,
    MIDDLE,
    NEAREST,
    sibling,
    StackGh,
    TOP,
)
from test_stack_native import entry, native_policy, native_stack, NativeGh
from torchci.greenlight_replay import gh_answers, inputs as inputs_mod, stack


ARGV = ["gh", "api", "-X", "GET", f"repos/{REPO}/compare/main...{HEAD_SHA}"]
OTHER_ARGV = ["gh", "pr", "view", str(PR_NUMBER), "--repo", REPO]
TIMEOUT_S = 180
# Not UTF-8, with an escape sequence, a NUL and a CRLF: what a diff can carry.
RAW = b"\x1b[31m-\xff\xfe\x00\r\n+end"
GH_BANNER = b"gh version 2.97.0 (2026-06-01)\n"

NATIVE_PR = PR_NUMBER + 10
NATIVE_HEAD = "e" * 40
NATIVE_ABOVE = tuple(range(NATIVE_PR + 1, NATIVE_PR + 4))
PULLS = {PR_NUMBER: (GHSTACK_BASE_REF, HEAD_SHA), NATIVE_PR: ("main", NATIVE_HEAD)}
POLICIES = {
    "none": make_policy(),
    "ghstack": ghstack_policy(),
    "both": native_policy(),
    "declined": make_policy(max_diff_lines=1),
}


def ghstack_gh():
    """A ghstack pull request listed below three siblings, each with its own diff."""
    above = (TOP, MIDDLE, NEAREST)
    siblings = {n: sibling(n, commits=[(head_oid(n), BEFORE)]) for n in above}
    diffs = {compare("b" * 40, head_oid(n)): b"+sibling %d\n" % n for n in above}
    return StackGh({None: listed_page()}, siblings, diffs)


def native_gh():
    """A pull request below three entries of its GitHub stack, each with its own diff."""
    bases = (NATIVE_HEAD, *map(head_oid, NATIVE_ABOVE))
    diffs = {
        compare(base, head_oid(n)): b"+entry %d\n" % n
        for base, n in zip(bases, NATIVE_ABOVE)
    }
    entries = {n: entry(n) for n in NATIVE_ABOVE}
    gh = NativeGh(native_stack([NATIVE_PR, *NATIVE_ABOVE]), entries, diffs=diffs)
    gh.payload = dict(gh.payload, number=NATIVE_PR)
    return gh


def files_under(root):
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


class GhAnswersTestCase(unittest.TestCase):
    """Each case starts recording nothing and replaying nothing, and leaves it so."""

    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.answers = self.root / "answers"
        for patcher in (
            mock.patch.object(gh_answers, "_recording", None),
            mock.patch.dict(os.environ),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        os.environ.pop(gh_answers.ANSWERS_ENV, None)

    def gh(self, *answers):
        """Stand in for gh, answering each call with the next of ``answers``."""
        patcher = mock.patch.object(gh_answers.subprocess, "run", side_effect=answers)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def record(self, argv, answer):
        """Record ``answer`` to ``argv`` as a collect run does, then stop recording."""
        with mock.patch.object(gh_answers, "_recording", None), mock.patch.object(
            gh_answers.subprocess, "run", return_value=answer
        ):
            gh_answers.record_into(self.answers)
            gh_answers.run(argv, TIMEOUT_S)

    @contextlib.contextmanager
    def replaying(self):
        """Answer as a replay job does, failing the case if anything is run."""
        environ = {gh_answers.ANSWERS_ENV: str(self.answers)}
        with mock.patch.dict(os.environ, environ), mock.patch.object(
            gh_answers.subprocess, "run", side_effect=AssertionError("gh was run")
        ) as gh:
            yield
        gh.assert_not_called()


class TestRecording(GhAnswersTestCase):
    """While collect records, GitHub hears each call once and only a success is kept."""

    def test_a_recorded_call_is_answered_from_the_record_not_run_again(self):
        gh = self.gh(completed(b"diff", stderr=b"warning"))
        gh_answers.record_into(self.answers)
        first = gh_answers.run(ARGV, TIMEOUT_S)
        second = gh_answers.run(ARGV, TIMEOUT_S)
        gh.assert_called_once_with(
            ARGV, capture_output=True, check=False, timeout=TIMEOUT_S
        )
        self.assertEqual(first.stdout, b"diff")
        self.assertEqual(
            (second.args, second.returncode, second.stdout, second.stderr),
            (ARGV, 0, b"diff", b"warning"),
        )

    def test_a_failure_is_not_recorded_so_the_next_attempt_asks_again(self):
        gh = self.gh(completed(b"", 1, b"HTTP 502"), completed(b"diff"))
        gh_answers.record_into(self.answers)
        self.assertEqual(gh_answers.run(ARGV, TIMEOUT_S).returncode, 1)
        self.assertEqual(list(self.answers.iterdir()), [])
        self.assertEqual(gh_answers.run(ARGV, TIMEOUT_S).stdout, b"diff")
        self.assertEqual(gh.call_count, 2)


class TestReplaying(GhAnswersTestCase):
    """With the env set, a call is answered from the record or fails; nothing runs."""

    def test_recorded_answers_come_back_byte_for_byte_each_to_its_own_call(self):
        self.record(ARGV, completed(RAW, stderr=RAW[::-1]))
        self.record(OTHER_ARGV, completed(b'{"number": 1}'))
        with self.replaying():
            answer = gh_answers.run(ARGV, TIMEOUT_S)
            other = gh_answers.run(OTHER_ARGV, TIMEOUT_S)
        self.assertEqual(
            (answer.args, answer.returncode, answer.stdout, answer.stderr),
            (ARGV, 0, RAW, RAW[::-1]),
        )
        self.assertEqual(other.stdout, b'{"number": 1}')

    def test_an_unrecorded_call_fails_naming_the_record(self):
        self.record(ARGV, completed(b"diff"))
        with self.replaying():
            answer = gh_answers.run(OTHER_ARGV, TIMEOUT_S)
        self.assertEqual((answer.args, answer.returncode), (OTHER_ARGV, 1))
        self.assertEqual(answer.stdout, b"")
        message = answer.stderr.decode("utf-8")
        self.assertIn(str(self.answers), message)
        self.assertIn(gh_answers.ANSWERS_ENV, message)

    def test_a_file_holding_another_call_does_not_answer_this_one(self):
        self.record(ARGV, completed(b"diff"))
        [path] = self.answers.iterdir()
        document = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**document, "argv": OTHER_ARGV}), encoding="utf-8")
        with self.replaying():
            self.assertEqual(gh_answers.run(ARGV, TIMEOUT_S).returncode, 1)


class TestNeitherMode(GhAnswersTestCase):
    """Outside CI the harness asks GitHub directly, as it always has."""

    def test_gh_runs_and_nothing_is_kept(self):
        gh = self.gh(completed(b"diff"))
        self.assertEqual(gh_answers.run(ARGV, TIMEOUT_S).stdout, b"diff")
        gh.assert_called_once_with(
            ARGV, capture_output=True, check=False, timeout=TIMEOUT_S
        )
        self.assertFalse(self.answers.exists())

    def test_inputs_reach_gh_through_gh_answers_with_their_own_timeout(self):
        with mock.patch.object(gh_answers, "run", return_value=completed()) as run:
            inputs_mod._run(ARGV)
        run.assert_called_once_with(ARGV, inputs_mod._GH_TIMEOUT_SECONDS)


class TestReplayedInputs(GhAnswersTestCase):
    """A replay job rebuilds from the record exactly the inputs collect fetched."""

    def setUp(self):
        super().setUp()
        inputs_mod._gh_version.cache_clear()
        self.addCleanup(inputs_mod._gh_version.cache_clear)

    def build(self, run_dir):
        return inputs_mod.build_inputs(
            REPO, PR_NUMBER, GHSTACK_BASE_REF, HEAD_SHA, CUTOFF, run_dir, make_policy()
        )

    def test_the_replayed_files_are_the_collected_ones_byte_for_byte(self):
        gh = FakeGh(diff=b"+" + RAW + b"\n", payload=pr_payload([comment("alice")]))

        def process(argv, **kwargs):
            return completed(GH_BANNER) if argv == ["gh", "--version"] else gh(argv)

        with mock.patch.object(gh_answers, "_recording", None), mock.patch.object(
            gh_answers.subprocess, "run", side_effect=process
        ):
            gh_answers.record_into(self.answers)
            collected = self.build(self.root / "collected")
        # A replay job is a fresh process, so it asks for gh's version again and gets
        # the recorded one: that is what keeps its compare argv, flag included, the
        # one collect recorded.
        inputs_mod._gh_version.cache_clear()
        with self.replaying():
            replayed = self.build(self.root / "replayed")

        self.assertIn(inputs_mod.ESCAPE_SEQUENCE_FLAG, gh.call_matching(["gh", "api"]))
        self.assertEqual(
            replayed.diff_path.read_bytes(), collected.diff_path.read_bytes()
        )
        self.assertEqual(
            replayed.metadata_path.read_bytes(), collected.metadata_path.read_bytes()
        )
        self.assertIn(b"alice", replayed.metadata_path.read_bytes())


class TestSharedRecord(GhAnswersTestCase):
    """Each policy's replay finds every call it makes in the record all policies share.

    A replay job is answered only for an argv collect recorded, so this holds when an
    argv depends on nothing but the row, the policy and the answers before it.
    """

    def setUp(self):
        super().setUp()
        self.addCleanup(inputs_mod._gh_version.cache_clear)
        self.fakes = {PR_NUMBER: ghstack_gh(), NATIVE_PR: native_gh()}
        self.building = PR_NUMBER

    def github(self, argv, **kwargs):
        """Stand in for gh: its banner, else the fake of the pull request being built."""
        if argv == ["gh", "--version"]:
            return completed(GH_BANNER)
        return self.fakes[self.building](argv)

    def build_every_policy(self, root):
        """Build both pull requests under each policy, each policy a fresh process.

        Returns per policy every call with its exit status, and every file written.
        """
        ask = gh_answers.run
        calls, built = [], {}

        def spy(argv, timeout_s):
            completed_process = ask(argv, timeout_s)
            calls.append((argv, completed_process.returncode))
            return completed_process

        with mock.patch.object(gh_answers, "run", spy):
            for name, policy in POLICIES.items():
                inputs_mod._gh_version.cache_clear()
                calls.clear()
                for number, (base_ref, head_sha) in PULLS.items():
                    self.building = number
                    run_dir = root / name / str(number)
                    inputs_mod.build_inputs(
                        REPO, number, base_ref, head_sha, CUTOFF, run_dir, policy
                    )
                built[name] = (list(calls), files_under(root / name))
        return built

    def test_every_policy_replays_call_for_call_and_byte_for_byte(self):
        with mock.patch.object(gh_answers, "_recording", None), mock.patch.object(
            gh_answers.subprocess, "run", side_effect=self.github
        ):
            gh_answers.record_into(self.answers)
            collected = self.build_every_policy(self.root / "collected")
        with self.replaying():
            replayed = self.build_every_policy(self.root / "replayed")

        for name, (calls, files) in replayed.items():
            with self.subTest(policy=name):
                self.assertEqual({returncode for _, returncode in calls}, {0})
                self.assertEqual(calls, collected[name][0])
                self.assertEqual(files, collected[name][1])
        stacks = {
            name: sorted(path for path in files if path.endswith(stack.STACK_FILENAME))
            for name, (_, files) in collected.items()
        }
        ghstack_json = f"{PR_NUMBER}/{stack.STACK_FILENAME}"
        native_json = f"{NATIVE_PR}/{stack.STACK_FILENAME}"
        self.assertEqual(
            stacks,
            {
                "none": [],
                "ghstack": [ghstack_json],
                "both": [ghstack_json, native_json],
                "declined": [],
            },
        )


if __name__ == "__main__":
    unittest.main()
