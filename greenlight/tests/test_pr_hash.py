import pytest

from greenlight.pr_hash import (
    BOT_LOGINS,
    HASH_SCHEME_VERSION,
    HumanEvent,
    PRFingerprint,
    compute_pr_hash,
    is_bot,
)


def _fingerprint(
    *,
    base_sha: str = "abc123",
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
    return PRFingerprint(base_sha=base_sha, head_sha=head_sha, human_events=events, scheme_version=scheme_version)


def test_compute_pr_hash_is_deterministic_for_same_input():
    fp = _fingerprint()

    assert compute_pr_hash(fp) == compute_pr_hash(fp)


def test_compute_pr_hash_ignores_human_events_order():
    fp = _fingerprint()
    reordered = PRFingerprint(
        base_sha=fp.base_sha,
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


def test_compute_pr_hash_changes_with_base_sha():
    fp = _fingerprint()
    other = _fingerprint(base_sha="different-sha")

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_head_sha():
    fp = _fingerprint()
    other = _fingerprint(head_sha="different-head-sha")

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_when_human_event_added():
    fp = _fingerprint()
    extra_event = HumanEvent(id=3, body="nit")
    other = PRFingerprint(
        base_sha=fp.base_sha,
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
    other = PRFingerprint(
        base_sha=fp.base_sha, head_sha=fp.head_sha, human_events=edited, scheme_version=fp.scheme_version
    )

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


def test_compute_pr_hash_golden_scheme_v4():
    """Golden digest pinning scheme v4 (SHA-256).

    Any change to the payload, its canonicalization, or the hash algorithm breaks
    this on purpose; regenerate the literal only alongside a HASH_SCHEME_VERSION bump.
    """
    fp = PRFingerprint(
        base_sha="abc123",
        head_sha="def456",
        human_events=(
            HumanEvent(id=2, body="lgtm"),
            HumanEvent(id=1, body="hi"),
        ),
        scheme_version=4,
    )

    assert compute_pr_hash(fp) == "7aafb42b947f4d63210cb7970641638c47be5bd0cef6814fafa9bdc57176c5f5"


def test_compute_pr_hash_golden_pins_canonical_sort_key_scheme_v4():
    """Golden that pins the payload sort KEY (``key=_canonical``), not just the algorithm.

    The fixture is crafted so canonical (sorted-dict-key) ordering diverges from a
    naive ``key=str`` / field-order / insertion ordering: canonical weighs ``body``
    first (``body`` sorts before ``id``), while ``str`` weighs ``id`` first. Swapping
    ``key=_canonical`` for ``key=str`` (or dropping the sort) reorders the list and
    breaks this digest.
    """
    fp = PRFingerprint(
        base_sha="abc123",
        head_sha="def456",
        human_events=(
            HumanEvent(id=1, body="z"),
            HumanEvent(id=2, body="a"),
        ),
        scheme_version=4,
    )

    assert compute_pr_hash(fp) == "181b902bdd8bd20067df4cf5011ce276121d6b5a34d40e121e1a4f8158af2ec5"


def test_hash_scheme_version_is_pinned():
    assert HASH_SCHEME_VERSION == 4


def test_pr_fingerprint_scheme_version_defaults_to_current_scheme():
    fp = PRFingerprint(base_sha="abc", head_sha="def", human_events=())

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
