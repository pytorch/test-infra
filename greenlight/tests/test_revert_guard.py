from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, NoReturn, cast

import pytest

from greenlight import revert_guard
from greenlight.constants import STATUS_AI_REVIEW_STARTED, STATUS_LAND, STATUS_REVERTED, TARGET_REPO
from greenlight.guards import IterationTimeout
from greenlight.state import PRState

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from github import Github

# Every seam below is faked, so the client is never inspected -- a bare sentinel is enough.
_CLIENT = cast("Github", object())
_BOT = "pytorchgreenlight[bot]"
_VERSION = datetime(2026, 7, 31, 12, 0, 0)


@dataclass(frozen=True)
class _FakeHead:
    sha: str


@dataclass(frozen=True)
class _FakePR:
    number: int
    head: _FakeHead


def _state(number: int, status: str = STATUS_LAND, run_id: int = 0) -> PRState:
    return PRState(
        pr_number=number, status=status, eval_hash="a" * 64, head_sha=f"rec{number}", version=_VERSION, run_id=run_id
    )


@dataclass
class _Guard:
    excluded: frozenset[int]
    failed: list[int] = field(default_factory=list)
    label_fetches: list[int] = field(default_factory=list)
    got_pr: list[int] = field(default_factory=list)
    dismissals: list[tuple[int, str, str]] = field(default_factory=list)
    emitted: list[tuple[str, int, str, int]] = field(default_factory=list)
    poked: list[int] = field(default_factory=list)
    events: list[str] = field(default_factory=list)
    cancelled: bool = False


def _exclude(
    pr_numbers: Sequence[int],
    *,
    recorded: frozenset[int] = frozenset(),
    known_labels: Mapping[int, Sequence[str]] | None = None,
    fetched_labels: Mapping[int, Sequence[str]] | None = None,
    states: Mapping[int, PRState] | None = None,
    bot_login: str = _BOT,
    dismissed_ids: Mapping[int, list[int]] | None = None,
    dismiss_errors: Mapping[int, Exception] | None = None,
    emit_errors: Mapping[int, Exception] | None = None,
    get_pr_errors: Mapping[int, Exception] | None = None,
) -> _Guard:
    known_labels = {} if known_labels is None else known_labels
    fetched_labels = {} if fetched_labels is None else fetched_labels
    states = {} if states is None else states
    dismissed_ids = {} if dismissed_ids is None else dismissed_ids
    dismiss_errors = {} if dismiss_errors is None else dismiss_errors
    emit_errors = {} if emit_errors is None else emit_errors
    get_pr_errors = {} if get_pr_errors is None else get_pr_errors
    result = _Guard(frozenset())
    cancel_event = threading.Event()

    def fake_read_reverted(_repo, numbers):
        return {n for n in numbers if n in recorded}

    def fake_fetch_labels(_client, _repo, number):
        result.label_fetches.append(number)
        return tuple(fetched_labels.get(number, ()))

    def fake_get_pr(_client, _repo, number):
        result.got_pr.append(number)
        error = get_pr_errors.get(number)
        if error is not None:
            raise error
        return _FakePR(number, _FakeHead(f"headsha{number}"))

    def fake_dismiss(pr, *, bot_login, message):
        result.dismissals.append((pr.number, bot_login, message))
        result.events.append(f"dismiss:{pr.number}")
        error = dismiss_errors.get(pr.number)
        if error is not None:
            raise error
        return list(dismissed_ids.get(pr.number, ()))

    def fake_emit(*, repo, pr_number, head_sha, run_id):
        result.events.append(f"emit:{pr_number}")
        error = emit_errors.get(pr_number)
        if error is not None:
            raise error
        result.emitted.append((repo, pr_number, head_sha, run_id))

    def fake_poke(number):
        result.poked.append(number)
        result.events.append(f"poke:{number}")

    result.excluded = revert_guard.exclude_reverted(
        _CLIENT,
        pr_numbers,
        known_labels=known_labels,
        states=states,
        bot_login=bot_login,
        read_reverted=fake_read_reverted,
        fetch_labels=fake_fetch_labels,
        get_pr=fake_get_pr,
        dismiss=fake_dismiss,
        emit=fake_emit,
        poke=fake_poke,
        failed=result.failed,
        cancel_event=cancel_event,
    )
    result.cancelled = cancel_event.is_set()
    return result


def test_fetch_pr_labels_reads_the_names_off_the_pr():
    class _Label:
        def __init__(self, name: str) -> None:
            self.name = name

    class _PR:
        def __init__(self) -> None:
            self.labels = [_Label("Reverted"), _Label("open source")]

    class _Repo:
        def get_pull(self, number: int) -> _PR:
            asked.append(number)
            return _PR()

    class _Client:
        def get_repo(self, full_name_or_id: str) -> _Repo:
            asked.append(full_name_or_id)
            return _Repo()

    asked: list[object] = []

    assert revert_guard.fetch_pr_labels(_Client(), TARGET_REPO, 7) == ("Reverted", "open source")
    assert asked == [TARGET_REPO, 7]


def test_clean_pr_is_not_excluded_and_nothing_is_touched():
    guard = _exclude([1], known_labels={1: ("open source", "Merged")}, bot_login="")

    # No reverted PR means no writes at all -- and no BOT_LOGIN demand either, so the ordinary
    # listing scan is unaffected by a login it never needs.
    assert guard.excluded == frozenset()
    assert guard.got_pr == []
    assert guard.dismissals == []
    assert guard.emitted == []
    assert guard.poked == []


def test_label_excludes_dismisses_records_and_pokes():
    guard = _exclude([1], known_labels={1: ("Reverted",)}, dismissed_ids={1: [901]})

    assert guard.excluded == frozenset({1})
    assert guard.dismissals == [(1, _BOT, revert_guard._DISMISS_MESSAGE)]
    # head_sha comes from the PR read at dismissal time, and the first row for a PR with no prior
    # state is run_id 1.
    assert guard.emitted == [(TARGET_REPO, 1, "headsha1", 1)]
    assert guard.poked == [1]
    # The poke comes after the row: Dr. CI re-reads the table, so poking first would only
    # re-render the state the row is replacing.
    assert guard.events == ["dismiss:1", "emit:1", "poke:1"]


@pytest.mark.parametrize("label", ["Reverted", "reverted", "REVERTED"])
def test_reverted_label_matched_case_insensitively(label):
    # Unlike Stale (matched exactly), a case variant of the revert label still excludes.
    assert _exclude([1], known_labels={1: (label,)}).excluded == frozenset({1})


def test_recorded_row_excludes_after_the_label_is_removed():
    guard = _exclude([1], recorded=frozenset({1}), known_labels={1: ()}, dismissed_ids={1: [901]})

    # The no-escape guarantee: taking the label off does not restore eligibility, because the row
    # -- not the label -- is what the exclusion is keyed on from then on.
    assert guard.excluded == frozenset({1})
    assert guard.dismissals == [(1, _BOT, revert_guard._DISMISS_MESSAGE)]


def test_winning_row_is_not_rewritten():
    guard = _exclude(
        [1], recorded=frozenset({1}), states={1: _state(1, STATUS_REVERTED, run_id=7)}, dismissed_ids={1: [901]}
    )

    # The row is written once; a settled exclusion re-run writes nothing further.
    assert guard.emitted == []
    assert guard.poked == [1]


def test_outranked_row_is_rewritten_above_the_row_that_beat_it_and_then_settles():
    first = _exclude([1], recorded=frozenset({1}), states={1: _state(1, STATUS_LAND, run_id=19283746)})

    # A review still in flight when the revert landed posts its verdict at the real github.run_id,
    # which outranks the REVERTED row written at prior+1 -- so Dr. CI would go on rendering LAND on a
    # reverted PR. Recording again at one above it puts the exclusion back on top.
    assert first.emitted == [(TARGET_REPO, 1, "headsha1", 19283747)]
    assert first.poked == [1]

    second = _exclude([1], recorded=frozenset({1}), states={1: _state(1, STATUS_REVERTED, run_id=19283747)})

    # Bounded, because the rewrite is what makes the row win: the following scan writes nothing.
    assert second.emitted == []
    assert second.poked == []


def test_settled_exclusion_does_not_poke_when_nothing_changed():
    guard = _exclude([1], recorded=frozenset({1}), states={1: _state(1, STATUS_REVERTED)})

    # Dr. CI already renders this PR's REVERTED row, so a rebuild is only worth requesting when an
    # approval was actually revoked this pass.
    assert guard.dismissals == [(1, _BOT, revert_guard._DISMISS_MESSAGE)]
    assert guard.emitted == []
    assert guard.poked == []


@pytest.mark.parametrize(
    ("recorded", "states"),
    [
        pytest.param(frozenset(), None, id="no-row-at-all"),
        pytest.param(frozenset({1}), None, id="reverted-row-but-no-authoritative-state"),
        pytest.param(frozenset(), {1: _state(1, STATUS_AI_REVIEW_STARTED)}, id="in-flight-review"),
    ],
)
def test_dismissal_is_attempted_whatever_the_state_says(recorded, states):
    # A missing row is never read as "no approval": the reviewer posts its approving review a step
    # before it uploads the row, so a lost upload or replication lag leaves a live approval with
    # nothing recorded.
    guard = _exclude([1], recorded=recorded, known_labels={1: ("Reverted",)}, states=states)

    assert guard.dismissals == [(1, _BOT, revert_guard._DISMISS_MESSAGE)]


def test_row_supersedes_the_prior_row_by_run_id():
    guard = _exclude([1], known_labels={1: ("Reverted",)}, states={1: _state(1, run_id=7)})

    # Dr. CI renders a PR's latest row, so the exclusion must outrank the prior one.
    assert guard.emitted == [(TARGET_REPO, 1, "headsha1", 8)]


def test_failed_dismissal_still_records_the_row_and_still_drops_the_pr(caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        guard = _exclude([1], known_labels={1: ("Reverted",)}, dismiss_errors={1: RuntimeError("dismiss boom")})

    # Recording is what makes the exclusion outlive the label: without the row, taking the label off
    # before the next scan would make this a candidate again, still carrying the unrevoked approval.
    # The row costs no retry -- the next scan dismisses it again, before reading any state.
    assert guard.emitted == [(TARGET_REPO, 1, "headsha1", 1)]
    assert guard.poked == [1]
    assert guard.failed == [1]
    assert guard.excluded == frozenset({1})
    assert "failed to revoke greenlight approval on reverted PR #1" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_recorded_row_survives_a_failed_dismissal_and_the_label_coming_off():
    first = _exclude([1], known_labels={1: ("Reverted",)}, dismiss_errors={1: RuntimeError("dismiss boom")})

    assert first.emitted == [(TARGET_REPO, 1, "headsha1", 1)]

    second = _exclude([1], recorded=frozenset({1}), known_labels={1: ()}, dismissed_ids={1: [901]})

    # The scan the failure hands off to: the label is gone, and only the row written despite that
    # failure keeps the PR excluded long enough for the retried dismissal to land.
    assert second.excluded == frozenset({1})
    assert second.dismissals == [(1, _BOT, revert_guard._DISMISS_MESSAGE)]


def test_failed_pr_read_records_nothing_because_the_row_needs_its_head_sha(caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        guard = _exclude([1], known_labels={1: ("Reverted",)}, get_pr_errors={1: RuntimeError("get_pr boom")})

    assert guard.dismissals == []
    assert guard.emitted == []
    assert guard.failed == [1]
    assert guard.excluded == frozenset({1})


def test_failed_emit_records_the_failure_and_does_not_poke(caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        guard = _exclude([1], known_labels={1: ("Reverted",)}, emit_errors={1: RuntimeError("emit boom")})

    assert guard.emitted == []
    assert guard.poked == []
    assert guard.failed == [1]
    assert guard.excluded == frozenset({1})
    assert "failed to record REVERTED for PR #1" in caplog.text


def test_rate_limited_dismissal_trips_the_cancel_event():
    from github import RateLimitExceededException

    guard = _exclude([1], known_labels={1: ("Reverted",)}, dismiss_errors={1: RateLimitExceededException(403)})

    # Classified exactly as the fingerprint stage classifies it: the event gates the fan-out and the
    # dispatch phase so neither runs on a throttled token.
    assert guard.cancelled
    assert guard.failed == [1]


def test_non_rate_limit_dismissal_failure_leaves_the_cancel_event_clear():
    guard = _exclude([1], known_labels={1: ("Reverted",)}, dismiss_errors={1: RuntimeError("dismiss boom")})

    assert not guard.cancelled


@pytest.mark.parametrize("stage", ["get_pr", "dismiss", "emit"])
def test_iteration_timeout_propagates(stage):
    errors = {1: IterationTimeout("iteration exceeded")}

    # The soft per-iteration control signal is not a per-PR failure: it must halt the scan rather
    # than be swallowed into `failed`.
    with pytest.raises(IterationTimeout):
        _exclude(
            [1],
            known_labels={1: ("Reverted",)},
            get_pr_errors=errors if stage == "get_pr" else None,
            dismiss_errors=errors if stage == "dismiss" else None,
            emit_errors=errors if stage == "emit" else None,
        )


@pytest.mark.parametrize("bot_login", ["", "[bot]", "greenlight"])
def test_non_app_bot_login_refuses_the_whole_scan(bot_login):
    # Dismissal matches greenlight's own reviews by login, so a login that is not <slug>[bot]
    # silently dismisses nothing while reporting success -- every scan would then report a clean
    # revocation while the approval stays live on a reverted PR.
    with pytest.raises(ValueError, match="BOT_LOGIN must be the greenlight App login"):
        _exclude([1], known_labels={1: ("Reverted",)}, bot_login=bot_login)


def test_non_app_bot_login_refuses_before_any_write():
    def boom(*_args: object, **_kwargs: object) -> NoReturn:
        raise AssertionError("nothing may be written before the BOT_LOGIN check")

    with pytest.raises(ValueError, match="BOT_LOGIN must be the greenlight App login"):
        revert_guard.exclude_reverted(
            _CLIENT,
            [1],
            known_labels={1: ("Reverted",)},
            states={},
            bot_login="",
            read_reverted=lambda _repo, _numbers: set(),
            fetch_labels=lambda _client, _repo, _number: (),
            get_pr=boom,
            dismiss=boom,
            emit=boom,
            poke=boom,
            failed=[],
            cancel_event=threading.Event(),
        )


def test_labels_are_only_fetched_for_prs_the_caller_has_none_for():
    guard = _exclude([1, 2], known_labels={1: ("Reverted",)}, fetched_labels={2: ("Reverted",)})

    # The listing scan gets labels free from the open-PR payload; only a PR absent from that map
    # (the --pr path, which has no listing) costs an extra read.
    assert guard.label_fetches == [2]
    assert guard.excluded == frozenset({1, 2})


def test_each_reverted_pr_is_acted_on_independently():
    guard = _exclude(
        [1, 2, 3],
        known_labels={1: ("Reverted",), 2: (), 3: ("Reverted",)},
        dismiss_errors={1: RuntimeError("dismiss boom")},
    )

    # PR1's failure isolates: it is recorded anyway, PR3 is still dismissed and recorded, and clean
    # PR2 is left alone.
    assert guard.excluded == frozenset({1, 3})
    assert guard.failed == [1]
    assert guard.emitted == [(TARGET_REPO, 1, "headsha1", 1), (TARGET_REPO, 3, "headsha3", 1)]


def test_no_candidates_returns_empty_without_reading_labels():
    guard = _exclude([])

    assert guard.excluded == frozenset()
    assert guard.label_fetches == []
