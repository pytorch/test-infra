from greenlight import comment_format, github_client


def test_defang_neutralizes_at_mentions_and_wraps_in_fence():
    out = comment_format.defang("ping @pytorchbot now")

    assert "@pytorchbot" not in out
    assert "pytorchbot" in out
    assert comment_format._ZERO_WIDTH_SPACE in out
    assert out.startswith("```")
    assert out.endswith("```")


def test_defang_caps_length():
    out = comment_format.defang("x" * 5000)

    assert out.count("x") == 4000


def test_defang_uses_longer_fence_than_backtick_run():
    out = comment_format.defang("before ``` after")

    assert out.split("\n", 1)[0] == "`" * 4
    assert "before ``` after" in out


def test_verdict_body_land_has_marker_run_stamp_headline_reason_and_job_link():
    body = comment_format.verdict_body("LAND", "clean", "looks good", "https://job", 55)

    assert body.startswith(comment_format.COMMENT_MARKER)
    assert github_client.format_run_marker(55) in body
    assert f"**{comment_format.LAND_HEADLINE}**" in body
    assert "<details>" in body
    assert "<summary>Why</summary>" in body
    assert "looks good" in body
    assert "reason: `clean`" in body
    assert "[Inference job](https://job)" in body
    assert body.endswith("</details>")


def test_verdict_body_no_land_headline_and_defangs_message():
    body = comment_format.verdict_body("NO_LAND", "scope_too_large", "ping @pytorchbot", "https://job", None)

    assert f"**{comment_format.NO_LAND_HEADLINE}**" in body
    assert "@pytorchbot" not in body
    assert "pytorchbot" in body
    assert comment_format._ZERO_WIDTH_SPACE in body
    assert "```" in body


def test_verdict_body_omits_job_link_and_run_stamp_when_absent():
    body = comment_format.verdict_body("NO_LAND", "unclear_intent", "hi", "", None)

    assert "[Inference job]" not in body
    assert "https" not in body
    assert "greenlight-run" not in body
    assert "reason: `unclear_intent`" in body
    assert body.endswith("</details>")


def test_reviewing_body_structure():
    body = comment_format.reviewing_body("https://run", 3)

    assert body.startswith(comment_format.COMMENT_MARKER)
    assert github_client.format_run_marker(3) in body
    assert f"**{comment_format.REVIEWING_HEADLINE}**" in body
    assert "<summary>Details</summary>" in body
    assert "Green Light is reviewing this PR." in body
    assert "[Inference job](https://run)" in body
    assert body.endswith("</details>")


def test_incomplete_body_omits_job_link_and_run_stamp_when_absent():
    body = comment_format.incomplete_body("failed", "", None)

    assert f"**{comment_format.INCOMPLETE_HEADLINE}**" in body
    assert "reason: `failed`" in body
    assert "[Inference job]" not in body
    assert "greenlight-run" not in body


def test_marker_body_reviewing_for_ai_review_started():
    body = comment_format.marker_body("AI_REVIEW_STARTED", "https://run", 4)

    assert f"**{comment_format.REVIEWING_HEADLINE}**" in body
    assert github_client.format_run_marker(4) in body
    assert "[Inference job](https://run)" in body


def test_marker_body_incomplete_uses_lowercased_status_as_reason():
    body = comment_format.marker_body("CANCELLED", "", None)

    assert f"**{comment_format.INCOMPLETE_HEADLINE}**" in body
    assert "reason: `cancelled`" in body


def test_recheck_changes_requested_body_has_marker_headline_and_detail():
    body = comment_format.recheck_changes_requested_body("changes requested by octocat")

    assert body.startswith(comment_format.RECHECK_REFUSAL_MARKER)
    assert f"**{comment_format.RECHECK_REFUSAL_HEADLINE}**" in body
    assert "changes requested by octocat" in body
    # A refusal is not tied to a review run, so it carries no job link or run stamp.
    assert "[Inference job]" not in body
    assert "greenlight-run" not in body
    # A CHANGES_REQUESTED review persists across pushes until the reviewer dismisses/resolves it,
    # so the body must not claim the next push resumes review automatically.
    assert "not on the next push" in body
    assert "reviewed automatically" not in body


def test_recheck_refusal_marker_is_distinct_from_verdict_marker():
    # A refusal must live in its own comment, never overwriting a LAND/NO_LAND verdict comment.
    assert comment_format.RECHECK_REFUSAL_MARKER != comment_format.COMMENT_MARKER
    body = comment_format.recheck_changes_requested_body("changes requested by octocat")
    assert comment_format.COMMENT_MARKER not in body
