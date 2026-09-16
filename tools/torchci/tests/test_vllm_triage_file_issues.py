"""Tests for the filing gate in the vLLM torch-nightly triage.

The gate reads fields the analysis agent writes into findings.json. Those two
sides live in different files (the agent's schema is prompted from
.github/workflows/vllm-torch-nightly-triage.yml), so a rename on one side is
invisible to the other -- exactly how ``confidence`` ->
``classification_confidence`` silently disabled all filing. Each case below
pins one field of that contract.
"""

import unittest

from torchci.vllm_triage_file_issues import (
    classification_confidence,
    eligible,
    fingerprint,
    legacy_fingerprint,
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

    def test_non_torch_routing_is_skipped(self):
        self.assertFalse(eligible(cause(routing="vllm-project/vllm")))
        self.assertFalse(eligible(cause(routing="infra")))

    def test_routing_is_matched_case_and_space_insensitively(self):
        self.assertTrue(eligible(cause(routing=" PyTorch/PyTorch ")))

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
        # Shape emitted by run 33008738638, which filed nothing: the gate must
        # skip these on routing alone, not because it cannot read the fields.
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
        self.assertEqual([eligible(c) for c in observed], [False, False])
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

    def test_same_exception_in_a_different_job_stays_distinct(self):
        a = {
            "signature": self.SIG_BARE,
            "clusters": [":nvidia: (L4) PyTorch Compilation Passes"],
        }
        b = {"signature": self.SIG_BARE, "clusters": [":nvidia: (B200) Distributed"]}
        self.assertNotEqual(
            fingerprint("pytorch/test-infra", a), fingerprint("pytorch/test-infra", b)
        )

    def test_normalize_keeps_the_assertion_drops_the_explanation(self):
        self.assertEqual(
            normalize_signature(self.SIG_WITH_TAIL), "AssertionError: assert 2 == 0"
        )


if __name__ == "__main__":
    unittest.main()
