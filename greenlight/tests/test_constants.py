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


def test_drci_endpoint_value():
    assert constants.DRCI_ENDPOINT == "https://hud.pytorch.org/api/drci/drci"


def test_drci_status_comment_repos_is_only_target_repo():
    # Only pytorch/pytorch delegates its status comment today; every other repo keeps the
    # greenlight-authored comment, so widening this set changes behaviour for real repos.
    assert sorted(constants.DRCI_STATUS_COMMENT_REPOS) == ["pytorch/pytorch"]
    assert constants.TARGET_REPO in constants.DRCI_STATUS_COMMENT_REPOS


def test_drci_status_comment_repos_entries_are_normalized():
    # Lookup folds case, so an entry that is not already folded could never match. This pins
    # the fold to set construction rather than to whoever happens to add the next repo.
    for repo in constants.DRCI_STATUS_COMMENT_REPOS:
        assert repo == constants.normalize_repo(repo)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("pytorch/pytorch", "pytorch/pytorch"),
        ("PyTorch/PyTorch", "pytorch/pytorch"),
        ("  PYTORCH/PyTorch  ", "pytorch/pytorch"),
        ("\tPytorch/Vision\n", "pytorch/vision"),
    ],
)
def test_normalize_repo_folds_case_and_surrounding_space(raw, expected):
    # greenlightRepoKey in torchci/lib/greenlight/greenlightConfig.ts mirrors this exactly;
    # the two gates disagreeing on the key leaves a PR with no status on either surface.
    assert constants.normalize_repo(raw) == expected


def test_normalize_repo_does_not_repair_whitespace_around_the_separator():
    # The whole key is folded, not its halves, so interior space survives and the gate fails
    # closed. Pinned on both sides: repairing it here alone would suppress greenlight's comment
    # on a key the HUD's own gate still misses.
    assert constants.normalize_repo("  pytorch  /  pytorch  ") == "pytorch  /  pytorch"
    assert constants.delegates_status_comment_to_drci("  pytorch  /  pytorch  ") is False


@pytest.mark.parametrize("repo", ["pytorch/pytorch", "PyTorch/PyTorch", "  pytorch/pytorch  "])
def test_delegates_status_comment_to_drci_accepts_target_repo(repo):
    assert constants.delegates_status_comment_to_drci(repo) is True


@pytest.mark.parametrize("repo", ["pytorch/vision", "pytorch/test-infra", "", "pytorch", "pytorch/pytorch-fork"])
def test_delegates_status_comment_to_drci_rejects_other_repos(repo):
    assert constants.delegates_status_comment_to_drci(repo) is False
