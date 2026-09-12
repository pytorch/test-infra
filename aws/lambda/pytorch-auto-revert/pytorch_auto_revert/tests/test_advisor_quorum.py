import unittest
from datetime import datetime, timedelta, timezone

from pytorch_auto_revert.signal import (
    AdvisorDecision,
    AdvisorVerdict,
    AIAdvisorResult,
    IneligibleReason,
    QuorumResult,
    resolve_advisor_quorum,
    Signal,
)


# Verdict shorthands used across the table below.
REVERT = AdvisorVerdict.REVERT
RELATED = AdvisorVerdict.RELATED
NOT_RELATED = AdvisorVerdict.NOT_RELATED
UNSURE = AdvisorVerdict.UNSURE
GARBAGE = AdvisorVerdict.GARBAGE
INFRA = AdvisorVerdict.INFRA_ISSUE

THRESHOLD = Signal.ADVISOR_CONFIDENCE_THRESHOLD


class TestResolveAdvisorQuorum(unittest.TestCase):
    """Exhaustive unit tests for the pure `resolve_advisor_quorum` resolver.

    Every case asserts BOTH `.decision` and `.dispatch_target`, plus
    representative / block_reason where they carry meaning. Votes are assumed
    already deduped by run_id — the resolver never dedups.
    """

    def setUp(self) -> None:
        self.now = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)

    def _v(
        self,
        verdict: AdvisorVerdict,
        confidence: float = 0.95,
        *,
        mins_ago: int = 1,
        key: str = "k",
    ) -> AIAdvisorResult:
        return AIAdvisorResult(
            verdict=verdict,
            confidence=confidence,
            timestamp=self.now - timedelta(minutes=mins_ago),
            signal_key=key,
        )

    def _resolve(self, votes) -> QuorumResult:
        return resolve_advisor_quorum(votes, self.now)

    # ---- vote-count sweep: 0 / 1 / 2 / 3 ----

    def test_zero_votes_abstain_target_2(self):
        res = self._resolve([])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)
        self.assertEqual(res.dispatch_target, 2)
        self.assertIsNone(res.representative)
        self.assertIsNone(res.block_reason)

    def test_single_revert_abstains_needs_two(self):
        res = self._resolve([self._v(REVERT)])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)
        self.assertEqual(res.dispatch_target, 2)
        self.assertIsNone(res.representative)

    def test_single_related_abstains_needs_two(self):
        res = self._resolve([self._v(RELATED)])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)
        self.assertEqual(res.dispatch_target, 2)

    def test_two_revert_revert_target_2(self):
        res = self._resolve([self._v(REVERT), self._v(REVERT)])
        self.assertEqual(res.decision, AdvisorDecision.REVERT)
        self.assertEqual(res.dispatch_target, 2)
        self.assertIsNotNone(res.representative)
        self.assertEqual(res.representative.verdict, REVERT)
        self.assertIsNone(res.block_reason)

    def test_two_related_revert_target_2(self):
        res = self._resolve([self._v(RELATED), self._v(RELATED)])
        self.assertEqual(res.decision, AdvisorDecision.REVERT)
        self.assertEqual(res.dispatch_target, 2)

    def test_revert_plus_related_is_one_class_revert(self):
        # REVERT and RELATED collapse into the "revertish" class → agreement,
        # so target stays 2 while the 2-of-N revert gate fires.
        res = self._resolve([self._v(REVERT), self._v(RELATED)])
        self.assertEqual(res.decision, AdvisorDecision.REVERT)
        self.assertEqual(res.dispatch_target, 2)

    def test_two_unsure_abstain_target_2(self):
        res = self._resolve([self._v(UNSURE), self._v(UNSURE)])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)
        self.assertEqual(res.dispatch_target, 2)

    def test_three_revert_same_class_target_2(self):
        # 3 votes but all one class → no disagreement → target stays 2.
        res = self._resolve([self._v(REVERT), self._v(REVERT), self._v(REVERT)])
        self.assertEqual(res.decision, AdvisorDecision.REVERT)
        self.assertEqual(res.dispatch_target, 2)

    # ---- single-vote vetoes (asymmetric) ----

    def test_not_related_veto_blocks(self):
        res = self._resolve([self._v(NOT_RELATED)])
        self.assertEqual(res.decision, AdvisorDecision.BLOCK)
        self.assertEqual(res.block_reason, IneligibleReason.ADVISOR_NOT_RELATED)
        self.assertEqual(res.dispatch_target, 2)
        self.assertEqual(res.representative.verdict, NOT_RELATED)

    def test_infra_issue_veto_blocks(self):
        res = self._resolve([self._v(INFRA)])
        self.assertEqual(res.decision, AdvisorDecision.BLOCK)
        self.assertEqual(res.block_reason, IneligibleReason.ADVISOR_INFRA_ISSUE)
        self.assertEqual(res.dispatch_target, 2)

    def test_garbage_within_2h_veto_blocks(self):
        res = self._resolve([self._v(GARBAGE, mins_ago=60)])
        self.assertEqual(res.decision, AdvisorDecision.BLOCK)
        self.assertEqual(res.block_reason, IneligibleReason.ADVISOR_GARBAGE)
        self.assertEqual(res.dispatch_target, 2)

    def test_garbage_just_under_2h_blocks(self):
        res = self._resolve([self._v(GARBAGE, mins_ago=119)])
        self.assertEqual(res.decision, AdvisorDecision.BLOCK)
        self.assertEqual(res.block_reason, IneligibleReason.ADVISOR_GARBAGE)

    def test_garbage_over_2h_is_not_veto(self):
        res = self._resolve([self._v(GARBAGE, mins_ago=180)])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)
        self.assertEqual(res.dispatch_target, 2)
        self.assertIsNone(res.block_reason)

    def test_garbage_exactly_2h_is_not_veto(self):
        # Boundary: age == 2h is NOT strictly < 2h → no veto.
        res = self._resolve([self._v(GARBAGE, mins_ago=120)])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)

    # ---- confidence gating ----

    def test_low_confidence_revert_pair_abstains(self):
        res = self._resolve([self._v(REVERT, 0.5), self._v(REVERT, 0.5)])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)
        self.assertEqual(res.dispatch_target, 2)

    def test_low_confidence_veto_ignored(self):
        res = self._resolve([self._v(NOT_RELATED, 0.5)])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)
        self.assertEqual(res.dispatch_target, 2)

    def test_mixed_confidence_revert_needs_two_confident(self):
        # Only one confident revert → not enough for the 2-of-N gate.
        res = self._resolve([self._v(REVERT, 0.95), self._v(REVERT, 0.5)])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)
        self.assertEqual(res.dispatch_target, 2)

    def test_threshold_boundary_inclusive(self):
        # Exactly at threshold counts as confident.
        res = self._resolve([self._v(REVERT, THRESHOLD), self._v(REVERT, THRESHOLD)])
        self.assertEqual(res.decision, AdvisorDecision.REVERT)

    def test_just_below_threshold_abstains(self):
        res = self._resolve(
            [self._v(REVERT, THRESHOLD - 0.01), self._v(REVERT, THRESHOLD - 0.01)]
        )
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)

    # ---- disagreement widens dispatch_target to 3 ----

    def test_revert_plus_unsure_abstain_target_3(self):
        res = self._resolve([self._v(REVERT), self._v(UNSURE)])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)
        self.assertEqual(res.dispatch_target, 3)

    def test_not_related_plus_revert_block_target_3(self):
        res = self._resolve([self._v(NOT_RELATED), self._v(REVERT)])
        self.assertEqual(res.decision, AdvisorDecision.BLOCK)
        self.assertEqual(res.block_reason, IneligibleReason.ADVISOR_NOT_RELATED)
        self.assertEqual(res.dispatch_target, 3)

    def test_infra_plus_unsure_block_target_3(self):
        res = self._resolve([self._v(INFRA), self._v(UNSURE)])
        self.assertEqual(res.decision, AdvisorDecision.BLOCK)
        self.assertEqual(res.block_reason, IneligibleReason.ADVISOR_INFRA_ISSUE)
        self.assertEqual(res.dispatch_target, 3)

    def test_dispatch_target_is_confidence_independent(self):
        # Two low-confidence votes across two classes → still target 3, even
        # though neither vote is confident enough to decide anything.
        res = self._resolve([self._v(REVERT, 0.5), self._v(NOT_RELATED, 0.5)])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)
        self.assertEqual(res.dispatch_target, 3)

    # ---- asymmetric veto beats a revert quorum ----

    def test_veto_beats_two_revert(self):
        res = self._resolve([self._v(REVERT), self._v(REVERT), self._v(NOT_RELATED)])
        self.assertEqual(res.decision, AdvisorDecision.BLOCK)
        self.assertEqual(res.block_reason, IneligibleReason.ADVISOR_NOT_RELATED)
        self.assertEqual(res.dispatch_target, 3)

    # ---- veto priority: not_related > infra_issue > garbage ----

    def test_veto_priority_not_related_first(self):
        res = self._resolve(
            [self._v(GARBAGE, mins_ago=10), self._v(INFRA), self._v(NOT_RELATED)]
        )
        self.assertEqual(res.block_reason, IneligibleReason.ADVISOR_NOT_RELATED)

    def test_veto_priority_infra_before_garbage(self):
        res = self._resolve([self._v(GARBAGE, mins_ago=10), self._v(INFRA)])
        self.assertEqual(res.block_reason, IneligibleReason.ADVISOR_INFRA_ISSUE)

    # ---- representative selection ----

    def test_representative_highest_confidence(self):
        low = self._v(NOT_RELATED, 0.90)
        high = self._v(NOT_RELATED, 0.99)
        res = self._resolve([low, high])
        self.assertIs(res.representative, high)

    def test_representative_tie_break_latest_timestamp(self):
        older = self._v(NOT_RELATED, 0.95, mins_ago=100)
        newer = self._v(NOT_RELATED, 0.95, mins_ago=1)
        res = self._resolve([older, newer])
        self.assertIs(res.representative, newer)

    def test_revert_representative_highest_confidence(self):
        lo = self._v(REVERT, 0.90)
        hi = self._v(RELATED, 0.98)
        res = self._resolve([lo, hi])
        self.assertEqual(res.decision, AdvisorDecision.REVERT)
        self.assertIs(res.representative, hi)

    # ---- robustness with more than 3 votes (accidental over-dispatch) ----

    def test_many_votes_revert_no_veto(self):
        votes = [
            self._v(REVERT, 0.95),
            self._v(REVERT, 0.95),
            self._v(UNSURE, 0.95),
            self._v(NOT_RELATED, 0.5),  # low-conf veto is ignored
            self._v(GARBAGE, 0.5, mins_ago=10),
        ]
        res = self._resolve(votes)
        self.assertEqual(res.decision, AdvisorDecision.REVERT)
        self.assertEqual(res.dispatch_target, 3)

    def test_many_votes_confident_veto_wins(self):
        votes = [
            self._v(REVERT, 0.95),
            self._v(REVERT, 0.95),
            self._v(RELATED, 0.95),
            self._v(INFRA, 0.95),  # confident veto short-circuits
            self._v(UNSURE, 0.95),
        ]
        res = self._resolve(votes)
        self.assertEqual(res.decision, AdvisorDecision.BLOCK)
        self.assertEqual(res.block_reason, IneligibleReason.ADVISOR_INFRA_ISSUE)
        self.assertEqual(res.dispatch_target, 3)

    def test_seven_unsure_votes_abstain_target_2(self):
        # Many votes, all one non-revertish class → agreement, target 2.
        res = self._resolve([self._v(UNSURE) for _ in range(7)])
        self.assertEqual(res.decision, AdvisorDecision.ABSTAIN)
        self.assertEqual(res.dispatch_target, 2)

    # ---- naive timestamps are treated as UTC (no crash on mixed awareness) ----

    def test_naive_timestamps_supported(self):
        naive = AIAdvisorResult(
            verdict=GARBAGE,
            confidence=0.95,
            timestamp=datetime(2026, 8, 4, 11, 30, 0),  # naive, 30min before now
            signal_key="k",
        )
        res = resolve_advisor_quorum([naive], self.now)
        self.assertEqual(res.decision, AdvisorDecision.BLOCK)
        self.assertEqual(res.block_reason, IneligibleReason.ADVISOR_GARBAGE)


if __name__ == "__main__":
    unittest.main()
