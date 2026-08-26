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
    new_failure_confidence,
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
        self.assertFalse(eligible(cause(classification_confidence="medium")))
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
        # "med" classification is below the bar in either spelling.
        self.assertFalse(eligible(cause(classification_confidence="med")))

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


if __name__ == "__main__":
    unittest.main()
