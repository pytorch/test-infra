"""Tests for the filing gate in the vLLM torch-nightly triage.

The gate reads fields the analysis agent writes into findings.json. Those two
sides live in different files (the agent's schema is prompted from
.github/workflows/vllm-torch-nightly-triage.yml), so a rename on one side is
invisible to the other -- exactly how ``confidence`` ->
``classification_confidence`` silently disabled all filing. Each case below
pins one field of that contract.
"""

import re
import unittest
from unittest import mock

from torchci import vllm_triage_file_issues as vtfi

from torchci.vllm_triage_file_issues import (
    classification_confidence,
    cluster_fingerprint,
    eligible,
    fingerprint,
    issue_clusters,
    legacy_fingerprint,
    merge_clusters,
    near_duplicate,
    new_failure_confidence,
    normalize_signature,
)


def cause(**overrides):
    """A cause that is eligible, so each test can break exactly one field."""
    base = {
        "title": "torch.compile miscompiles fused rmsnorm",
        "signature": "AssertionError: Tensor-likes are not close",
        "clusters": [":nvidia: (H100) Kernels"],
        "routing": "pytorch/pytorch",
        "classification_confidence": "high",
        "new_failure_confidence": "high",
        "determined": True,
    }
    base.update(overrides)
    return base


class TestEligible(unittest.TestCase):
    def test_high_confidence_torch_cause_is_filed(self):
        self.assertTrue(eligible(cause()))

    def test_undetermined_cause_is_skipped(self):
        self.assertFalse(eligible(cause(determined=False)))

    def test_unroutable_causes_are_skipped(self):
        # `vllm-project/vllm` used to be skipped here too. It is filed now --
        # see TestRoutingIsNotAFilingGate -- because routing says which repo
        # fixes the bug, not whether the bug is worth tracking.
        self.assertFalse(eligible(cause(routing="infra")))
        self.assertFalse(eligible(cause(routing="")))

    def test_routing_is_matched_case_and_space_insensitively(self):
        self.assertTrue(eligible(cause(routing=" PyTorch/PyTorch ")))
        self.assertTrue(eligible(cause(routing=" VLLM-Project/vLLM ")))

    def test_low_classification_confidence_is_skipped(self):
        self.assertFalse(eligible(cause(classification_confidence="low")))

    def test_known_variant_is_skipped_but_medium_is_filed(self):
        # low == "likely a variant of an existing known issue", which would
        # duplicate a child issue; medium is still worth a look.
        self.assertFalse(eligible(cause(new_failure_confidence="low")))
        self.assertTrue(eligible(cause(new_failure_confidence="medium")))

    def test_med_and_medium_are_the_same_level(self):
        # CONFIDENCE.md documents "med"; the workflow schema says "medium".
        self.assertEqual(
            new_failure_confidence({"new_failure_confidence": "med"}), "medium"
        )
        self.assertEqual(
            classification_confidence({"classification_confidence": "MED"}), "medium"
        )

    def test_legacy_confidence_field_still_gates(self):
        # Pre-rename findings.json: one `confidence`, no new_failure_confidence.
        legacy = {
            "routing": "pytorch/pytorch",
            "confidence": "high",
            "determined": True,
        }
        self.assertTrue(eligible(legacy))
        self.assertFalse(eligible({**legacy, "confidence": "low"}))

    def test_missing_confidence_is_not_eligible_and_is_reported_as_absent(self):
        no_conf = {"routing": "pytorch/pytorch", "determined": True}
        self.assertFalse(eligible(no_conf))
        self.assertEqual(classification_confidence(no_conf), "")
        self.assertEqual(new_failure_confidence(no_conf), "")

    def test_current_agent_schema_is_understood(self):
        # Shape emitted by run 33008738638. The point of the case is that the
        # gate reads the fields rather than failing closed on an unknown schema.
        # The nixl_ep entry is now filed -- it is a well-evidenced cause whose
        # fix happens to live in vLLM, and dropping it is what this change
        # stopped doing; the infra entry is still skipped.
        observed = [
            {
                "title": "torch-nightly cpu and arm64 CI images missing from ECR",
                "routing": "infra",
                "classification_confidence": "high",
                "new_failure_confidence": "high",
                "determined": True,
            },
            {
                "title": "nixl_ep has no torch-2.15 ABI variant",
                "routing": "vllm-project/vllm",
                "classification_confidence": "medium",
                "new_failure_confidence": "high",
                "determined": True,
            },
        ]
        self.assertEqual([eligible(c) for c in observed], [False, True])
        self.assertEqual(
            [classification_confidence(c) for c in observed], ["high", "medium"]
        )


class TestFingerprint(unittest.TestCase):
    """The key must identify the cause, not the log excerpt it arrived in."""

    # Verbatim from test-infra#8761 and #8783: one bug, two issues. Same test,
    # same assertion, same cluster -- but #8761's signature kept pytest's
    # continuation line and #8783's did not, so the raw-text hash differed and
    # the recurrence check filed a second issue two days later.
    SIG_WITH_TAIL = (
        "AssertionError: assert 2 == 0\n"
        " +  where 2 = op_count(<OpOverload(op='aten.slice_scatter', "
        "overload='default')>)"
    )
    SIG_BARE = "AssertionError: assert 2 == 0"
    CLUSTERS = [":nvidia: (L4) PyTorch Compilation Passes"]

    def _cause(self, signature):
        return {"signature": signature, "clusters": list(self.CLUSTERS)}

    def test_truncated_pytest_tail_does_not_split_a_cause(self):
        self.assertEqual(
            fingerprint("pytorch/test-infra", self._cause(self.SIG_WITH_TAIL)),
            fingerprint("pytorch/test-infra", self._cause(self.SIG_BARE)),
        )

    def test_legacy_key_reproduces_the_issues_actually_filed(self):
        # Guards the migration path: these are the keys in the live issue
        # bodies, so a lookup fallback on them must keep matching.
        self.assertEqual(
            legacy_fingerprint("pytorch/test-infra", self._cause(self.SIG_WITH_TAIL)),
            "7c92bb1993d0f853",
        )
        self.assertEqual(
            legacy_fingerprint("pytorch/test-infra", self._cause(self.SIG_BARE)),
            "982efc048a4aed36",
        )

    def test_whitespace_and_blank_lines_are_not_identity(self):
        self.assertEqual(
            fingerprint("pytorch/test-infra", self._cause("RuntimeError:  boom")),
            fingerprint("pytorch/test-infra", self._cause("\nRuntimeError: boom  \n")),
        )

    def test_different_exceptions_stay_distinct(self):
        self.assertNotEqual(
            fingerprint(
                "pytorch/test-infra", self._cause("AssertionError: assert 2 == 0")
            ),
            fingerprint(
                "pytorch/test-infra", self._cause("AssertionError: assert 3 == 0")
            ),
        )

    # Verbatim from test-infra#8786 (MI355) and #8839 (B200): byte-identical
    # GSM8K assertion on two accelerators, filed twice because the cluster name
    # was part of the key. One cause, so one issue with both clusters on it.
    def test_same_exception_in_a_different_cluster_is_one_cause(self):
        a = {
            "signature": self.SIG_BARE,
            "clusters": [":nvidia: (L4) PyTorch Compilation Passes"],
        }
        b = {"signature": self.SIG_BARE, "clusters": [":nvidia: (B200) Distributed"]}
        self.assertEqual(
            fingerprint("pytorch/test-infra", a), fingerprint("pytorch/test-infra", b)
        )

    def test_cluster_key_reproduces_the_issues_actually_filed(self):
        # The keys in the live issue bodies of #8808 and #8786. The fallback
        # lookup must keep matching them or every open child is re-filed once.
        self.assertEqual(
            cluster_fingerprint(
                "pytorch/test-infra",
                {
                    "signature": "RuntimeError: DeepEPv2 communicator properties "
                    "query failed; networking capability could not be determined.",
                    "clusters": [
                        ":nvidia: (B200) Distributed",
                        ":nvidia: (B200) FusedMoE Layer Kernels",
                    ],
                },
            ),
            "a693ee5560dce401",
        )
        self.assertEqual(
            cluster_fingerprint(
                "pytorch/test-infra",
                {
                    "signature": "AssertionError: GSM8K metric too low: "
                    "0.0000 < 0.9200 - 0.0800 = 0.8400",
                    "clusters": [":amd: (MI355) LM Eval Spec Decode"],
                },
            ),
            "15ba5aedfb5c45d1",
        )

    def test_normalize_keeps_the_assertion_drops_the_explanation(self):
        self.assertEqual(
            normalize_signature(self.SIG_WITH_TAIL), "AssertionError: assert 2 == 0"
        )

    # test-infra#8838 quoted the same failure as #8761 with the introspection
    # tail folded onto the assertion line, which the `^`-anchored strip missed.
    SIG_INLINE_TAIL = (
        "AssertionError: assert 2 == 0 +  where 2 = "
        "op_count(<OpOverload(op='aten.slice_scatter', overload='default')>)"
    )

    def test_inline_pytest_tail_does_not_split_a_cause(self):
        self.assertEqual(
            normalize_signature(self.SIG_INLINE_TAIL), "AssertionError: assert 2 == 0"
        )
        self.assertEqual(
            fingerprint("pytorch/test-infra", self._cause(self.SIG_INLINE_TAIL)),
            fingerprint("pytorch/test-infra", self._cause(self.SIG_BARE)),
        )

    # test-infra#8875 rewrote #8761's tail without pytest's `+` marker and with
    # the OpOverload repr collapsed.
    SIG_BARE_WHERE = (
        "AssertionError: assert 2 == 0 where 2 = op_count(aten.slice_scatter.default)"
    )

    def test_tail_without_the_plus_marker_does_not_split_a_cause(self):
        self.assertEqual(
            normalize_signature(self.SIG_BARE_WHERE), "AssertionError: assert 2 == 0"
        )
        self.assertEqual(
            fingerprint("pytorch/test-infra", self._cause(self.SIG_BARE_WHERE)),
            fingerprint("pytorch/test-infra", self._cause(self.SIG_WITH_TAIL)),
        )

    def test_where_outside_an_assertion_is_kept(self):
        # Only pytest's introspection tail is noise; "where" in a message is
        # part of the identity.
        self.assertEqual(
            normalize_signature("RuntimeError: cannot tell where the graph broke"),
            "RuntimeError: cannot tell where the graph broke",
        )

    def test_a_plus_that_is_not_pytest_introspection_is_kept(self):
        # Only the ` + where|and|assert ` form is pytest's; arithmetic in a
        # message is part of the identity.
        self.assertEqual(
            normalize_signature("AssertionError: 1 + 2 != 4"),
            "AssertionError: 1 + 2 != 4",
        )


class TestRoutingIsNotAFilingGate(unittest.TestCase):
    """A vLLM-side cause is filed too; routing picks the umbrella section."""

    def test_vllm_routed_cause_is_eligible(self):
        # Verbatim shape of the cuda-bindings 13.4 cudaIpcMemHandle_t finding,
        # emitted on three consecutive runs and dropped each time.
        c = cause(routing="vllm-project/vllm", new_failure_confidence="high")
        self.assertTrue(eligible(c))

    def test_torch_routed_cause_is_still_eligible(self):
        self.assertTrue(eligible(cause(routing="pytorch/pytorch")))

    def test_infra_and_undetermined_routings_are_still_skipped(self):
        for r in ("infra", "", "undetermined"):
            self.assertFalse(eligible(cause(routing=r)), r)

    def test_each_routing_has_a_section(self):
        for r in vtfi.FILED_ROUTINGS:
            self.assertIn(r, vtfi.SECTIONS)


class TestInsertInSection(unittest.TestCase):
    # The live #8610 body: the vLLM section precedes the torch one, so
    # appending at the end of the body files everything as a torch regression.
    BODY = (
        "## torch 2.15 nightly - vLLM CI regressions\n\n"
        "### Method\n\nsome prose\n\n"
        "### Regression on vLLM side\n\n"
        "- [ ]  https://github.com/vllm-project/vllm/issues/58599\n\n"
        "### Confirmed regressions\n\n"
        "- [ ] #8745 - qk-norm+rope fusion pass matches zero times\n"
    )

    def _lines_under(self, body, section):
        rest = body.partition(section)[2]
        nxt = re.search(r"^### ", rest, re.M)
        chunk = rest[: nxt.start()] if nxt else rest
        return [ln for ln in chunk.splitlines() if ln.startswith("- [")]

    def test_vllm_entry_lands_in_the_vllm_section(self):
        out = vtfi.insert_in_section(
            self.BODY, vtfi.SECTIONS["vllm-project/vllm"], "- [ ] #9001 - minimax"
        )
        self.assertIn(
            "- [ ] #9001 - minimax",
            self._lines_under(out, "### Regression on vLLM side"),
        )
        # ...and did not leak into the torch list.
        self.assertEqual(
            self._lines_under(out, "### Confirmed regressions"),
            ["- [ ] #8745 - qk-norm+rope fusion pass matches zero times"],
        )

    def test_torch_entry_lands_in_the_torch_section(self):
        out = vtfi.insert_in_section(
            self.BODY, vtfi.SECTIONS["pytorch/pytorch"], "- [ ] #9002 - inductor"
        )
        self.assertEqual(
            self._lines_under(out, "### Confirmed regressions"),
            [
                "- [ ] #8745 - qk-norm+rope fusion pass matches zero times",
                "- [ ] #9002 - inductor",
            ],
        )
        self.assertEqual(len(self._lines_under(out, "### Regression on vLLM side")), 1)

    def test_existing_entry_is_not_duplicated(self):
        line = "- [ ] #8745 - qk-norm+rope fusion pass matches zero times"
        self.assertEqual(
            vtfi.insert_in_section(self.BODY, vtfi.SECTIONS["pytorch/pytorch"], line),
            self.BODY,
        )

    def test_missing_section_is_created(self):
        body = "## title\n\n### Confirmed regressions\n\n- [ ] #1 - a\n"
        out = vtfi.insert_in_section(
            body, vtfi.SECTIONS["vllm-project/vllm"], "- [ ] #2 - b"
        )
        self.assertIn("### Regression on vLLM side", out)
        self.assertIn("- [ ] #2 - b", self._lines_under(out, "### Regression on vLLM"))

    def test_the_template_ships_both_sections(self):
        body = vtfi.umbrella_body("2.15", {})
        for s in vtfi.SECTIONS.values():
            self.assertIn(s, body)


class TestNearDuplicate(unittest.TestCase):
    """The rewording case the key cannot catch, from #8808 and #8817."""

    B200 = [":nvidia: (B200) Distributed", ":nvidia: (B200) FusedMoE Layer Kernels"]

    def _issue(self, number, signature, clusters):
        body = (
            f"## Signature\n\n```\n{signature}\n```\n\n"
            "## Affected job clusters\n\n"
            + "\n".join(f"- `{c}`" for c in clusters)
            + "\n\n## Suggested routing\n\npytorch/pytorch\n"
        )
        return {"number": number, "body": body}

    def test_reworded_same_cause_is_matched(self):
        child = self._issue(
            8808,
            "RuntimeError: DeepEPv2 communicator properties query failed; "
            "networking capability could not be determined.",
            self.B200,
        )
        cause = {
            "signature": "RuntimeError: Failed to determine NCCL GIN support",
            "clusters": list(reversed(self.B200)),
        }
        self.assertEqual(near_duplicate(cause, [child])["number"], 8808)

    def test_different_exception_type_is_not_a_duplicate(self):
        child = self._issue(8808, "RuntimeError: boom", self.B200)
        cause = {"signature": "AssertionError: boom", "clusters": list(self.B200)}
        self.assertIsNone(near_duplicate(cause, [child]))

    def test_disjoint_clusters_are_not_a_duplicate(self):
        child = self._issue(8808, "RuntimeError: boom", self.B200)
        cause = {
            "signature": "RuntimeError: something else",
            "clusters": [":amd: (MI355) LM Eval Spec Decode"],
        }
        self.assertIsNone(near_duplicate(cause, [child]))

    def test_a_single_shared_cluster_out_of_many_is_not_enough(self):
        child = self._issue(8808, "RuntimeError: boom", self.B200)
        cause = {
            "signature": "RuntimeError: unrelated",
            "clusters": [
                ":nvidia: (B200) Distributed",
                ":amd: (MI355) LM Eval Spec Decode",
                ":nvidia: (L4) PyTorch Compilation Passes",
                ":nvidia: (H100) Fusion E2E Quick",
            ],
        }
        self.assertIsNone(near_duplicate(cause, [child]))

    def test_children_are_scoped_to_one_torch_minor(self):
        # A cause from the current cycle must not land on last cycle's issue.
        # near_duplicate() matches on exception type and clusters alone, so the
        # scoping has to happen when the candidates are fetched.
        items = [
            {"number": 8000, "title": "[vllm][torch 2.14] older cause", "body": ""},
            {"number": 8900, "title": "[vllm][torch 2.15] current cause", "body": ""},
        ]
        with mock.patch.object(vtfi, "_req", return_value={"items": items}):
            self.assertEqual(
                [i["number"] for i in vtfi.open_children("t", "r", "2.15")], [8900]
            )
            self.assertEqual(
                [i["number"] for i in vtfi.open_children("t", "r")], [8000, 8900]
            )

    def test_signature_without_an_exception_type_never_matches(self):
        child = self._issue(8808, "RuntimeError: boom", self.B200)
        cause = {"signature": "something went wrong", "clusters": list(self.B200)}
        self.assertIsNone(near_duplicate(cause, [child]))


class TestMergeClusters(unittest.TestCase):
    BODY = (
        "## Signature\n\n```\nRuntimeError: boom\n```\n\n"
        "## Affected job clusters\n\n- `:nvidia: (B200) Distributed`\n\n"
        "## Suggested routing\n\npytorch/pytorch\n"
    )

    def test_new_cluster_is_appended_and_reported(self):
        merged, added = merge_clusters(
            self.BODY,
            [":nvidia: (B200) Distributed", ":amd: (MI355) LM Eval Spec Decode"],
        )
        self.assertEqual(added, [":amd: (MI355) LM Eval Spec Decode"])
        self.assertEqual(
            issue_clusters(merged),
            [":nvidia: (B200) Distributed", ":amd: (MI355) LM Eval Spec Decode"],
        )
        # The surrounding template must survive the rewrite.
        self.assertIn("## Suggested routing", merged)
        self.assertIn("RuntimeError: boom", merged)

    def test_known_cluster_is_a_no_op(self):
        merged, added = merge_clusters(self.BODY, [":nvidia: (B200) Distributed"])
        self.assertEqual(added, [])
        self.assertEqual(merged, self.BODY)


class TestReportSilences(unittest.TestCase):
    """A cause is only called quiet when its clusters actually ran and passed."""

    MINOR = "2.15"

    def _child(self, number, clusters):
        body = (
            "## Signature\n\n```\nRuntimeError: boom\n```\n\n"
            "## Affected job clusters\n\n"
            + "\n".join(f"- `{c}`" for c in clusters)
            + "\n"
        )
        return {
            "number": number,
            "title": f"[vllm][torch {self.MINOR}] something broke",
            "body": body,
        }

    def _run(self, report, children, matched=frozenset()):
        posted = []

        def fake_req(method, path, token, body=None):
            if method == "GET" and "/comments" in path:
                return []
            posted.append((method, path, body))
            return {}

        with mock.patch.object(vtfi, "_req", side_effect=fake_req):
            vtfi.report_silences(
                "t", "pytorch/test-infra", report, children, set(matched), self.MINOR
            )
        return posted

    def test_all_clusters_passed_is_reported(self):
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        posted = self._run(
            {
                "torch_nightly_build": 90640,
                "baseline_build": 90589,
                "passed": [":nvidia: (B200) Distributed"],
            },
            [child],
        )
        self.assertEqual(len(posted), 1)
        body = posted[0][2]["body"]
        self.assertIn("Did not reproduce", body)
        self.assertIn("First quiet run", body)
        self.assertIn(f"<!-- {vtfi.SILENT_PREFIX}: 1 -->", body)

    def test_a_cluster_that_did_not_run_is_not_a_fix(self):
        # The regression-vs-missing-coverage trap: absence from the failing
        # buckets is not evidence of a pass.
        child = self._child(
            8784,
            [":nvidia: (B200) Distributed", ":amd: (MI355) LM Eval Spec Decode"],
        )
        posted = self._run(
            {
                "torch_nightly_build": 90640,
                "baseline_build": 90589,
                "passed": [":nvidia: (B200) Distributed"],
            },
            [child],
        )
        self.assertEqual(posted, [])

    def test_a_cause_that_reproduced_is_not_reported_quiet(self):
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        posted = self._run(
            {
                "torch_nightly_build": 90640,
                "baseline_build": 90589,
                "passed": [":nvidia: (B200) Distributed"],
            },
            [child],
            matched={8784},
        )
        self.assertEqual(posted, [])

    def test_other_torch_versions_are_left_alone(self):
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        child["title"] = "[vllm][torch 2.14] something broke"
        posted = self._run(
            {
                "torch_nightly_build": 90640,
                "baseline_build": 90589,
                "passed": [":nvidia: (B200) Distributed"],
            },
            [child],
        )
        self.assertEqual(posted, [])

    def test_a_report_without_passed_data_says_nothing(self):
        # An older report.json predating the `passed` field must not be read
        # as "every tracked cause is fixed".
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        posted = self._run(
            {"torch_nightly_build": 90640, "baseline_build": 90589}, [child]
        )
        self.assertEqual(posted, [])

    def test_streak_stops_repeating_past_the_limit(self):
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        report = {
            "torch_nightly_build": 90640,
            "baseline_build": 90589,
            "passed": [":nvidia: (B200) Distributed"],
        }
        posted = []

        def fake_req(method, path, token, body=None):
            if method == "GET" and "/comments" in path:
                return [
                    {
                        "body": f"<!-- {vtfi.SILENT_PREFIX}: "
                        f"{vtfi.SILENT_COMMENT_LIMIT} -->"
                    }
                ]
            posted.append((method, path, body))
            return {}

        with mock.patch.object(vtfi, "_req", side_effect=fake_req):
            vtfi.report_silences(
                "t", "pytorch/test-infra", report, [child], set(), self.MINOR
            )
        self.assertEqual(posted, [])

    def test_a_recurrence_resets_the_streak(self):
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        report = {
            "torch_nightly_build": 90640,
            "baseline_build": 90589,
            "passed": [":nvidia: (B200) Distributed"],
        }
        posted = []

        def fake_req(method, path, token, body=None):
            if method == "GET" and "/comments" in path:
                return [
                    {"body": f"<!-- {vtfi.SILENT_PREFIX}: 2 -->"},
                    {"body": "Still reproducing on torch-nightly build [#1](x)."},
                ]
            posted.append((method, path, body))
            return {}

        with mock.patch.object(vtfi, "_req", side_effect=fake_req):
            vtfi.report_silences(
                "t", "pytorch/test-infra", report, [child], set(), self.MINOR
            )
        self.assertIn(f"<!-- {vtfi.SILENT_PREFIX}: 1 -->", posted[0][2]["body"])


if __name__ == "__main__":
    unittest.main()
