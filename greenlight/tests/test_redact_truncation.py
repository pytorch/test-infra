import time

import pytest

from greenlight import redact

# Redacting a run the cap severed swaps it for the marker, which is longer than a one-character
# severed head, so the result can sit a marker-width over the cap.
_CAPPED_LEN = redact._MAX_SCRUB_INPUT + len(redact._REDACTED)

_BEGIN = "-----BEGIN RSA PRIVATE KEY-----"

# A JWT severed before its second dot: the pattern needs three segments, so this head is
# unmatchable at any length, unlike the length-gated shapes.
_JWT_HEAD = "eyJhbGciOiJIUzI1NiJ9.eyJ"


def test_input_longer_than_cap_is_truncated():
    out = redact.scrub_secrets("a " * 100_000)

    assert len(out) <= redact._MAX_SCRUB_INPUT
    assert out.startswith("a a a ")


def test_cap_truncates_the_returned_string_not_only_the_scan_window():
    # The stored row is the return value, so the cap must drop text rather than let it past
    # unscanned: a secret beyond the cap must be absent, not merely unmatched.
    token = "ghp_" + "B" * 40
    out = redact.scrub_secrets("word " * 10_000 + token)

    assert token not in out
    assert len(out) <= _CAPPED_LEN


@pytest.mark.parametrize(
    "secret",
    [
        "ghp_0123456789abcdefghijABCDEFGHIJ0123456789",
        "github_pat_" + "A" * 70,
        "https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123456789AB@github.com/o/r.git",
        "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "aws_session_token=Zm9vYmFyYmF6" + "A" * 60,
        "IQoJb3JpZ2luX2VjEND" + "A" * 110,
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ],
)
@pytest.mark.parametrize("overlap", [1, 8, 20])
def test_secret_severed_by_the_cap_leaves_no_fragment(secret, overlap):
    # A credential straddling the cap loses its tail, and what remains cannot be relied on to still
    # match. Retreating to the whitespace before it redacts the run whole instead. Filler shares no
    # leading character with any secret below, so a surviving one-char head of the severed run is
    # distinguishable from the filler itself.
    filler = "Z" * (redact._MAX_SCRUB_INPUT - overlap - 1)

    out = redact.scrub_secrets(f"{filler} {secret} trailing prose")

    assert len(out) <= _CAPPED_LEN
    assert "trailing prose" not in out
    for fragment in (secret[:overlap], secret[: overlap + 1]):
        assert fragment not in out
    assert out.endswith(redact._REDACTED)


@pytest.mark.parametrize(
    "body",
    [
        pytest.param("MIIEvQIBADANBgkqhkiG9w0\n" * 2000, id="wrapped-body"),
        pytest.param("A" * 20 + "\n" + "B" * 30_000, id="surviving-body-too-short-to-look-like-a-key"),
        pytest.param("A" * 30 + "\n" + "B" * 30_000, id="one-surviving-body-line"),
    ],
)
def test_pem_block_severed_by_the_cap_leaks_no_key_material(body):
    # A PEM block spans newlines, so the tail-run cut leaves its earlier body lines behind; the
    # BEGIN marker left without its END must take the rest of the text with it. Having cut is the
    # evidence, so this holds even where what survives is too short to look like a key.
    out = redact.scrub_secrets(f"intro\n{_BEGIN}\n{body}-----END RSA PRIVATE KEY-----")

    assert out == "intro\n[REDACTED]"
    assert "PRIVATE KEY" not in out
    assert "MIIE" not in out
    assert "AAAA" not in out


@pytest.mark.parametrize("overlap", [1, 8, 20])
def test_whitespace_free_message_is_trimmed_not_erased(overlap):
    # The row validates as non-empty, so erasing the message would put a LAND verdict on the PR
    # with the marker as its entire justification. The run is kept; the credential tail still goes.
    token = "ghp_" + "B" * 40

    out = redact.scrub_secrets("Q" * (redact._MAX_SCRUB_INPUT - overlap) + token)

    assert out != redact._REDACTED
    assert out.count("Q") >= redact._MAX_SCRUB_INPUT - overlap - 1
    assert "BBBB" not in out
    assert out.endswith(redact._REDACTED)


@pytest.mark.parametrize(
    "opener",
    ["IQoJ", "ghp_", "github_pat_", "xoxb-", "AKIA", "x-access-token:", "aws_secret_access_key=", _JWT_HEAD],
)
@pytest.mark.parametrize("runlen", [40, 104, 512, 513, 552, 615, 616, 1_200, 6_000])
def test_severed_credential_in_a_long_run_leaves_no_head(opener, runlen):
    # A retreat that gives up after a fixed budget cuts mid-run and strands whatever head is left.
    # No budget fixes it: the JWT gates on structure, not length, so its head stays unmatchable
    # however much survives. Only a whitespace boundary, or the opener itself, is a safe cut point.
    lead = "review looks fine "
    filler = "Z" * (redact._MAX_SCRUB_INPUT - runlen - len(lead) - 1)

    out = redact.scrub_secrets(f"{lead}{filler} {opener}" + "S" * 8_000)

    assert opener not in out
    assert out.startswith(lead)
    assert out.endswith(redact._REDACTED)


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param("A" * 25_000, id="single-char-run"),
        pytest.param(("|" + "-" * 60 + "|") * 400, id="markdown-table"),
        pytest.param("Z" * 19_000 + "ghp_" + "B" * 4_000, id="blob-then-credential"),
    ],
)
def test_message_without_any_whitespace_is_kept_not_erased(payload):
    # There is no whitespace to retreat to, and erasing the run outright is what destroyed the
    # justification. What survives is the run minus any credential-shaped tail.
    out = redact.scrub_secrets(payload)

    assert out != redact._REDACTED
    assert len(out) > redact._MAX_SCRUB_INPUT // 2
    assert "ghp_" not in out


@pytest.mark.parametrize("payload", ["IQoJ" + "S" * 25_000, _JWT_HEAD + "p" * 25_000])
def test_message_that_is_one_unbroken_credential_still_collapses(payload):
    # The counterweight to keeping the run: when the run is the credential, keeping it would leak
    # the whole thing, so it collapses to the marker exactly as a wholly-secret message should.
    assert redact.scrub_secrets(payload) == redact._REDACTED


def test_cut_landing_on_whitespace_keeps_the_last_complete_word():
    # Precision guard: only a run the cut actually severs is redacted, so a cap falling on a word
    # boundary must not eat the preceding word.
    out = redact.scrub_secrets("d " * (redact._MAX_SCRUB_INPUT // 2) + "word")

    assert out == "d " * (redact._MAX_SCRUB_INPUT // 2)
    assert "[REDACTED]" not in out


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(_BEGIN + "\n" + "A" * 19_000, id="body-below-the-cap"),
        pytest.param(f"{_BEGIN}\nMIIEvQ\n-----END RSA PRIVATE KEY-----\n{_BEGIN}\n" + "A" * 5_000, id="second-block"),
        pytest.param(_BEGIN + "\n" + "A" * (redact._MAX_SCRUB_INPUT - len(_BEGIN) - 1), id="exactly-at-the-cap"),
        pytest.param(_BEGIN + "\r\n" + "MIIEvQIBADANBgkqhkiG9w0\r\n" * 300, id="crlf-wrapped-body"),
        pytest.param("key: |\n  " + _BEGIN + "\n" + "  MIIEvQIBADANBgkqhkiG9w0\n" * 300, id="indented-body"),
        pytest.param("-----BEGIN OPENSSH PRIVATE KEY-----\n" + "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n" * 8, id="openssh"),
        pytest.param(_BEGIN + "\n" + "A" * 3_000 + "\n\nthat was the key from the log", id="prose-after-the-body"),
    ],
)
def test_unterminated_key_block_is_swept_below_the_cap(payload):
    # A BEGIN marker whose END never arrives leaves its body running off the end of the text. The
    # cap is not what severs it -- the model's own output limit can -- so the sweep cannot be
    # conditioned on truncation having happened.
    assert len(payload) <= redact._MAX_SCRUB_INPUT

    out = redact.scrub_secrets(payload)

    assert "PRIVATE KEY" not in out
    assert out.endswith(redact._REDACTED)
    for fragment in ("AAAA", "MIIEvQ", "b3BlbnNz"):
        assert fragment not in out


@pytest.mark.parametrize(
    "payload",
    [
        "-----BEGIN " + "A" * 100_000,
        ("-----BEGIN " + "A" * 100) * 2_000,
        ("-----BEGIN PRIVATE KEY----- " * 5_000),
        _BEGIN + "\n" + ("A" * 15 + "\n") * 5_000,
        _BEGIN + "\n" + ("A" * 39 + " ") * 3_000,
        _BEGIN + "\n" + ("A" * 39 + "\nb c\n") * 3_000,
    ],
)
def test_unterminated_key_block_sweep_completes_fast(payload):
    start = time.monotonic()
    redact.scrub_secrets(payload)
    elapsed = time.monotonic() - start

    assert elapsed < 1.0


def test_pem_begin_storm_completes_fast():
    # Repeated BEGIN markers with no END drive the lazy PEM scan into O(n^2); the input cap keeps a
    # 200KB storm fast instead of multi-second.
    payload = "-----BEGIN X PRIVATE KEY-----" * 7000  # ~200KB, no END marker

    start = time.monotonic()
    redact.scrub_secrets(payload)
    elapsed = time.monotonic() - start

    assert elapsed < 1.0
