from __future__ import annotations

import hashlib
import logging

import pytest

from greenlight.candidate_filter import _ROLLOUT_BUCKETS, _in_rollout, rollout_filter

_REPO = "pytorch/pytorch"
_OTHER_REPO = "pytorch/test-infra"

# Two PR numbers whose buckets straddle the midpoint of the dial, pinned so a change to the key
# format or the digest shows up here rather than as a silently reshuffled holdout group.
_IN_AT_HALF = 12
_IN_AT_HALF_BUCKET = 3562
_OUT_AT_HALF = 11
_OUT_AT_HALF_BUCKET = 5102


def _bucket(repo: str, pr_number: int) -> int:
    digest = hashlib.sha256(f"{repo}#{pr_number}".encode()).digest()
    return int.from_bytes(digest[:8], "big") % _ROLLOUT_BUCKETS


def test_bucket_is_a_sha256_of_repo_and_number():
    # Recomputed rather than imported: this pins the key format and the digest, which together are
    # the contract. Change either and every PR is reassigned, resampling the holdout on deploy.
    assert _bucket(_REPO, _IN_AT_HALF) == _IN_AT_HALF_BUCKET
    assert _bucket(_REPO, _OUT_AT_HALF) == _OUT_AT_HALF_BUCKET


def test_assignment_is_stable_across_processes():
    # The pinned buckets above were computed in a different process from the one running this test,
    # and pytest runs under a randomized PYTHONHASHSEED. Matching them is what proves the builtin
    # salted hash() is not in use -- with it, a PR would flap between Lambda invocations.
    assert _in_rollout(_REPO, _IN_AT_HALF, 0.5) is True
    assert _in_rollout(_REPO, _OUT_AT_HALF, 0.5) is False


@pytest.mark.parametrize("rollout", [1.0, 1.0000001, 2.0])
def test_full_rollout_keeps_every_number(rollout):
    assert rollout_filter([1, 2, 3], frozenset(), repo=_REPO, rollout=rollout) == [1, 2, 3]


@pytest.mark.parametrize("rollout", [0.0, -0.0])
def test_empty_rollout_keeps_nothing(rollout):
    assert rollout_filter([1, 2, 3], frozenset(), repo=_REPO, rollout=rollout) == []


def test_exempt_numbers_survive_the_empty_rollout():
    # The exemption is what keeps the dial an experiment-sizing knob: turning the experiment off
    # entirely must still leave the PRs greenlight serves for real untouched.
    assert rollout_filter([1, 2, 3], frozenset({1, 3}), repo=_REPO, rollout=0.0) == [1, 3]


def test_exempt_numbers_survive_a_fractional_rollout():
    kept = rollout_filter([_IN_AT_HALF, _OUT_AT_HALF], frozenset({_OUT_AT_HALF}), repo=_REPO, rollout=0.5)

    assert kept == [_IN_AT_HALF, _OUT_AT_HALF]


def test_fractional_rollout_splits_on_the_bucket_boundary():
    kept = rollout_filter([_IN_AT_HALF, _OUT_AT_HALF], frozenset(), repo=_REPO, rollout=0.5)

    assert kept == [_IN_AT_HALF]


def test_input_order_is_preserved():
    assert rollout_filter([3, 1, 2], frozenset({3, 1, 2}), repo=_REPO, rollout=0.0) == [3, 1, 2]


def test_no_candidates_yields_no_candidates():
    assert rollout_filter([], frozenset(), repo=_REPO, rollout=0.5) == []


def test_raising_the_dial_only_ever_adds_prs():
    # Nesting is what makes this a rollout rather than a resample: dialling up must never drop a PR
    # that was already being evaluated, or its in-flight review would be orphaned mid-flight.
    numbers = list(range(100_000, 120_000))
    previous: set[int] = set()
    for rollout in (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0):
        current = set(rollout_filter(numbers, frozenset(), repo=_REPO, rollout=rollout))
        assert previous <= current, rollout
        previous = current


@pytest.mark.parametrize("rollout", [0.1, 0.25, 0.5, 0.75])
def test_dense_sequential_numbers_land_close_to_the_dial(rollout):
    # PR numbers are dense and sequential, which is exactly the input a bare modulo skews on; the
    # hash is there so the realised fraction tracks the requested one on real-world input.
    numbers = list(range(100_000, 120_000))
    kept = rollout_filter(numbers, frozenset(), repo=_REPO, rollout=rollout)

    assert abs(len(kept) / len(numbers) - rollout) < 0.02


def test_the_partition_is_scoped_per_repo():
    # A second target repo must draw its own partition, or PR #1234 there would inherit whichever
    # side of the dial PR #1234 in pytorch/pytorch happens to sit on.
    numbers = list(range(100_000, 120_000))
    here = set(rollout_filter(numbers, frozenset(), repo=_REPO, rollout=0.5))
    there = set(rollout_filter(numbers, frozenset(), repo=_OTHER_REPO, rollout=0.5))

    assert here != there
    assert 0.4 < len(here & there) / len(here) < 0.6


def test_holdout_is_logged_once_with_the_dial_and_the_counts(caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        rollout_filter([_IN_AT_HALF, _OUT_AT_HALF], frozenset(), repo=_REPO, rollout=0.5)

    assert "rollout 0.5: holding 1 of 2 candidate(s) out of this scan" in caplog.text


def test_nothing_held_out_logs_nothing(caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        rollout_filter([1, 2, 3], frozenset(), repo=_REPO, rollout=1.0)

    assert "holding" not in caplog.text
