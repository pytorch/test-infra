import pytest

from greenlight.pr_hash import (
    BOT_LOGINS,
    HASH_SCHEME_VERSION,
    ChangedFile,
    HumanEvent,
    PRFingerprint,
    compute_pr_hash,
    is_bot,
)


def _fingerprint(
    *,
    base_sha: str = "abc123",
    changed_files: tuple[ChangedFile, ...] | None = None,
    human_events: tuple[HumanEvent, ...] | None = None,
    scheme_version: int = HASH_SCHEME_VERSION,
) -> PRFingerprint:
    files = (
        changed_files
        if changed_files is not None
        else (
            ChangedFile(path="b.py", status="modified", blob_sha="sha-b"),
            ChangedFile(path="a.py", status="added", blob_sha="sha-a", previous_path="old_a.py"),
        )
    )
    events = (
        human_events
        if human_events is not None
        else (
            HumanEvent(
                kind="review", id=2, author="bob", body="lgtm", state="APPROVED", timestamp="2026-01-02T00:00:00"
            ),
            HumanEvent(
                kind="issue_comment", id=1, author="alice", body="hi", state=None, timestamp="2026-01-01T00:00:00"
            ),
        )
    )
    return PRFingerprint(base_sha=base_sha, changed_files=files, human_events=events, scheme_version=scheme_version)


def test_compute_pr_hash_is_deterministic_for_same_input():
    fp = _fingerprint()

    assert compute_pr_hash(fp) == compute_pr_hash(fp)


def test_compute_pr_hash_ignores_changed_files_order():
    fp = _fingerprint()
    reordered = PRFingerprint(
        base_sha=fp.base_sha,
        changed_files=tuple(reversed(fp.changed_files)),
        human_events=fp.human_events,
        scheme_version=fp.scheme_version,
    )

    assert compute_pr_hash(fp) == compute_pr_hash(reordered)


def test_compute_pr_hash_ignores_human_events_order():
    fp = _fingerprint()
    reordered = PRFingerprint(
        base_sha=fp.base_sha,
        changed_files=fp.changed_files,
        human_events=tuple(reversed(fp.human_events)),
        scheme_version=fp.scheme_version,
    )

    assert compute_pr_hash(fp) == compute_pr_hash(reordered)


def test_compute_pr_hash_same_path_changed_files_are_order_independent_when_content_differs():
    file_a = ChangedFile(path="same.py", status="added", blob_sha="sha-1")
    file_b = ChangedFile(path="same.py", status="modified", blob_sha="sha-2")
    order_1 = _fingerprint(changed_files=(file_a, file_b))
    order_2 = _fingerprint(changed_files=(file_b, file_a))

    assert compute_pr_hash(order_1) == compute_pr_hash(order_2)


def test_compute_pr_hash_same_kind_and_id_human_events_are_order_independent_when_content_differs():
    event_a = HumanEvent(kind="review", id=9, author="alice", body="a", state=None, timestamp="2026-01-01T00:00:00")
    event_b = HumanEvent(kind="review", id=9, author="bob", body="b", state=None, timestamp="2026-01-02T00:00:00")
    order_1 = _fingerprint(human_events=(event_a, event_b))
    order_2 = _fingerprint(human_events=(event_b, event_a))

    assert compute_pr_hash(order_1) == compute_pr_hash(order_2)


def test_compute_pr_hash_changes_with_base_sha():
    fp = _fingerprint()
    other = _fingerprint(base_sha="different-sha")

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_file_blob_sha():
    fp = _fingerprint()
    changed = (
        ChangedFile(path="b.py", status="modified", blob_sha="sha-b-CHANGED"),
        ChangedFile(path="a.py", status="added", blob_sha="sha-a", previous_path="old_a.py"),
    )
    other = _fingerprint(changed_files=changed)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_file_status():
    fp = _fingerprint()
    changed = (
        ChangedFile(path="b.py", status="added", blob_sha="sha-b"),
        ChangedFile(path="a.py", status="added", blob_sha="sha-a", previous_path="old_a.py"),
    )
    other = _fingerprint(changed_files=changed)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_file_path():
    fp = _fingerprint()
    changed = (
        ChangedFile(path="b-CHANGED.py", status="modified", blob_sha="sha-b"),
        ChangedFile(path="a.py", status="added", blob_sha="sha-a", previous_path="old_a.py"),
    )
    other = _fingerprint(changed_files=changed)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_file_previous_path():
    fp = _fingerprint()
    changed = (
        ChangedFile(path="b.py", status="modified", blob_sha="sha-b"),
        ChangedFile(path="a.py", status="added", blob_sha="sha-a", previous_path="old_a-CHANGED.py"),
    )
    other = _fingerprint(changed_files=changed)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_when_human_event_added():
    fp = _fingerprint()
    extra_event = HumanEvent(
        kind="review_comment", id=3, author="carol", body="nit", state=None, timestamp="2026-01-03T00:00:00"
    )
    other = PRFingerprint(
        base_sha=fp.base_sha,
        changed_files=fp.changed_files,
        human_events=(*fp.human_events, extra_event),
        scheme_version=fp.scheme_version,
    )

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_when_human_event_edited():
    fp = _fingerprint()
    edited = tuple(
        HumanEvent(kind=e.kind, id=e.id, author=e.author, body="EDITED", state=e.state, timestamp=e.timestamp)
        if e.id == 1
        else e
        for e in fp.human_events
    )
    other = PRFingerprint(
        base_sha=fp.base_sha, changed_files=fp.changed_files, human_events=edited, scheme_version=fp.scheme_version
    )

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_human_event_kind():
    fp = _fingerprint()
    events = (
        HumanEvent(
            kind="review_comment", id=2, author="bob", body="lgtm", state="APPROVED", timestamp="2026-01-02T00:00:00"
        ),
        HumanEvent(kind="issue_comment", id=1, author="alice", body="hi", state=None, timestamp="2026-01-01T00:00:00"),
    )
    other = _fingerprint(human_events=events)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_human_event_author():
    fp = _fingerprint()
    events = (
        HumanEvent(
            kind="review", id=2, author="bob-CHANGED", body="lgtm", state="APPROVED", timestamp="2026-01-02T00:00:00"
        ),
        HumanEvent(kind="issue_comment", id=1, author="alice", body="hi", state=None, timestamp="2026-01-01T00:00:00"),
    )
    other = _fingerprint(human_events=events)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_human_event_state():
    fp = _fingerprint()
    events = (
        HumanEvent(
            kind="review", id=2, author="bob", body="lgtm", state="CHANGES_REQUESTED", timestamp="2026-01-02T00:00:00"
        ),
        HumanEvent(kind="issue_comment", id=1, author="alice", body="hi", state=None, timestamp="2026-01-01T00:00:00"),
    )
    other = _fingerprint(human_events=events)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_human_event_timestamp():
    fp = _fingerprint()
    events = (
        HumanEvent(kind="review", id=2, author="bob", body="lgtm", state="APPROVED", timestamp="2026-01-02T12:00:00"),
        HumanEvent(kind="issue_comment", id=1, author="alice", body="hi", state=None, timestamp="2026-01-01T00:00:00"),
    )
    other = _fingerprint(human_events=events)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_changes_with_scheme_version():
    fp = _fingerprint()
    other = _fingerprint(scheme_version=fp.scheme_version + 1)

    assert compute_pr_hash(fp) != compute_pr_hash(other)


def test_compute_pr_hash_returns_32_lowercase_hex_chars():
    digest = compute_pr_hash(_fingerprint())

    assert len(digest) == 32
    assert all(c in "0123456789abcdef" for c in digest)


def test_compute_pr_hash_handles_lone_surrogate_in_body_without_raising():
    event = HumanEvent(
        kind="issue_comment", id=1, author="alice", body="\ud800", state=None, timestamp="2026-01-01T00:00:00"
    )
    fp = _fingerprint(human_events=(event,))

    digest = compute_pr_hash(fp)

    assert len(digest) == 32
    assert compute_pr_hash(fp) == digest


def test_pr_fingerprint_scheme_version_defaults_to_current_scheme():
    fp = PRFingerprint(base_sha="abc", changed_files=(), human_events=())

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
    ],
)
def test_is_bot_truth_table(login: str, user_type: str | None, expected: bool) -> None:
    assert is_bot(login, user_type) == expected


def test_is_bot_default_user_type_is_none():
    assert is_bot("octocat") is False


def test_bot_logins_are_lowercase_and_bracket_free():
    for login in BOT_LOGINS:
        assert login == login.lower()
        assert not login.endswith("[bot]")
