"""Tests for the diff-size and verdict-staleness half of the decision export.

Every case here is a defect found while designing the export, so each one is
pinned to the number it would otherwise ship wrong. Nothing touches the network:
``_fetch_compare_files`` is the only reach out of ``loc.py`` and every test
patches it.

The two ``*_files.json`` fixtures are trimmed captures of
``/repos/pytorch/pytorch/pulls/{N}/files`` and carry reference counts measured
against a parser-exact classifier over the whole corpus: 164128 is
(20 loc, 12 sig_loc) and 192132 is (35 loc, 0 sig_loc).
"""

import json
import unittest
from pathlib import Path
from unittest import mock

from torchci.greenlight_decisions import loc as loc_mod
from torchci.greenlight_decisions.loc import classify_patch, compute_loc, is_doc_path


FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"


COMPARE_SEAM = "_fetch_compare_files"

REPO = "pytorch/pytorch"
BASE_SHA = "b" * 40
JUDGED_SHA = "1" * 40
FINAL_SHA = "2" * 40


def load_files_fixture(pr_number: int) -> list:
    path = FIXTURES_DIR / f"greenlight_pr_{pr_number}_files.json"
    return json.loads(path.read_text())


def patch_file(filename, patch, status="modified", **extra):
    """One entry of the GitHub compare/files payload.

    additions/deletions are derived from the patch because compute_loc
    cross-checks its own walk against them and flags a mismatch.
    """
    changed = [line for line in patch.split("\n") if line[:1] in ("+", "-")]
    entry = {
        "filename": filename,
        "status": status,
        "additions": sum(1 for line in changed if line[0] == "+"),
        "deletions": sum(1 for line in changed if line[0] == "-"),
        "changes": len(changed),
        "patch": patch,
    }
    entry.update(extra)
    return entry


def binary_file(filename, status="added"):
    """A binary entry: GitHub reports a blob sha but no patch and no line counts.

    The sha is what distinguishes a real binary from a patchless entry that is
    not a file blob at all, such as a pure rename.
    """
    return {
        "filename": filename,
        "status": status,
        "sha": "0" * 40,
        "additions": 0,
        "deletions": 0,
        "changes": 0,
    }


class TestIsDocPath(unittest.TestCase):
    """Doc classification, including the .txt exclusion that a prior attempt got wrong."""

    def test_doc_extensions(self) -> None:
        for path in (
            "README.md",
            "foo.rst",
            "some/deep/guide.markdown",
            "notes.adoc",
        ):
            with self.subTest(path=path):
                self.assertTrue(is_doc_path(path))

    def test_doc_extension_is_case_insensitive(self) -> None:
        self.assertTrue(is_doc_path("README.MD"))

    def test_doc_basenames(self) -> None:
        for path in (
            "LICENSE",
            "NOTICE",
            "AUTHORS",
            "COPYING",
            "CHANGELOG",
            "third_party/fmt/LICENSE",
        ):
            with self.subTest(path=path):
                self.assertTrue(is_doc_path(path))

    def test_docs_prefix_beats_code_extension(self) -> None:
        # A .py under docs/ is documentation, not code -- the prefix rule wins.
        self.assertTrue(is_doc_path("docs/foo.py"))
        self.assertTrue(is_doc_path("docs/source/conf.py"))

    def test_txt_is_not_a_doc_extension(self) -> None:
        # pytorch has 301 .txt files and 4 are docs; the rest are CMake build
        # logic and requirements pins, which must be counted as code.
        self.assertFalse(is_doc_path("CMakeLists.txt"))
        self.assertFalse(is_doc_path("caffe2/CMakeLists.txt"))
        self.assertFalse(is_doc_path("requirements.txt"))
        self.assertFalse(is_doc_path(".ci/docker/requirements-ci.txt"))

    def test_txt_under_docs_is_a_doc(self) -> None:
        # The prefix rule still applies; only the extension rule excludes .txt.
        self.assertTrue(is_doc_path("docs/notes.txt"))

    def test_ordinary_code_is_not_a_doc(self) -> None:
        for path in (
            "torch/nn/module.py",
            "aten/src/ATen/native/Linear.cpp",
            "buckbuild.bzl",
            "docsomething/readme_generator.py",
        ):
            with self.subTest(path=path):
                self.assertFalse(is_doc_path(path))


class TestLocStatusSeverity(unittest.TestCase):
    """The severity order decides which status survives when a diff hits more
    than one problem, so the placements are load-bearing rather than cosmetic.
    Sorting this tuple alphabetically would silently reorder all of them."""

    def test_the_full_severity_order(self) -> None:
        self.assertEqual(
            loc_mod.LOC_STATUSES_BY_SEVERITY,
            (
                loc_mod.LOC_STATUS_OK,
                loc_mod.LOC_STATUS_BINARY_SKIPPED,
                loc_mod.LOC_STATUS_TRUNCATED,
                loc_mod.LOC_STATUS_MISSING_SHA,
                loc_mod.LOC_STATUS_PARSE_FAILED,
            ),
        )

    def severity(self, status):
        return loc_mod.LOC_STATUSES_BY_SEVERITY.index(status)

    def test_missing_sha_outranks_the_partial_measurements(self) -> None:
        # Nothing was measured at all behind missing_sha, where truncated and
        # binary_skipped both still produced a number worth reporting.
        self.assertGreater(
            self.severity(loc_mod.LOC_STATUS_MISSING_SHA),
            self.severity(loc_mod.LOC_STATUS_TRUNCATED),
        )
        self.assertGreater(
            self.severity(loc_mod.LOC_STATUS_MISSING_SHA),
            self.severity(loc_mod.LOC_STATUS_BINARY_SKIPPED),
        )

    def test_missing_sha_loses_to_parse_failed(self) -> None:
        # An absent input is an expected data condition; a failed read is a
        # fault, and a fault must never be masked by a row never attempted.
        self.assertLess(
            self.severity(loc_mod.LOC_STATUS_MISSING_SHA),
            self.severity(loc_mod.LOC_STATUS_PARSE_FAILED),
        )

    def test_ok_is_the_least_severe(self) -> None:
        self.assertEqual(loc_mod.LOC_STATUSES_BY_SEVERITY[0], loc_mod.LOC_STATUS_OK)

    def test_an_unknown_status_outranks_every_known_one(self) -> None:
        # The free-text "error: ..." default has to win, or a known status would
        # mask a real failure the enum has no name for.
        worst_known = loc_mod.LOC_STATUSES_BY_SEVERITY[-1]
        self.assertEqual(
            loc_mod._worst_status(worst_known, "error: RuntimeError: boom"),
            "error: RuntimeError: boom",
        )

    def test_no_duplicate_statuses(self) -> None:
        statuses = loc_mod.LOC_STATUSES_BY_SEVERITY
        self.assertEqual(len(statuses), len(set(statuses)))


class TestClassifyPatchCommentTokens(unittest.TestCase):
    """Each comment token drops a line from sig_loc but never from loc."""

    def assert_counts(self, path, patch, loc, sig_loc) -> None:
        self.assertEqual(classify_patch(path, patch), (loc, sig_loc))

    def test_hash_comment(self) -> None:
        patch = "@@ -1,1 +1,3 @@\n+# a comment\n+import os\n someone_else()\n"
        self.assert_counts("torch/foo.py", patch, 2, 1)

    def test_double_slash_comment(self) -> None:
        patch = "@@ -1,1 +1,3 @@\n+// a comment\n+int x = 1;\n context();\n"
        self.assert_counts("aten/foo.cpp", patch, 2, 1)

    def test_block_comment_open(self) -> None:
        patch = "@@ -1,1 +1,3 @@\n+/* a block comment\n+int x = 1;\n context();\n"
        self.assert_counts("aten/foo.cpp", patch, 2, 1)

    def test_block_comment_continuation_star(self) -> None:
        patch = "@@ -1,1 +1,3 @@\n+ * continued block text\n+int x = 1;\n context();\n"
        self.assert_counts("aten/foo.cpp", patch, 2, 1)

    def test_triple_double_quote(self) -> None:
        patch = '@@ -1,1 +1,3 @@\n+"""Module docstring."""\n+import os\n context()\n'
        self.assert_counts("torch/foo.py", patch, 2, 1)

    def test_triple_single_quote(self) -> None:
        patch = "@@ -1,1 +1,3 @@\n+'''Module docstring.'''\n+import os\n context()\n"
        self.assert_counts("torch/foo.py", patch, 2, 1)

    def test_indented_comment_still_a_comment(self) -> None:
        # The token is matched after stripping, so indentation is irrelevant.
        patch = "@@ -1,1 +1,2 @@\n+        # deeply indented note\n context()\n"
        self.assert_counts("torch/foo.py", patch, 1, 0)

    def test_hash_inside_a_code_line_is_code(self) -> None:
        # Only a leading token counts. A trailing comment leaves the line
        # significant, because the code before it is real.
        patch = (
            "@@ -1,1 +1,3 @@\n+x = 1  # set x\n+url = 'http://a/#frag'\n context()\n"
        )
        self.assert_counts("torch/foo.py", patch, 2, 2)

    def test_slashes_inside_a_code_line_are_code(self) -> None:
        patch = '@@ -1,1 +1,2 @@\n+auto p = base_url + "//host";  // note\n context()\n'
        self.assert_counts("aten/foo.cpp", patch, 1, 1)

    def test_blank_added_line_is_not_significant(self) -> None:
        patch = "@@ -1,1 +1,3 @@\n+\n+x = 1\n context()\n"
        self.assert_counts("torch/foo.py", patch, 2, 1)

    def test_whitespace_only_line_is_not_significant(self) -> None:
        patch = "@@ -1,1 +1,3 @@\n+    \n+x = 1\n context()\n"
        self.assert_counts("torch/foo.py", patch, 2, 1)

    def test_doc_file_has_no_significant_lines(self) -> None:
        patch = "@@ -1,0 +1,3 @@\n+# Heading\n+\n+Ordinary prose about the API.\n"
        self.assert_counts("README.md", patch, 3, 0)

    def test_hash_in_c_is_a_preprocessor_directive_not_a_comment(self) -> None:
        # The single case that separates the per-extension rule from a flat one.
        # A flat rule strips every line opening with "#", which in the C family
        # deletes #include, #define and #pragma -- 372 real lines of the corpus,
        # all of them code.
        directives = "@@ -1,0 +1,2 @@\n+#include <vector>\n+#define GUARD 1\n"
        self.assert_counts("aten/foo.h", directives, 2, 2)
        self.assert_counts("aten/foo.cpp", directives, 2, 2)
        # The same two lines in a #-comment language really are comments.
        self.assert_counts("torch/foo.py", directives, 2, 0)
        self.assert_counts("CMakeLists.txt", directives, 2, 0)

    def test_unmapped_extension_strips_nothing_but_blanks(self) -> None:
        patch = "@@ -1,0 +1,3 @@\n+// looks like a comment\n+\n+fn main() {}\n"
        self.assert_counts("src/lib.rs", patch, 3, 2)

    def test_leading_star_deref_is_misread_as_comment(self) -> None:
        # Characterisation, not an endorsement: the classifier is line-local, so
        # a C pointer dereference at column 0 looks like a block-comment
        # continuation. It is one contributor to the aggregate error the cheap
        # classifier was accepted with, which classify.py's docstring states.
        patch = "@@ -1,1 +1,2 @@\n+*ptr = 5;\n context();\n"
        self.assert_counts("aten/foo.cpp", patch, 1, 0)


class TestClassifyPatchHunkWalk(unittest.TestCase):
    """Only +/- lines are counted; headers, context and markers are not."""

    MULTI_HUNK = (
        "@@ -1,4 +1,5 @@\n"
        " context_line_one()\n"
        "-removed_code()\n"
        "+added_code()\n"
        "+another_added()\n"
        " context_line_two()\n"
        "@@ -20,3 +21,3 @@ def something():\n"
        "-old_value = 1\n"
        "+new_value = 2\n"
        " trailing_context()\n"
        "\\ No newline at end of file"
    )

    def test_multi_hunk_exact_counts(self) -> None:
        # 3 changed lines in hunk 1 + 2 in hunk 2. The 3 context lines, the 2
        # @@ headers and the no-newline marker contribute nothing.
        self.assertEqual(classify_patch("torch/foo.py", self.MULTI_HUNK), (5, 5))

    def test_hunk_header_text_is_not_counted(self) -> None:
        # The trailing function signature on an @@ line is a real hunk header
        # and would otherwise be read as a changed line.
        patch = "@@ -20,3 +21,3 @@ def something():\n+x = 1\n"
        self.assertEqual(classify_patch("torch/foo.py", patch), (1, 1))

    def test_no_newline_marker_is_not_counted(self) -> None:
        patch = "@@ -1,1 +1,1 @@\n-a = 1\n\\ No newline at end of file\n+a = 2\n"
        self.assertEqual(classify_patch("torch/foo.py", patch), (2, 2))

    def test_both_sides_count_toward_loc(self) -> None:
        # loc is gross churn: additions plus deletions, not the net delta.
        patch = "@@ -1,3 +1,3 @@\n-a = 1\n-b = 2\n-c = 3\n+a = 9\n+b = 8\n+c = 7\n"
        self.assertEqual(classify_patch("torch/foo.py", patch), (6, 6))

    def test_pure_deletion_counts(self) -> None:
        patch = "@@ -1,3 +1,1 @@\n-a = 1\n-# a note\n context()\n"
        self.assertEqual(classify_patch("torch/foo.py", patch), (2, 1))

    def test_empty_patch(self) -> None:
        self.assertEqual(classify_patch("torch/foo.py", ""), (0, 0))


class TestClassifyPatchAgainstRealDiffs(unittest.TestCase):
    """Fixture diffs reproduce the reference LOC numbers for the whole PR."""

    def totals(self, pr_number):
        loc = sig = 0
        for entry in load_files_fixture(pr_number):
            file_loc, file_sig = classify_patch(entry["filename"], entry["patch"])
            loc += file_loc
            sig += file_sig
        return loc, sig

    def test_mixed_code_and_comments(self) -> None:
        # Two .bzl files, 4 hunks: 20 changed lines, of which 6 are # comments
        # and 2 are blank.
        self.assertEqual(self.totals(164128), (20, 12))

    def test_loc_matches_github_additions_plus_deletions(self) -> None:
        entries = load_files_fixture(164128)
        expected = sum(e["additions"] + e["deletions"] for e in entries)
        self.assertEqual(self.totals(164128)[0], expected)

    def test_pure_docs_pr_has_zero_significant_lines(self) -> None:
        # A 35-line addition to docs/source/community/viable_strict.md.
        self.assertEqual(self.totals(192132), (35, 0))


class ComputeLocTestCase(unittest.TestCase):
    """Shared machinery: compute_loc's GitHub reach is always mocked."""

    def compute(self, per_head, judged=JUDGED_SHA, final=FINAL_SHA):
        """Run compute_loc with `fetch_compare` served from a {head: files} map."""
        seen = []

        def fake_fetch(repo, base, head, *args, **kwargs):
            seen.append((repo, base, head))
            if head not in per_head:
                raise AssertionError(f"unexpected compare head {head!r}")
            return per_head[head]

        with mock.patch.object(loc_mod, COMPARE_SEAM, side_effect=fake_fetch):
            result = compute_loc(REPO, BASE_SHA, judged, final)
        return result, seen


class TestComputeLocRobustness(ComputeLocTestCase):
    """One malformed PR must never abort the export."""

    ONE_LINE = "@@ -1,1 +1,2 @@\n+x = 1\n context()\n"

    def test_binary_file_without_patch_is_skipped(self) -> None:
        # Verified to KeyError if the patch key is read unguarded.
        files = [
            binary_file("docs/img/logo.png"),
            patch_file("torch/foo.py", self.ONE_LINE),
        ]
        result, _ = self.compute({JUDGED_SHA: files, FINAL_SHA: files})
        self.assertEqual(result["loc"], 1)
        self.assertEqual(result["sig_loc"], 1)

    def test_absent_patch_key_is_skipped(self) -> None:
        files = [
            {"filename": "test/data/blob.bin", "status": "modified"},
            patch_file("torch/foo.py", self.ONE_LINE),
        ]
        result, _ = self.compute({JUDGED_SHA: files, FINAL_SHA: files})
        self.assertEqual(result["loc"], 1)

    def test_binary_skip_is_recorded_in_loc_status(self) -> None:
        files = [binary_file("a.png"), patch_file("torch/foo.py", self.ONE_LINE)]
        result, _ = self.compute({JUDGED_SHA: files, FINAL_SHA: files})
        self.assertEqual(result["loc_status"], loc_mod.LOC_STATUS_BINARY_SKIPPED)

    def test_all_files_binary_yields_zero_not_an_error(self) -> None:
        files = [binary_file("a.png")]
        result, _ = self.compute({JUDGED_SHA: files, FINAL_SHA: files})
        self.assertEqual((result["loc"], result["sig_loc"]), (0, 0))

    def test_withheld_oversized_diff_is_truncated_not_binary(self) -> None:
        # A missing patch alongside a positive change count is GitHub declining
        # to render an oversized diff, which understates loc rather than
        # legitimately contributing nothing.
        files = [
            {
                "filename": "torch/generated.cpp",
                "status": "modified",
                "additions": 9000,
                "deletions": 10,
                "changes": 9010,
            }
        ]
        result, _ = self.compute({JUDGED_SHA: files, FINAL_SHA: files})
        self.assertEqual(result["loc_status"], loc_mod.LOC_STATUS_TRUNCATED)

    def test_file_list_at_the_compare_cap_is_truncated(self) -> None:
        # The compare endpoint caps `files` at 300 and does not paginate it.
        files = [
            patch_file(f"torch/f{index}.py", "@@ -1,0 +1,1 @@\n+x = 1\n")
            for index in range(loc_mod.COMPARE_FILE_LIMIT)
        ]
        result, _ = self.compute({JUDGED_SHA: files, FINAL_SHA: files})
        self.assertEqual(result["loc_status"], loc_mod.LOC_STATUS_TRUNCATED)

    def test_walk_disagreeing_with_github_is_parse_failed(self) -> None:
        # The self-check against additions+deletions is the only guard against a
        # silently wrong walk, so a disagreement must not be reported as ok.
        entry = patch_file("torch/foo.py", self.ONE_LINE)
        entry["additions"] = 7
        result, _ = self.compute({JUDGED_SHA: [entry], FINAL_SHA: [entry]})
        self.assertEqual(result["loc_status"], loc_mod.LOC_STATUS_PARSE_FAILED)

    def test_rename_with_edits_is_counted(self) -> None:
        files = [
            patch_file(
                "torch/b.py",
                "@@ -1,2 +1,3 @@\n+x = 1\n-y = 2\n context()\n",
                status="renamed",
                previous_filename="torch/a.py",
            )
        ]
        result, _ = self.compute({JUDGED_SHA: files, FINAL_SHA: files})
        self.assertEqual(result["loc"], 2)
        self.assertEqual(result["sig_loc"], 2)

    def test_rename_judges_each_side_against_its_own_path(self) -> None:
        # Prose moved out of docs/ into a code path: the removed lines were
        # documentation when greenlight judged them, the added lines are not.
        files = [
            patch_file(
                "torch/notes.py",
                "@@ -1,1 +1,1 @@\n-Some prose about the API.\n+Some prose about the API.\n",
                status="renamed",
                previous_filename="docs/notes.py",
            )
        ]
        result, _ = self.compute({JUDGED_SHA: files, FINAL_SHA: files})
        self.assertEqual(result["loc"], 2)
        self.assertEqual(result["sig_loc"], 1)

    def test_rename_without_a_patch_is_skipped(self) -> None:
        # A pure rename carries no patch at all.
        files = [
            {
                "filename": "torch/b.py",
                "status": "renamed",
                "previous_filename": "torch/a.py",
                "additions": 0,
                "deletions": 0,
                "changes": 0,
            }
        ]
        result, _ = self.compute({JUDGED_SHA: files, FINAL_SHA: files})
        self.assertEqual(result["loc"], 0)

    def test_fetch_failure_is_reported_not_raised(self) -> None:
        files = [patch_file("torch/foo.py", self.ONE_LINE)]
        ok, _ = self.compute({JUDGED_SHA: files, FINAL_SHA: files})
        self.assertEqual(ok["loc_status"], loc_mod.LOC_STATUS_OK)

        with mock.patch.object(
            loc_mod, COMPARE_SEAM, side_effect=RuntimeError("compare 502")
        ):
            failed = compute_loc(REPO, BASE_SHA, JUDGED_SHA, FINAL_SHA)

        self.assertIsInstance(failed, dict)
        self.assertEqual(failed["loc_status"], loc_mod.LOC_STATUS_PARSE_FAILED)

    def test_failed_row_still_has_every_key(self) -> None:
        files = [patch_file("torch/foo.py", self.ONE_LINE)]
        ok, _ = self.compute({JUDGED_SHA: files, FINAL_SHA: files})
        with mock.patch.object(
            loc_mod, COMPARE_SEAM, side_effect=RuntimeError("compare 502")
        ):
            failed = compute_loc(REPO, BASE_SHA, JUDGED_SHA, FINAL_SHA)
        self.assertEqual(set(failed.keys()), set(ok.keys()))

    def test_failed_measurement_is_unknown_not_zero(self) -> None:
        # A zero here would be summed and averaged as an empty diff by anyone who
        # does not also join on loc_status. None is the only value that cannot be
        # mistaken for a measurement.
        with mock.patch.object(
            loc_mod, COMPARE_SEAM, side_effect=RuntimeError("compare 502")
        ):
            failed = compute_loc(REPO, BASE_SHA, JUDGED_SHA, FINAL_SHA)
        self.assertIsNone(failed["loc"])
        self.assertIsNone(failed["sig_loc"])
        self.assertNotEqual(failed["loc_status"], loc_mod.LOC_STATUS_OK)

    def test_a_measured_diff_keeps_its_numbers_when_staleness_fails(self) -> None:
        judged = [patch_file("torch/foo.py", self.ONE_LINE)]

        def fake_fetch(repo, base, head):
            if head == JUDGED_SHA:
                return judged
            raise RuntimeError("compare 502")

        with mock.patch.object(loc_mod, COMPARE_SEAM, side_effect=fake_fetch):
            result = compute_loc(REPO, BASE_SHA, JUDGED_SHA, FINAL_SHA)
        self.assertEqual(result["loc"], 1)
        self.assertEqual(result["sig_loc"], 1)

    def test_staleness_failure_does_not_claim_exact(self) -> None:
        # A comparison that could not be made must never read as "the verdict
        # covers what shipped".
        judged = [patch_file("torch/foo.py", self.ONE_LINE)]

        def fake_fetch(repo, base, head):
            if head == JUDGED_SHA:
                return judged
            raise RuntimeError("compare 502")

        with mock.patch.object(loc_mod, COMPARE_SEAM, side_effect=fake_fetch):
            result = compute_loc(REPO, BASE_SHA, JUDGED_SHA, FINAL_SHA)

        # not-measured, not content-changed: an unmeasurable comparison is a
        # missing answer, and reporting it as drift would put the PR on the
        # audit list beside PRs that genuinely changed after their verdict.
        self.assertEqual(result["verdict_staleness"], loc_mod.STALENESS_NOT_MEASURED)
        self.assertNotEqual(result["verdict_staleness"], loc_mod.STALENESS_EXACT)
        self.assertEqual(result["loc"], 1)
        self.assertNotEqual(result["loc_status"], loc_mod.LOC_STATUS_OK)


class TestVerdictStaleness(ComputeLocTestCase):
    JUDGED = [
        patch_file("torch/foo.py", "@@ -1,1 +1,2 @@\n+x = 1\n context()\n"),
        patch_file("torch/bar.py", "@@ -5,1 +5,2 @@\n+y = 2\n context()\n"),
    ]

    def test_equal_shas_are_exact(self) -> None:
        result, seen = self.compute(
            {JUDGED_SHA: self.JUDGED}, judged=JUDGED_SHA, final=JUDGED_SHA
        )
        self.assertEqual(result["verdict_staleness"], "exact")
        self.assertEqual(result["files_changed_after_verdict"], 0)
        self.assertEqual(len(seen), 1, "identical heads need only one compare")

    def test_identical_content_at_different_shas_is_rebase_only(self) -> None:
        # 193218 and 195486: the head moved but the diff is byte-identical.
        final = [dict(entry) for entry in self.JUDGED]
        result, _ = self.compute({JUDGED_SHA: self.JUDGED, FINAL_SHA: final})
        self.assertEqual(result["verdict_staleness"], "rebase-only")
        self.assertEqual(result["files_changed_after_verdict"], 0)

    def test_rename_between_the_heads_counts_the_file_once(self) -> None:
        # Keyed on the head-side path a rename reads as one file disappearing and
        # another arriving, doubling the count for a single moved file.
        judged = [patch_file("torch/old.py", "@@ -1,0 +1,1 @@\n+x = 1\n")]
        final = [
            patch_file(
                "torch/new.py",
                "@@ -1,0 +1,1 @@\n+x = 1\n",
                status="renamed",
                previous_filename="torch/old.py",
            )
        ]
        result, _ = self.compute({JUDGED_SHA: judged, FINAL_SHA: final})
        self.assertEqual(result["verdict_staleness"], "content-changed")
        self.assertEqual(result["files_changed_after_verdict"], 1)

    def test_a_copied_file_is_not_collapsed_onto_its_source(self) -> None:
        # A copy's source still exists on the head side, so following
        # previous_filename for a copy the way a rename does would key both
        # entries alike and let one overwrite the other. When the copy sorts
        # first the survivor is the unchanged source, and a brand-new file that
        # greenlight never saw disappears into a "rebase-only" verdict.
        source = patch_file("torch/src.py", "@@ -1,0 +1,1 @@\n+x = 1\n")
        copy = patch_file(
            "torch/copy.py",
            "@@ -1,0 +1,1 @@\n+y = 2\n",
            status="copied",
            previous_filename="torch/src.py",
        )
        result, _ = self.compute({JUDGED_SHA: [source], FINAL_SHA: [copy, source]})
        self.assertEqual(result["verdict_staleness"], "content-changed")
        self.assertEqual(result["files_changed_after_verdict"], 1)

    def test_reordered_files_are_still_rebase_only(self) -> None:
        result, _ = self.compute(
            {JUDGED_SHA: self.JUDGED, FINAL_SHA: list(reversed(self.JUDGED))}
        )
        self.assertEqual(result["verdict_staleness"], "rebase-only")

    def test_shifted_hunk_headers_are_rebase_only(self) -> None:
        # 194772: the rebase moved ivalue_inl.h down 16 lines, so every @@
        # position shifted while not one content line changed. Comparing raw
        # patches puts a byte-identical diff on the content-changed audit list.
        final = [
            patch_file("torch/foo.py", "@@ -9,1 +9,2 @@\n+x = 1\n context()\n"),
            patch_file("torch/bar.py", "@@ -21,1 +21,2 @@\n+y = 2\n context()\n"),
        ]
        result, _ = self.compute({JUDGED_SHA: self.JUDGED, FINAL_SHA: final})
        self.assertEqual(result["verdict_staleness"], "rebase-only")
        self.assertEqual(result["files_changed_after_verdict"], 0)

    def test_a_shifted_header_does_not_hide_a_real_edit(self) -> None:
        # 194379: of its three files one had only shifted, and the other two were
        # genuinely edited. Dropping the @@ positions must not drop the edits.
        final = [
            patch_file("torch/foo.py", "@@ -9,1 +9,2 @@\n+x = 1\n context()\n"),
            patch_file("torch/bar.py", "@@ -21,1 +21,2 @@\n+y = 99\n context()\n"),
        ]
        result, _ = self.compute({JUDGED_SHA: self.JUDGED, FINAL_SHA: final})
        self.assertEqual(result["verdict_staleness"], "content-changed")
        self.assertEqual(result["files_changed_after_verdict"], 1)

    def test_edited_patch_is_content_changed(self) -> None:
        # 195203: .ci/pytorch/test.sh was edited after the approval.
        final = [
            self.JUDGED[0],
            patch_file("torch/bar.py", "@@ -5,1 +5,2 @@\n+y = 3\n context()\n"),
        ]
        result, _ = self.compute({JUDGED_SHA: self.JUDGED, FINAL_SHA: final})
        self.assertEqual(result["verdict_staleness"], "content-changed")
        self.assertEqual(result["files_changed_after_verdict"], 1)

    def test_dropped_file_is_content_changed(self) -> None:
        # 192258: install_rocm.sh was dropped entirely between verdict and land.
        result, _ = self.compute({JUDGED_SHA: self.JUDGED, FINAL_SHA: [self.JUDGED[0]]})
        self.assertEqual(result["verdict_staleness"], "content-changed")
        self.assertEqual(result["files_changed_after_verdict"], 1)

    def test_added_file_is_content_changed(self) -> None:
        final = self.JUDGED + [
            patch_file("torch/baz.py", "@@ -1,1 +1,2 @@\n+z = 3\n context()\n")
        ]
        result, _ = self.compute({JUDGED_SHA: self.JUDGED, FINAL_SHA: final})
        self.assertEqual(result["verdict_staleness"], "content-changed")
        self.assertEqual(result["files_changed_after_verdict"], 1)

    def test_same_size_different_content_is_content_changed(self) -> None:
        # 194092 is 43 -> 43 lines and 195610 is 2 -> 2, both with different
        # content: a size comparison cannot detect this.
        judged = [patch_file("torch/foo.py", "@@ -1,1 +1,2 @@\n+x = 1\n ctx()\n")]
        final = [patch_file("torch/foo.py", "@@ -1,1 +1,2 @@\n+x = 2\n ctx()\n")]
        result, _ = self.compute({JUDGED_SHA: judged, FINAL_SHA: final})
        self.assertEqual(result["verdict_staleness"], "content-changed")

    def test_loc_is_measured_at_the_judged_head(self) -> None:
        # Using the final head would describe a different diff than the verdict,
        # and the drift is directional: authors push fixes after a NO_LAND.
        judged = [patch_file("torch/foo.py", "@@ -1,1 +1,2 @@\n+x = 1\n ctx()\n")]
        final = [
            patch_file(
                "torch/foo.py",
                "@@ -1,1 +1,4 @@\n+x = 1\n+y = 2\n+z = 3\n ctx()\n",
            )
        ]
        result, _ = self.compute({JUDGED_SHA: judged, FINAL_SHA: final})
        self.assertEqual(result["loc"], 1)


if __name__ == "__main__":
    unittest.main()
