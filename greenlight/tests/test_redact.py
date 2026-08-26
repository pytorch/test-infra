import time

import pytest

from greenlight import redact


def test_scrubs_github_ghp_token():
    out = redact.scrub_secrets("leak ghp_0123456789abcdefghijABCDEFGHIJ0123456789 here")

    assert out == "leak [REDACTED] here"


@pytest.mark.parametrize("prefix", ["ghp", "gho", "ghu", "ghs", "ghr"])
def test_scrubs_every_github_token_prefix(prefix):
    token = f"{prefix}_" + "A" * 40

    out = redact.scrub_secrets(f"x {token} y")

    assert out == "x [REDACTED] y"
    assert token not in out


def test_scrubs_github_fine_grained_pat():
    token = "github_pat_" + "A" * 70

    out = redact.scrub_secrets(f"tok {token} end")

    assert out == "tok [REDACTED] end"
    assert token not in out


def test_scrubs_x_access_token_value_keeping_label():
    token = "ghs_abcdefghijklmnopqrstuvwxyz0123456789AB"

    out = redact.scrub_secrets(f"https://x-access-token:{token}@github.com/o/r.git")

    assert out == "https://x-access-token:[REDACTED]@github.com/o/r.git"
    assert token not in out


def test_scrubs_x_access_token_case_insensitive_label():
    out = redact.scrub_secrets("X-Access-Token:abcdefghijklmnop rest")

    assert out == "X-Access-Token:[REDACTED] rest"


def test_scrubs_authorization_bearer_token_keeping_scheme():
    out = redact.scrub_secrets("Authorization: Bearer abcdef1234567890XYZtoken")

    assert out == "Authorization: Bearer [REDACTED]"


def test_scrubs_bare_bearer_token():
    out = redact.scrub_secrets("use Bearer sometoken12345 now")

    assert out == "use Bearer [REDACTED] now"


@pytest.mark.parametrize("prefix", ["AKIA", "ASIA", "AGPA", "AIDA", "AROA", "ANPA", "ANVA", "AIPA"])
def test_scrubs_aws_access_key_ids(prefix):
    key = prefix + "IOSFODNN7EXAMPLE"  # prefix + 16 uppercase alnum

    out = redact.scrub_secrets(f"key {key} here")

    assert out == "key [REDACTED] here"
    assert key not in out


@pytest.mark.parametrize("sep", [" = ", ": ", "=", ":"])
def test_scrubs_aws_secret_access_key_when_context_anchored(sep):
    value = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"  # canonical 40-char AWS example secret

    out = redact.scrub_secrets(f"aws_secret_access_key{sep}{value}")

    assert value not in out
    assert "[REDACTED]" in out
    assert out.startswith("aws_secret_access_key")


@pytest.mark.parametrize("label", ["AWS_SESSION_TOKEN=", "aws_session_token = ", 'aws_session_token: "'])
def test_scrubs_aws_session_token_labeled_keeping_label(label):
    # A base64 value with no bare STS prefix, so only the labeled route can catch it. The session
    # token is the strongest OIDC credential in the review job's environment.
    value = "Zm9vYmFyYmF6" + "A" * 60

    out = redact.scrub_secrets(f"{label}{value}")

    assert value not in out
    assert "[REDACTED]" in out
    assert out.lower().startswith("aws_session_token")


@pytest.mark.parametrize("prefix", ["IQoJ", "FwoG", "FQoG"])
def test_scrubs_bare_aws_sts_session_token_by_prefix(prefix):
    blob = prefix + "b3JpZ2luX2VjEND" + "A" * 110  # >= 100 base64 chars after the distinctive prefix

    out = redact.scrub_secrets(f"env {blob} end")

    assert out == "env [REDACTED] end"
    assert blob not in out


def test_short_sts_prefixed_string_is_preserved():
    # The bare STS route requires >=100 chars to avoid false positives; a short IQoJ-prefixed run
    # with no label must pass through untouched.
    short = "IQoJ" + "A" * 50

    assert redact.scrub_secrets(f"x {short} y") == f"x {short} y"


def test_scrubs_pem_private_key_block():
    text = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBg\nabcd/efgh\n-----END RSA PRIVATE KEY-----\nafter"

    out = redact.scrub_secrets(text)

    assert out == "before\n[REDACTED]\nafter"
    assert "PRIVATE KEY" not in out


@pytest.mark.parametrize("prefix", ["xoxb", "xoxa", "xoxp", "xoxr", "xoxs"])
def test_scrubs_slack_tokens(prefix):
    token = f"{prefix}-123456789012-abcdefghijklmno"

    out = redact.scrub_secrets(f"tok {token} done")

    assert out == "tok [REDACTED] done"
    assert token not in out


def test_scrubs_jwt():
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"

    out = redact.scrub_secrets(f"token {jwt} end")

    assert out == "token [REDACTED] end"
    assert jwt not in out


def test_message_that_is_entirely_a_secret_collapses_to_redacted():
    # verdict._validate_message requires a non-empty message; a wholly-secret message must survive
    # scrubbing as the non-empty sentinel rather than becoming "".
    out = redact.scrub_secrets("ghp_0123456789abcdefghijABCDEFGHIJ0123456789")

    assert out == "[REDACTED]"


def test_scrubs_multiple_distinct_secrets_in_one_message():
    out = redact.scrub_secrets("ghp_0123456789abcdefghijABCDEFGHIJ0123456789 and key AKIAIOSFODNN7EXAMPLE done")

    assert out == "[REDACTED] and key [REDACTED] done"


def test_bearer_jwt_is_redacted_whole_without_leaking_a_tail():
    # A long JWT under a Bearer scheme must be redacted as one unit; the bounded value-cut must not
    # leave a base64 tail behind.
    jwt = "eyJhbGciOiJIUzI1NiJ9." + "eyJ" + "a" * 600 + "." + "b" * 600

    out = redact.scrub_secrets(f"Authorization: Bearer {jwt}")

    assert out == "Authorization: Bearer [REDACTED]"
    assert "aaaa" not in out
    assert "bbbb" not in out


def test_bearer_value_longer_than_4096_is_fully_redacted_without_tail():
    # The label-value repetition is unbounded on purpose: an upper bound would leave the tail of an
    # over-long token in the clear.
    value = "a" * 5000

    out = redact.scrub_secrets(f"Authorization: Bearer {value}")

    assert out == "Authorization: Bearer [REDACTED]"
    assert "aaaa" not in out


def test_jwt_segment_longer_than_4096_is_fully_redacted_without_tail():
    jwt = "eyJ" + "a" * 5000 + ".eyJ" + "b" * 5000 + "." + "c" * 5000

    out = redact.scrub_secrets(f"tok {jwt} end")

    assert out == "tok [REDACTED] end"
    assert "aaaa" not in out
    assert "bbbb" not in out
    assert "cccc" not in out


@pytest.mark.parametrize(
    "benign",
    [
        "This change looks good and adds a new helper function.",
        "src/greenlight/verdict.py and tests/test_verdict.py",
        "commit abc1234 fixes it",  # 7-char short SHA
        "commit " + "a1b2c3d4e5" * 4 + " landed",  # 40-char hex SHA
        "@pytorchbot please split this PR",  # @-mentions are defang's job, not scrub's
        "see https://github.com/pytorch/pytorch/pull/123 for details",
        "Bearer of bad news arrived early",  # "Bearer" as prose, no token follows
        # The unterminated-key-block sweep needs a key-shaped body, so a marker named in prose --
        # even broken across short lines -- has nothing for it to latch onto.
        "the diff adds a -----BEGIN RSA PRIVATE KEY----- literal to the fixture",
        "look at -----BEGIN RSA PRIVATE KEY-----\nand then some prose",
        "look at -----BEGIN RSA PRIVATE KEY-----",  # marker at end of text, the \\Z the sweep anchors on
        "-----BEGIN RSA PRIVATE KEY-----\n\n\nthis is only prose about it\n",
        "-----BEGIN RSA PRIVATE KEY-----\nis\nonly\na\nliteral\nin\nthe\ntest\nfixture\nnothing\nmore\n",
        "-----BEGIN RSA PRIVATE KEY-----\n    this is indented prose\n    and a second indented line\n",
    ],
)
def test_benign_text_is_preserved(benign):
    assert redact.scrub_secrets(benign) == benign


def test_bare_forty_char_base64_without_label_is_preserved():
    # Context-anchoring guarantee: a 40-char base64 run is redacted only next to its label, so an
    # unlabeled one (which collides with hashes/ids) passes through untouched.
    bare = "value wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY alone"

    assert redact.scrub_secrets(bare) == bare


def test_empty_string_is_unchanged():
    assert redact.scrub_secrets("") == ""


@pytest.mark.parametrize(
    "payload",
    [
        "a" * 100_000,
        "eyJ" + "a" * 100_000,
        "Bearer " + "a" * 100_000,
        "-----BEGIN RSA PRIVATE KEY-----" + "a" * 100_000,
        "x-access-token:" + "a" * 100_000,
        "IQoJ" + "a" * 100_000,
        "aws_session_token=" + "a" * 100_000,
    ],
)
def test_redos_safety_large_pathological_input_returns_quickly(payload):
    start = time.monotonic()
    redact.scrub_secrets(payload)
    elapsed = time.monotonic() - start

    assert elapsed < 1.0


def test_benign_large_input_under_cap_is_unchanged():
    payload = "a" * 10_000

    assert redact.scrub_secrets(payload) == payload
