import pytest

from greenlight import constants


def test_status_string_values():
    assert constants.STATUS_LAND == "LAND"
    assert constants.STATUS_NO_LAND == "NO_LAND"
    assert constants.STATUS_CANCELLED == "CANCELLED"
    assert constants.STATUS_FAILED == "FAILED"
    assert constants.STATUS_AI_REVIEW_STARTED == "AI_REVIEW_STARTED"
    assert constants.STATUS_AI_REVIEW_DISPATCHED == "AI_REVIEW_DISPATCHED"


def test_verdict_statuses_excludes_scan_only_dispatched():
    # VERDICT_STATUSES is the emittable set the verdict CLI validates against; the scan-only
    # AI_REVIEW_DISPATCHED must not appear here (it would post a misleading "did not complete").
    assert sorted(constants.VERDICT_STATUSES) == [
        "AI_REVIEW_STARTED",
        "CANCELLED",
        "FAILED",
        "LAND",
        "NO_LAND",
    ]
    assert constants.STATUS_AI_REVIEW_DISPATCHED not in constants.VERDICT_STATUSES


def test_scan_only_statuses_is_dispatched_and_stays_in_flight_for_decide():
    assert sorted(constants.SCAN_ONLY_STATUSES) == ["AI_REVIEW_DISPATCHED"]
    # decide() must still treat a queued dispatch as in-flight, so it stays in IN_FLIGHT_STATUSES.
    assert constants.SCAN_ONLY_STATUSES <= constants.IN_FLIGHT_STATUSES
    assert constants.STATUS_AI_REVIEW_DISPATCHED in constants.IN_FLIGHT_STATUSES


def test_scanner_groupings_membership():
    assert sorted(constants.TERMINAL_STATUSES) == ["LAND", "NO_LAND"]
    assert sorted(constants.IN_FLIGHT_STATUSES) == ["AI_REVIEW_DISPATCHED", "AI_REVIEW_STARTED"]
    assert sorted(constants.RETRY_STATUSES) == ["CANCELLED", "FAILED"]


def test_scanner_groupings_partition_verdict_statuses():
    # The three decide() groupings are pairwise disjoint; minus the scan-only status they are
    # exactly the emittable verdict statuses.
    union = constants.TERMINAL_STATUSES | constants.IN_FLIGHT_STATUSES | constants.RETRY_STATUSES
    total = len(constants.TERMINAL_STATUSES) + len(constants.IN_FLIGHT_STATUSES) + len(constants.RETRY_STATUSES)
    assert total == len(union)
    assert union - constants.SCAN_ONLY_STATUSES == constants.VERDICT_STATUSES


def test_s3_key_prefix_value():
    assert constants.S3_KEY_PREFIX == "greenlight_pr_state"


def test_s3_bucket_value():
    assert constants.S3_BUCKET == "gha-artifacts"


def test_eval_hash_re_matches_64_lowercase_hex():
    assert constants.EVAL_HASH_RE.fullmatch("0123456789abcdef" * 4)


@pytest.mark.parametrize("bad", ["", "abc", "A" * 64, "g" * 64, "a" * 63, "a" * 65])
def test_eval_hash_re_rejects_non_hash(bad):
    assert constants.EVAL_HASH_RE.fullmatch(bad) is None


def test_head_sha_re_matches_40_hex_either_case():
    assert constants.HEAD_SHA_RE.fullmatch("aB" * 20)


@pytest.mark.parametrize("bad", ["", "abc", "g" * 40, "a" * 39, "a" * 41])
def test_head_sha_re_rejects_non_sha(bad):
    assert constants.HEAD_SHA_RE.fullmatch(bad) is None


def test_validate_eval_hash_accepts_64_lowercase_hex():
    constants.validate_eval_hash("0123456789abcdef" * 4)


@pytest.mark.parametrize("bad", ["", "abc", "A" * 64, "g" * 64, "a" * 63, "a" * 65])
def test_validate_eval_hash_rejects(bad):
    with pytest.raises(ValueError, match="eval_hash must be 64 lowercase hex characters"):
        constants.validate_eval_hash(bad)


def test_validate_eval_hash_message_includes_value_repr():
    with pytest.raises(ValueError, match=r"got 'nope'"):
        constants.validate_eval_hash("nope")


def test_validate_head_sha_accepts_40_hex_either_case():
    constants.validate_head_sha("aB" * 20)


@pytest.mark.parametrize("bad", ["", "abc", "g" * 40, "a" * 39, "a" * 41, "refs/heads/main"])
def test_validate_head_sha_rejects(bad):
    with pytest.raises(ValueError, match="head_sha must be a 40-character hex commit sha"):
        constants.validate_head_sha(bad)


def test_validate_head_sha_message_includes_value_repr():
    with pytest.raises(ValueError, match=r"got 'nope'"):
        constants.validate_head_sha("nope")


def test_dispatch_constants_values():
    assert constants.DISPATCH_REPO == "pytorch/test-infra"
    assert constants.WORKFLOW_FILE == "greenlight-pr-review.yml"
    assert constants.DEFAULT_DISPATCH_REF == "main"
    assert constants.DEFAULT_TIMEOUT_MINUTES == 45


def test_merge_rules_constants_values():
    assert constants.TARGET_REPO == "pytorch/pytorch"
    assert constants.MERGE_RULES_PATH == ".github/merge_rules.yaml"
