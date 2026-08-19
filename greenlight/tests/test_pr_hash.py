import pytest

from greenlight.pr_hash import (
    BOT_COMMAND_MENTIONS,
    BOT_LOGINS,
    HASH_SCHEME_VERSION,
    HumanEvent,
    PRFingerprint,
    compute_pr_hash,
    is_bot,
    is_bot_command,
)


def _fingerprint(
    *,
    head_sha: str = "def456",
    human_events: tuple[HumanEvent, ...] | None = None,
    scheme_version: int = HASH_SCHEME_VERSION,
) -> PRFingerprint:
    events = (
        human_events
        if human_events is not None
        else (
            HumanEvent(id=2, body="lgtm"),
            HumanEvent(id=1, body="hi"),
        )
    )
    return PRFingerprint(head_sha=head_sha, human_events=events, scheme_version=scheme_version)


def test_compute_pr_hash_is_deterministic_for_same_input():
    fp = _fingerprint()

    assert compute_pr_hash(fp) == compute_pr_hash(fp)


def test_compute_pr_hash_ignores_human_events_order():
    fp = _fingerprint()
    reordered = PRFingerprint(
        head_sha=fp.head_sha,
        human_events=tuple(reversed(fp.human_events)),
        scheme_version=fp.scheme_version,
    )

    assert compute_pr_hash(fp) == compute_pr_hash(reordered)


def test_compute_pr_hash_same_id_human_events_are_order_independent_when_body_differs():
    event_a = HumanEvent(id=9, body="a")
    event_b = HumanEvent(id=9, body="b")
    order_1 = _fingerprint(human_events=(event_a, event_b))
    order_2 = _fingerprint(human_events=(event_b, event_a))

    assert compute_pr_hash(order_1) == compute_pr_hash(order_2)


def test_compute_pr_hash_changes_with_head_sha():
    fp = _fingerprint()
    other = _fingerprint(head_sha="different-head-sha")

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_when_human_event_added():
    fp = _fingerprint()
    extra_event = HumanEvent(id=3, body="nit")
    other = PRFingerprint(
        head_sha=fp.head_sha,
        human_events=(*fp.human_events, extra_event),
        scheme_version=fp.scheme_version,
    )

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_human_event_id():
    fp = _fingerprint()
    events = (
        HumanEvent(id=99, body="lgtm"),
        HumanEvent(id=1, body="hi"),
    )
    other = _fingerprint(human_events=events)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_human_event_body():
    fp = _fingerprint()
    edited = tuple(HumanEvent(id=e.id, body="EDITED") if e.id == 1 else e for e in fp.human_events)
    other = PRFingerprint(head_sha=fp.head_sha, human_events=edited, scheme_version=fp.scheme_version)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_scheme_version():
    fp = _fingerprint()
    other = _fingerprint(scheme_version=fp.scheme_version + 1)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_returns_64_lowercase_hex_chars():
    digest = compute_pr_hash(_fingerprint())

    assert len(digest) == 64
    assert all(c in "0123456789abcdef" for c in digest)


def test_compute_pr_hash_handles_lone_surrogate_in_body_without_raising():
    event = HumanEvent(id=1, body="\ud800")
    fp = _fingerprint(human_events=(event,))

    digest = compute_pr_hash(fp)

    assert len(digest) == 64
    assert compute_pr_hash(fp) == digest


def test_compute_pr_hash_golden_scheme_v5():
    """Golden digest pinning scheme v5 (SHA-256).

    Any change to the payload, its canonicalization, or the hash algorithm breaks
    this on purpose; regenerate the literal only alongside a HASH_SCHEME_VERSION bump.
    """
    fp = PRFingerprint(
        head_sha="def456",
        human_events=(
            HumanEvent(id=2, body="lgtm"),
            HumanEvent(id=1, body="hi"),
        ),
        scheme_version=5,
    )

    assert compute_pr_hash(fp) == "f93158fd3d91a5458181ba78ff6f5d96abc6a00b0b668115ef113833d533b66c"


def test_compute_pr_hash_golden_pins_canonical_sort_key_scheme_v5():
    """Golden that pins the payload sort KEY (``key=_canonical``), not just the algorithm.

    The fixture is crafted so canonical (sorted-dict-key) ordering diverges from a
    naive ``key=str`` / field-order / insertion ordering: canonical weighs ``body``
    first (``body`` sorts before ``id``), while ``str`` weighs ``id`` first. Swapping
    ``key=_canonical`` for ``key=str`` (or dropping the sort) reorders the list and
    breaks this digest.
    """
    fp = PRFingerprint(
        head_sha="def456",
        human_events=(
            HumanEvent(id=1, body="z"),
            HumanEvent(id=2, body="a"),
        ),
        scheme_version=5,
    )

    assert compute_pr_hash(fp) == "1301c1364eff060bfb8b94f3252e8256637279b8c48be6638f502b06db24922d"


def test_compute_pr_hash_golden_scheme_v6():
    """Golden digest pinning the current scheme (v6, SHA-256).

    Any change to the payload, its canonicalization, or the hash algorithm breaks
    this on purpose; regenerate the literal only alongside a HASH_SCHEME_VERSION bump.
    """
    fp = PRFingerprint(
        head_sha="def456",
        human_events=(
            HumanEvent(id=2, body="lgtm"),
            HumanEvent(id=1, body="hi"),
        ),
        scheme_version=6,
    )

    assert compute_pr_hash(fp) == "cb4e0c1926ec5d63d4ba09290d1ccdd46ba7cf2e0c2e2ece2a9fbfefc5fc3226"


def test_compute_pr_hash_golden_pins_canonical_sort_key_scheme_v6():
    """Golden that pins the payload sort KEY (``key=_canonical``) at the current scheme (v6).

    The fixture is crafted so canonical (sorted-dict-key) ordering diverges from a
    naive ``key=str`` / field-order / insertion ordering: canonical weighs ``body``
    first (``body`` sorts before ``id``), while ``str`` weighs ``id`` first. Swapping
    ``key=_canonical`` for ``key=str`` (or dropping the sort) reorders the list and
    breaks this digest.
    """
    fp = PRFingerprint(
        head_sha="def456",
        human_events=(
            HumanEvent(id=1, body="z"),
            HumanEvent(id=2, body="a"),
        ),
        scheme_version=6,
    )

    assert compute_pr_hash(fp) == "a6178791d05cc91fe764b8cdfc5321ea871652aaaff608a02c5a20a71e8f20da"


def test_hash_scheme_version_is_pinned():
    assert HASH_SCHEME_VERSION == 6


def test_pr_fingerprint_scheme_version_defaults_to_current_scheme():
    fp = PRFingerprint(head_sha="def", human_events=())

    assert fp.scheme_version == HASH_SCHEME_VERSION


@pytest.mark.parametrize(
    ("login", "user_type", "expected"),
    [
        ("some-app", "Bot", True),
        ("some-app", "BOT", True),
        ("some-app", "bot", True),
        ("SomeApp[bot]", None, True),
        ("someapp[BOT]", None, True),
        ("Dependabot", None, True),
        ("DEPENDABOT", "User", True),
        ("pytorch-bot[bot]", None, True),
        ("pytorchbot", None, True),
        ("octocat", "User", False),
        ("octocat", None, False),
        ("octocat", "", False),
        (None, "Bot", True),
        ("", "Bot", True),
        (None, None, False),
        ("", None, False),
    ],
)
def test_is_bot_truth_table(login: str | None, user_type: str | None, expected: bool) -> None:
    assert is_bot(login, user_type) == expected


def test_is_bot_default_user_type_is_none():
    assert is_bot("octocat") is False


def test_bot_logins_are_lowercase_and_bracket_free():
    for login in BOT_LOGINS:
        assert login == login.lower()
        assert not login.endswith("[bot]")


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("@pytorchbot merge", True),
        ("@pytorchmergebot rebase", True),
        ("@claude please review", True),
        ("@greenlight status", True),
        ("@meta-codesync sync", True),
        ("@PyTorchBot merge", True),
        ("@PYTORCHMERGEBOT REBASE", True),
        ("@Claude", True),
        ("@GreenLight recheck", True),
        ("@Meta-CodeSync sync", True),
        ("please run @pytorchbot merge -f now", True),
        ("lgtm, cc @claude", True),
        ("plain human comment", False),
        ("no handle at all", False),
        ("reach me at foo@bar.com", False),
        ("pytorchbot without the at-sign", False),
        ("", False),
        (None, False),
    ],
)
def test_is_bot_command_truth_table(body: str | None, expected: bool) -> None:
    assert is_bot_command(body) == expected


def test_is_bot_command_matches_both_pytorch_handles_independently():
    # '@pytorchbot' is not a substring of '@pytorchmergebot', so each must be listed to be caught.
    assert "@pytorchbot" not in "@pytorchmergebot"
    assert is_bot_command("@pytorchbot merge") is True
    assert is_bot_command("@pytorchmergebot rebase") is True


def test_is_bot_command_handles_lone_surrogate_without_raising():
    assert is_bot_command("\ud800 @pytorchbot merge") is True
    assert is_bot_command("\ud800 no handle here") is False


def test_bot_command_mentions_are_lowercase_and_at_prefixed():
    for mention in BOT_COMMAND_MENTIONS:
        assert mention == mention.lower()
        assert mention.startswith("@")
