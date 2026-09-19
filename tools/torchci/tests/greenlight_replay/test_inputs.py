"""Tests for rebuilding one pull request's reviewer inputs.

``_run`` is the module's only process spawn and ``_gh_version`` its only environment
probe; every test patches one or both, so nothing here shells out or reaches GitHub.

The comment cases carry the corpus defect they exist to keep: ``vercel`` is an App
whose GraphQL login has no ``[bot]`` suffix, so CI's glob lets it through. The
expectation below is that it still does. This harness reproduces the reviewer's
inputs rather than correcting them, and a "fixed" filter would make every replay
differ from the run it claims to reproduce.
"""

import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from torchci.greenlight_replay import inputs as inputs_mod
from torchci.greenlight_replay.inputs import build_inputs
from torchci.greenlight_replay.policy import Policy


RUN_SEAM = "_run"
GH_VERSION_SEAM = "_gh_version"

REPO = "pytorch/pytorch"
PR_NUMBER = 193118
HEAD_SHA = "a" * 40
GHSTACK_BASE_REF = "gh/jeanschmidt/42/base"

CUTOFF = datetime(2026, 9, 1, 12, 0, 0)
BEFORE = "2026-08-30T10:00:00Z"
AFTER = "2026-09-02T10:00:00Z"

DIFF = b"diff --git a/a.py b/a.py\n+one\n-two\n"


def completed(stdout=b"", returncode=0, stderr=b""):
    return subprocess.CompletedProcess(
        args=["gh"], returncode=returncode, stdout=stdout, stderr=stderr
    )


def comment(login, created_at=BEFORE, body="hello"):
    return {"author": {"login": login}, "body": body, "createdAt": created_at}


def pr_payload(comments=()):
    return {
        "number": PR_NUMBER,
        "title": "Fix the thing",
        "body": "Fixes it.",
        "comments": list(comments),
    }


def make_policy(max_diff_lines=2000, max_diff_bytes=500000) -> Policy:
    return Policy(
        root=Path("/nonexistent"),
        prompt_template="",
        max_diff_lines=max_diff_lines,
        max_diff_bytes=max_diff_bytes,
        review_budget_minutes=(20, 25, 33),
        too_large_verdict={
            "status": "NO_LAND",
            "reason": "scope_too_large",
            "message": "-",
        },
        schema_path=Path("/nonexistent/schema.json"),
        sanitize_script=Path("/nonexistent/sanitize.sh"),
        hooks_dir=Path("/nonexistent/hooks"),
        model="global.anthropic.claude-opus-5",
        effort="high",
        tools="Read,Glob,Grep,Write",
    )


class FakeGh:
    """A ``_run`` stand-in that answers the two commands this module issues."""

    def __init__(self, diff=DIFF, payload=None, pr_returncode=0):
        self.diff = diff
        self.payload = pr_payload() if payload is None else payload
        self.pr_returncode = pr_returncode
        self.calls: list[list[str]] = []

    def __call__(self, argv):
        self.calls.append(list(argv))
        if argv[:2] == ["gh", "api"]:
            return completed(self.diff)
        if argv[:3] == ["gh", "pr", "view"]:
            if self.pr_returncode:
                return completed(b"", self.pr_returncode, b"no such pull request")
            return completed(json.dumps(self.payload).encode("utf-8"))
        raise AssertionError(f"unexpected command: {argv}")

    def call_matching(self, prefix):
        return next(call for call in self.calls if call[: len(prefix)] == prefix)


class InputsTestCase(unittest.TestCase):
    def setUp(self):
        inputs_mod._gh_version.cache_clear()
        self.addCleanup(inputs_mod._gh_version.cache_clear)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.run_dir = Path(self._tmp.name) / "run"

    def build(
        self,
        gh,
        policy=None,
        base_ref=GHSTACK_BASE_REF,
        cutoff=CUTOFF,
        gh_version=(2, 93, 0),
    ):
        with mock.patch.object(inputs_mod, RUN_SEAM, side_effect=gh), mock.patch.object(
            inputs_mod, GH_VERSION_SEAM, return_value=gh_version
        ):
            return build_inputs(
                REPO,
                PR_NUMBER,
                base_ref,
                HEAD_SHA,
                cutoff,
                self.run_dir,
                policy or make_policy(),
            )

    def build_logging(self, level, gh, **kwargs):
        """``build`` for the paths that degrade, asserting they say so as they do.

        ``assertLogs`` also keeps the expected traceback out of the test output, so a
        run that prints one is reporting a real fault rather than a covered case.
        """
        with self.assertLogs(inputs_mod.logger, level):
            return self.build(gh, **kwargs)


class DiffFetchTest(InputsTestCase):
    """The reviewed change is the PR's own diff, against its own base ref."""

    def test_the_compare_uses_the_base_ref_rather_than_the_default_branch(self):
        gh = FakeGh()
        self.build(gh)
        endpoint = gh.call_matching(["gh", "api"])[-1]
        self.assertEqual(
            endpoint, f"repos/{REPO}/compare/{GHSTACK_BASE_REF}...{HEAD_SHA}"
        )

    def test_the_endpoint_is_rooted_at_repos_so_gh_cannot_be_sent_elsewhere(self):
        gh = FakeGh()
        self.build(gh)
        self.assertTrue(gh.call_matching(["gh", "api"])[-1].startswith("repos/"))

    def test_the_diff_accept_header_is_sent(self):
        gh = FakeGh()
        self.build(gh)
        call = gh.call_matching(["gh", "api"])
        self.assertIn("application/vnd.github.diff", call[call.index("-H") + 1])

    def test_the_diff_is_written_verbatim_under_the_ci_basename(self):
        gh = FakeGh()
        result = self.build(gh)
        self.assertEqual(result.diff_path.name, inputs_mod.DIFF_FILENAME)
        self.assertEqual(result.diff_path.read_bytes(), DIFF)

    def test_a_base_ref_carrying_parent_traversal_is_refused(self):
        with self.assertRaises(ValueError):
            self.build(FakeGh(), base_ref="../../../etc/passwd")

    def test_a_failed_diff_fetch_raises_rather_than_writing_an_empty_diff(self):
        def failing(argv):
            return completed(b"", 1, b"HTTP 404")

        with self.assertRaises(RuntimeError) as caught:
            self.build(failing)
        self.assertIn("404", str(caught.exception))


class EscapeSequenceFlagTest(InputsTestCase):
    """The gh escape-sequence flag is passed only to a gh that has it."""

    def test_gh_2_93_0_does_not_receive_the_flag(self):
        gh = FakeGh()
        self.build(gh, gh_version=(2, 93, 0))
        self.assertNotIn(
            inputs_mod.ESCAPE_SEQUENCE_FLAG, gh.call_matching(["gh", "api"])
        )

    def test_gh_2_96_9_does_not_receive_the_flag(self):
        gh = FakeGh()
        self.build(gh, gh_version=(2, 96, 9))
        self.assertNotIn(
            inputs_mod.ESCAPE_SEQUENCE_FLAG, gh.call_matching(["gh", "api"])
        )

    def test_gh_2_97_0_receives_the_flag(self):
        gh = FakeGh()
        self.build(gh, gh_version=(2, 97, 0))
        self.assertIn(inputs_mod.ESCAPE_SEQUENCE_FLAG, gh.call_matching(["gh", "api"]))

    def test_gh_3_0_0_receives_the_flag(self):
        gh = FakeGh()
        self.build(gh, gh_version=(3, 0, 0))
        self.assertIn(inputs_mod.ESCAPE_SEQUENCE_FLAG, gh.call_matching(["gh", "api"]))

    def test_an_unreadable_gh_version_omits_the_flag(self):
        gh = FakeGh()
        self.build_logging("WARNING", gh, gh_version=None)
        self.assertNotIn(
            inputs_mod.ESCAPE_SEQUENCE_FLAG, gh.call_matching(["gh", "api"])
        )

    def test_the_version_is_parsed_out_of_ghs_banner(self):
        banner = b"gh version 2.93.0 (2026-05-27)\nhttps://github.com/cli/cli\n"
        with mock.patch.object(inputs_mod, RUN_SEAM, return_value=completed(banner)):
            self.assertEqual(inputs_mod._gh_version(), (2, 93, 0))

    def test_a_gh_that_will_not_run_reports_no_version(self):
        with mock.patch.object(inputs_mod, RUN_SEAM, return_value=completed(b"", 127)):
            self.assertIsNone(inputs_mod._gh_version())


class SizeGateTest(InputsTestCase):
    """The gate matches the workflow's comparison, including wc's line semantics."""

    def test_a_diff_inside_both_caps_is_not_too_large(self):
        result = self.build(FakeGh(), policy=make_policy(2000, 500000))
        self.assertFalse(result.too_large)

    def test_a_cap_equal_to_the_measurement_is_not_a_breach(self):
        result = self.build(FakeGh(), policy=make_policy(3, len(DIFF)))
        self.assertEqual((result.diff_lines, result.diff_bytes), (3, len(DIFF)))
        self.assertFalse(result.too_large)

    def test_one_line_over_the_line_cap_is_a_breach(self):
        result = self.build(FakeGh(), policy=make_policy(2, 500000))
        self.assertTrue(result.too_large)

    def test_one_byte_over_the_byte_cap_is_a_breach(self):
        result = self.build(FakeGh(), policy=make_policy(2000, len(DIFF) - 1))
        self.assertTrue(result.too_large)

    def test_an_unterminated_final_line_is_not_counted_as_wc_would_not(self):
        gh = FakeGh(diff=b"one\ntwo\nthree")
        result = self.build(gh)
        self.assertEqual(result.diff_lines, 2)
        self.assertEqual(result.diff_bytes, 13)


class CommentFilterTest(InputsTestCase):
    """Only human comments the replayed verdict could have seen reach the model."""

    def metadata(self, comments, cutoff=CUTOFF, dropped_unreadably=False):
        gh = FakeGh(payload=pr_payload(comments))
        if dropped_unreadably:
            result = self.build_logging("WARNING", gh, cutoff=cutoff)
        else:
            result = self.build(gh, cutoff=cutoff)
        self.assertIsNotNone(result.metadata_path)
        return json.loads(result.metadata_path.read_text(encoding="utf-8"))

    def test_a_comment_created_after_the_verdict_is_dropped(self):
        document = self.metadata([comment("alice", AFTER)])
        self.assertEqual(document["comments"], [])

    def test_a_comment_created_before_the_verdict_is_kept(self):
        document = self.metadata([comment("alice", BEFORE)])
        self.assertEqual([c["author"] for c in document["comments"]], ["alice"])

    def test_a_comment_created_at_the_verdict_instant_is_dropped(self):
        exact = "2026-09-01T12:00:00Z"
        self.assertEqual(self.metadata([comment("alice", exact)])["comments"], [])

    def test_an_aware_cutoff_is_compared_in_utc(self):
        cutoff = datetime(2026, 9, 1, 5, 0, 0, tzinfo=timezone(timedelta(hours=-7)))
        document = self.metadata([comment("alice", "2026-09-01T11:59:00Z")], cutoff)
        self.assertEqual([c["author"] for c in document["comments"]], ["alice"])

    def test_a_comment_with_an_unparseable_timestamp_is_dropped(self):
        document = self.metadata(
            [comment("alice", "last tuesday")], dropped_unreadably=True
        )
        self.assertEqual(document["comments"], [])

    def test_a_comment_with_no_timestamp_is_dropped(self):
        stripped = comment("alice")
        del stripped["createdAt"]
        document = self.metadata([stripped], dropped_unreadably=True)
        self.assertEqual(document["comments"], [])

    def test_the_bot_suffix_is_excluded_case_insensitively(self):
        authors = [comment("pytorchgreenlight[bot]"), comment("Dependabot[Bot]")]
        self.assertEqual(self.metadata(authors)["comments"], [])

    def test_the_two_named_bots_are_excluded(self):
        authors = [comment("pytorchmergebot"), comment("facebook-github-bot")]
        self.assertEqual(self.metadata(authors)["comments"], [])

    def test_a_graphql_shaped_app_login_still_reaches_the_model_as_ci_lets_it(self):
        document = self.metadata([comment("vercel")])
        self.assertEqual([c["author"] for c in document["comments"]], ["vercel"])

    def test_the_author_keeps_its_original_case(self):
        document = self.metadata([comment("AlbanD")])
        self.assertEqual(document["comments"][0]["author"], "AlbanD")

    def test_a_comment_with_no_author_object_is_kept_as_an_empty_login(self):
        anonymous = {"body": "ghost", "createdAt": BEFORE}
        self.assertEqual(self.metadata([anonymous])["comments"][0]["author"], "")


class TimestampSuffixTest(unittest.TestCase):
    """GitHub's Z suffix must parse on interpreters older than 3.11 too."""

    def test_a_trailing_z_becomes_an_explicit_utc_offset(self):
        self.assertEqual(
            inputs_mod._normalize_utc_suffix("2026-09-17T22:17:04Z"),
            "2026-09-17T22:17:04+00:00",
        )

    def test_a_lowercase_z_is_handled_too(self):
        self.assertTrue(
            inputs_mod._normalize_utc_suffix("2026-09-17T22:17:04z").endswith("+00:00")
        )

    def test_an_explicit_offset_is_left_alone(self):
        text = "2026-09-17T22:17:04-07:00"
        self.assertEqual(inputs_mod._normalize_utc_suffix(text), text)

    def test_the_normalized_form_is_what_the_filter_parses(self):
        # Belt and braces for the 3.10 case we cannot reproduce on this interpreter:
        # the filter must keep an old comment even when fromisoformat cannot read "Z".
        self.assertTrue(inputs_mod._predates("2026-08-30T10:00:00Z", CUTOFF))
        self.assertFalse(inputs_mod._predates("2026-09-02T10:00:00Z", CUTOFF))


class MetadataDocumentTest(InputsTestCase):
    """The document is the workflow's jq shape, pinned to the judged commit."""

    def test_the_keys_are_the_jq_keys_in_the_jq_order(self):
        gh = FakeGh(payload=pr_payload([comment("alice")]))
        result = self.build(gh)
        document = json.loads(result.metadata_path.read_text(encoding="utf-8"))
        self.assertEqual(
            list(document), ["number", "title", "body", "head_sha", "comments"]
        )
        self.assertEqual(list(document["comments"][0]), ["author", "body", "createdAt"])

    def test_the_head_sha_is_the_judged_commit_not_the_prs_current_head(self):
        gh = FakeGh(payload=dict(pr_payload(), head_sha="f" * 40))
        result = self.build(gh)
        document = json.loads(result.metadata_path.read_text(encoding="utf-8"))
        self.assertEqual(document["head_sha"], HEAD_SHA)

    def test_the_file_lands_under_the_ci_basename(self):
        result = self.build(FakeGh())
        self.assertEqual(result.metadata_path.name, inputs_mod.METADATA_FILENAME)

    def test_non_ascii_bodies_survive_as_utf_8(self):
        gh = FakeGh(payload=pr_payload([comment("alice", body="fix the em—dash")]))
        result = self.build(gh)
        raw = result.metadata_path.read_text(encoding="utf-8")
        self.assertIn("em—dash", raw)


class MetadataFailureTest(InputsTestCase):
    """Metadata is optional context; losing it must not lose the review."""

    def test_a_failed_gh_pr_view_yields_no_metadata_path_and_no_exception(self):
        result = self.build_logging("ERROR", FakeGh(pr_returncode=1))
        self.assertIsNone(result.metadata_path)

    def test_the_diff_is_still_written_when_metadata_fails(self):
        result = self.build_logging("ERROR", FakeGh(pr_returncode=1))
        self.assertEqual(result.diff_path.read_bytes(), DIFF)

    def test_unparseable_metadata_json_yields_no_metadata_path(self):
        def gh(argv):
            if argv[:2] == ["gh", "api"]:
                return completed(DIFF)
            return completed(b"not json at all")

        self.assertIsNone(self.build_logging("ERROR", gh).metadata_path)

    def test_a_metadata_payload_that_is_not_an_object_yields_no_metadata_path(self):
        def gh(argv):
            if argv[:2] == ["gh", "api"]:
                return completed(DIFF)
            return completed(b"[]")

        self.assertIsNone(self.build_logging("ERROR", gh).metadata_path)


if __name__ == "__main__":
    unittest.main()
