from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from github import RateLimitExceededException

from greenlight import approval_backing
from greenlight.approvals import GREENLIGHT_LOGIN
from greenlight.constants import (
    BACKING_WAIT_MAX,
    LEDGER_MARGIN,
    SCAN_TICK_INTERVAL,
    STATUS_AI_REVIEW_DISPATCHED,
    STATUS_AI_REVIEW_STARTED,
    STATUS_CANCELLED,
    STATUS_FAILED,
    STATUS_LAND,
    STATUS_NO_LAND,
    STATUS_REVERTED,
    TERMINAL_STATUSES,
)
from greenlight.gate_rules import GateRules
from greenlight.guards import IterationTimeout
from greenlight.repo_config import RepoEntry
from greenlight.scan_memory import BackingKey, ScanMemory
from greenlight.state import PRState

_REPO = "pytorch/vision"
_ENFORCED = GateRules(enforced=True)
_ENTRY = RepoEntry(_REPO, "greenlight", "gate", "merge_rules", "active")
_BOT = GREENLIGHT_LOGIN
_HEAD = "a" * 40
_OLD = "b" * 40
_NOW = datetime(2026, 11, 17, 12, 0, 0)
_GIVEN = _NOW - timedelta(minutes=5)
_ROW_TIME = _GIVEN - timedelta(minutes=1)
_PREFIX = "GreenLight's approval no longer applies: "
_PULL_URL = re.compile(rf"/repos/{_REPO}/pulls/(\d+)$")
_REVIEWS_URL = re.compile(rf"/repos/{_REPO}/pulls/(\d+)/reviews$")
_DISMISS_URL = re.compile(rf"/repos/{_REPO}/pulls/(\d+)/reviews/(\d+)/dismissals$")


@dataclass
class _Ref:
    sha: str = ""
    ref: str = ""


@dataclass
class _Pull:
    number: int
    head: _Ref
    base: _Ref
    updated_at: datetime | None


def _pull(number: int, head: str = _HEAD, base: str = "main", updated_at: datetime | None = _GIVEN) -> _Pull:
    return _Pull(number, _Ref(sha=head), _Ref(ref=base), updated_at)


def _review(review_id: int, *, commit: str = _HEAD, given: datetime = _GIVEN, login: str = _BOT) -> dict[str, Any]:
    return {
        "id": review_id,
        "user": {"login": login, "type": "Bot"},
        "state": "APPROVED",
        "commit_id": commit,
        "submitted_at": given.isoformat() + "Z",
    }


def _row(number: int, status: str, *, head: str = _HEAD, version: datetime = _ROW_TIME) -> PRState:
    return PRState(pr_number=number, status=status, eval_hash="e" * 64, head_sha=head, version=version, run_id=9)


class _GitHub:
    """A client and its requester: PR and review reads answer 304 to a current ETag; dismissals are recorded."""

    def __init__(self) -> None:
        self.requester = self
        self.reviews: dict[int, list[dict[str, Any]]] = {}
        self.fresh: dict[int, tuple[str, str]] = {}
        self.errors: dict[tuple[str, int], BaseException] = {}
        self.reads: list[tuple[str, int, int]] = []
        self.dismissals: list[tuple[int, int, str]] = []
        self.closed = 0

    def close(self) -> None:
        self.closed += 1

    def _answer(self, kind: str, number: int, body: Any, headers: dict[str, str] | None) -> tuple[dict[str, Any], Any]:
        error = self.errors.get((kind, number))
        if error is not None:
            raise error
        etag = '"' + hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest() + '"'
        if headers is not None and headers.get("If-None-Match") == etag:
            self.reads.append((kind, number, 304))
            return {"etag": etag}, None
        self.reads.append((kind, number, 200))
        return {"etag": etag}, body

    def requestJsonAndCheck(
        self,
        verb: str,
        url: str,
        parameters: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        input: Any | None = None,
    ) -> tuple[dict[str, Any], Any]:
        if verb == "PUT" and (match := _DISMISS_URL.match(url)):
            number, review_id = int(match[1]), int(match[2])
            error = self.errors.get(("dismiss", number))
            if error is not None:
                raise error
            assert input is not None
            assert input["event"] == "DISMISS"
            self.dismissals.append((number, review_id, input["message"]))
            for review in self.reviews[number]:
                if review["id"] == review_id:
                    review["state"] = "DISMISSED"
            return {}, {}
        if match := _REVIEWS_URL.match(url):
            assert parameters == {"per_page": 100, "page": 1}
            number = int(match[1])
            return self._answer("reviews", number, self.reviews.get(number, []), headers)
        if match := _PULL_URL.match(url):
            number = int(match[1])
            head, base = self.fresh[number]
            body = {"number": number, "state": "open", "head": {"sha": head}, "base": {"ref": base}}
            return self._answer("pull", number, body, headers)
        raise AssertionError(f"unexpected {verb} {url}")

    def read_numbers(self, kind: str = "reviews") -> list[int]:
        return [number for read, number, _status in self.reads if read == kind]


class _Run:
    """Ticks of the check against fakes; ``pulls`` is what the listing returns and also each PR's fresh read."""

    def __init__(
        self,
        pulls: list[_Pull],
        *,
        reviews: dict[int, list[dict[str, Any]]] | None = None,
        rows: dict[int, PRState] | None = None,
        ledger: datetime | None = _GIVEN,
        rules: GateRules | BaseException = _ENFORCED,
    ) -> None:
        self.github = _GitHub()
        self.github.reviews = reviews or {}
        self.pulls = pulls
        self.rows = rows or {}
        self.verdicts: dict[int, PRState] | None = None
        self.ledger = ledger
        self.rules = rules
        self.memory = ScanMemory()
        self.clock = _NOW
        self.gate_reads: list[list[int]] = []
        self.rule_reads = 0
        self.gates_error: BaseException | None = None
        self.ledger_error: BaseException | None = None

    def _gates(self, repo: str, numbers: list[int]) -> tuple[dict[int, PRState], dict[int, PRState]]:
        assert repo == _REPO
        self.gate_reads.append(list(numbers))
        if self.gates_error is not None:
            raise self.gates_error
        gates = {number: row for number, row in self.rows.items() if number in numbers}
        if self.verdicts is not None:
            return gates, self.verdicts
        return gates, {number: row for number, row in gates.items() if row.status in TERMINAL_STATUSES}

    def _rules(self, client: Any, repo: str) -> GateRules:
        assert (client, repo) == (self.github, _REPO)
        self.rule_reads += 1
        if isinstance(self.rules, BaseException):
            raise self.rules
        return self.rules

    def tick(
        self, make_config: Any, *, cancel_event: threading.Event | None = None, bot_login: str = _BOT
    ) -> approval_backing.BackingReport:
        for pull in self.pulls:
            self.github.fresh.setdefault(pull.number, (pull.head.sha, pull.base.ref))
        return approval_backing.check(
            make_config(github_token="t"),
            entry=_ENTRY,
            memory=self.memory,
            bot_login=bot_login,
            build_github=self._build,
            cancel_event=cancel_event,
            now=lambda: self.clock,
            list_prs=lambda client, repo: list(self.pulls),  # type: ignore[arg-type]
            read_gates=self._gates,  # type: ignore[arg-type]
            read_ledger_newest=self._ledger,
            read_rules=self._rules,
        )

    def _ledger(self) -> datetime | None:
        if self.ledger_error is not None:
            raise self.ledger_error
        return self.ledger

    def _build(self, token: str) -> Any:
        assert token == "t"
        return self.github


def _dismissed(run: _Run) -> list[tuple[int, int, str]]:
    return run.github.dismissals


def _sweep_checked(run: _Run, *numbers: int) -> None:
    """Start a sweep at ``_NOW`` that has checked ``numbers`` already, so it reads every other PR first."""
    run.memory.backing.start_sweep(_NOW, recorded=frozenset()).checked.update(numbers)


def test_a_land_row_on_the_head_backs_the_approval(make_config):
    run = _Run([_pull(7)], reviews={7: [_review(1)]}, rows={7: _row(7, STATUS_LAND)})

    report = run.tick(make_config)

    assert _dismissed(run) == []
    assert (report.dismissed, report.failed, report.errors, report.rules) == (0, (), (), GateRules(enforced=True))
    assert run.github.read_numbers() == [7]
    assert run.github.read_numbers("pull") == []
    assert run.github.closed == 1


def test_unenforced_rules_dismiss_every_live_approval_and_are_logged(make_config, caplog):
    rules = GateRules(enforced=False, problems=("a merge_queue rule applies", "no pull_request rule requires one"))
    run = _Run(
        [_pull(7)],
        reviews={7: [_review(1), _review(2), _review(3, login="someone")]},
        rows={7: _row(7, STATUS_LAND)},
        rules=rules,
    )

    with caplog.at_level(logging.INFO, logger="greenlight"):
        report = run.tick(make_config)

    reason = (
        "GreenLight's gate is not enforced on pytorch/vision: a merge_queue rule applies; "
        "no pull_request rule requires one."
    )
    assert _dismissed(run) == [(7, 1, _PREFIX + reason), (7, 2, _PREFIX + reason)]
    assert (report.dismissed, report.rules, report.errors) == (2, rules, ())
    assert re.search(
        r"pytorch/vision: approval backing: .*, gate rules not enforced: a merge_queue rule applies; "
        r"no pull_request rule requires one$",
        caplog.text,
        re.MULTILINE,
    )


@pytest.mark.parametrize(
    ("pull", "review", "row", "reason"),
    [
        pytest.param(
            _pull(7),
            _review(1, commit=_OLD),
            _row(7, STATUS_LAND),
            f"it was given on {_OLD}, not on the head {_HEAD}",
            id="commit",
        ),
        pytest.param(
            _pull(7, base="release/2.9"),
            _review(1),
            _row(7, STATUS_LAND),
            "the base is release/2.9, not main",
            id="base",
        ),
        pytest.param(
            _pull(7),
            _review(1),
            _row(7, STATUS_REVERTED),
            "GreenLight's latest row for the PR is REVERTED",
            id="reverted",
        ),
        *(
            pytest.param(
                _pull(7),
                _review(1),
                _row(7, status, version=_GIVEN + timedelta(seconds=1)),
                f"a newer {status} row",
                id=f"newer-{status}",
            )
            for status in (STATUS_AI_REVIEW_STARTED, STATUS_NO_LAND, STATUS_CANCELLED, STATUS_FAILED)
        ),
    ],
)
def test_an_unbacked_approval_is_dismissed_with_its_reason(make_config, pull, review, row, reason):
    run = _Run([pull], reviews={7: [review]}, rows={7: row})

    report = run.tick(make_config)

    assert _dismissed(run) == [(7, 1, f"{_PREFIX}{reason}.")]
    assert report.dismissed == 1
    assert run.github.read_numbers("pull") == [7]
    assert run.memory.backing.waiting == frozenset()


@pytest.mark.parametrize(
    "row",
    [
        pytest.param(None, id="no-row"),
        pytest.param(_row(7, STATUS_AI_REVIEW_DISPATCHED), id="in-flight"),
        pytest.param(_row(7, STATUS_LAND, head=_OLD), id="land-for-another-head"),
    ],
)
def test_an_approval_the_ledger_has_not_moved_past_waits_and_is_read_again_next_tick(make_config, row):
    run = _Run(
        [_pull(n) for n in range(1, 15)],
        reviews={7: [_review(1)]},
        rows={} if row is None else {7: row},
        ledger=_GIVEN + LEDGER_MARGIN - timedelta(seconds=1),
    )
    run.memory.backing.start_sweep(_NOW, recorded=frozenset({7}))

    first = run.tick(make_config)
    assert (_dismissed(run), first.waiting) == ([], 1)
    assert run.memory.backing.waiting == frozenset({7})
    first_reads = run.github.read_numbers()
    assert (first_reads[0], first_reads.count(7)) == (7, 1)

    run.rows[7] = _row(7, STATUS_LAND)
    run.clock += SCAN_TICK_INTERVAL
    second = run.tick(make_config)

    second_reads = run.github.read_numbers()[len(first_reads) :]
    assert (second_reads[0], second_reads.count(7)) == (7, 1)
    assert (second.waiting, run.memory.backing.waiting, _dismissed(run)) == (0, frozenset(), [])


def test_an_approval_the_ledger_has_moved_past_is_dismissed(make_config):
    run = _Run([_pull(7)], reviews={7: [_review(1)]}, ledger=_GIVEN + LEDGER_MARGIN)

    run.tick(make_config)

    assert _dismissed(run) == [(7, 1, f"{_PREFIX}no LAND row backs it on the head.")]


def test_an_approval_older_than_the_wait_max_is_dismissed(make_config):
    run = _Run([_pull(7)], reviews={7: [_review(1, given=_NOW - BACKING_WAIT_MAX)]}, ledger=None)

    run.tick(make_config)

    assert _dismissed(run) == [(7, 1, f"{_PREFIX}no LAND row backs it on the head.")]


def test_unknown_rules_are_an_error_and_the_approvals_are_judged_on_the_rest(make_config, caplog):
    run = _Run(
        [_pull(7), _pull(8)],
        reviews={7: [_review(1)], 8: [_review(2, commit=_OLD)]},
        rows={7: _row(7, STATUS_LAND), 8: _row(8, STATUS_LAND)},
        rules=ValueError("rules page 1 is not a list"),
    )

    with caplog.at_level(logging.INFO, logger="greenlight"):
        report = run.tick(make_config)

    assert report.rules is None
    assert report.errors == ("GreenLight's gate rules on pytorch/vision could not be read: rules page 1 is not a list",)
    assert [(number, review) for number, review, _message in _dismissed(run)] == [(8, 2)]
    assert any(record.exc_info for record in caplog.records if "cannot read GreenLight's gate rules" in record.message)
    assert re.search(r"pytorch/vision: approval backing: .*, gate rules unread$", caplog.text, re.MULTILINE)


def test_a_fresh_read_on_the_approvals_commit_keeps_it(make_config):
    run = _Run([_pull(7, head=_OLD)], reviews={7: [_review(1)]}, rows={7: _row(7, STATUS_LAND)})
    run.github.fresh[7] = (_HEAD, "main")

    report = run.tick(make_config)

    assert run.github.read_numbers("pull") == [7]
    assert (_dismissed(run), report.dismissed, report.failed) == ([], 0, ())


def test_a_fresh_read_can_make_an_unbacked_approval_wait(make_config):
    run = _Run([_pull(7, head=_OLD)], reviews={7: [_review(1)]}, ledger=None)
    run.github.fresh[7] = (_HEAD, "main")

    report = run.tick(make_config)

    assert (_dismissed(run), report.waiting) == ([], 1)
    assert run.memory.backing.waiting == frozenset({7})


def test_only_the_unbacked_approvals_are_dismissed_by_id(make_config):
    run = _Run([_pull(7)], reviews={7: [_review(1, commit=_OLD), _review(2)]}, rows={7: _row(7, STATUS_LAND)})

    report = run.tick(make_config)

    assert _dismissed(run) == [(7, 1, f"{_PREFIX}it was given on {_OLD}, not on the head {_HEAD}.")]
    assert report.dismissed == 1


def test_the_ledger_prs_are_read_on_the_first_tick_and_not_again_while_unchanged(make_config):
    pulls = [_pull(n) for n in range(1, 30)]
    rows = {5: _row(5, STATUS_LAND), 9: _row(9, STATUS_NO_LAND), 20: _row(20, STATUS_AI_REVIEW_STARTED)}
    run = _Run(pulls, reviews={5: [_review(1)]}, rows=rows)
    _sweep_checked(run, 5, 9, 20)

    first = run.tick(make_config)
    run.clock += SCAN_TICK_INTERVAL
    second = run.tick(make_config)

    assert (first.changed_reads, second.changed_reads) == (3, 0)
    assert run.github.read_numbers()[:3] == [5, 9, 20]
    assert [read for read in run.github.reads if read[1] in (5, 9, 20)] == [
        ("reviews", 5, 200),
        ("reviews", 9, 200),
        ("reviews", 20, 200),
    ]
    assert _dismissed(run) == []


def _changed_key(run: _Run, change: str) -> None:
    pull = run.pulls[6]
    if change == "updated_at":
        pull.updated_at = _NOW
    elif change == "head":
        pull.head.sha = _OLD
        run.github.fresh[7] = (_OLD, "main")
    elif change == "base":
        pull.base.ref = "release/2.9"
        run.github.fresh[7] = (_HEAD, "release/2.9")
    elif change == "gate-row":
        run.rows[7] = _row(7, STATUS_LAND, version=_ROW_TIME + timedelta(seconds=1))
    else:
        run.rules = GateRules(enforced=False, problems=("a merge_queue rule applies",))


@pytest.mark.parametrize(
    ("change", "changed"),
    [
        ("updated_at", [7]),
        ("head", [7]),
        ("base", [7]),
        ("gate-row", [7]),
        # The rules answer is in every key: every PR read before (7, and the sweep's 1 to 4) is read again.
        ("rules", [7, 1, 2, 3, 4]),
    ],
)
def test_a_ledger_pr_whose_key_changed_is_read_again(make_config, change, changed):
    run = _Run([_pull(n) for n in range(1, 15)], reviews={7: [_review(1)]}, rows={7: _row(7, STATUS_LAND)})
    _sweep_checked(run, 7)
    run.tick(make_config)
    run.clock += SCAN_TICK_INTERVAL
    assert run.tick(make_config).changed_reads == 0
    _changed_key(run, change)
    run.clock += SCAN_TICK_INTERVAL

    before = len(run.github.reads)

    report = run.tick(make_config)

    assert report.changed_reads == len(changed)
    assert run.github.read_numbers()[before : before + len(changed)] == changed
    assert run.github.read_numbers().count(7) == 2
    assert len(_dismissed(run)) == (0 if change in ("updated_at", "gate-row") else 1)


def test_a_pr_read_by_the_sweep_is_read_again_once_its_update_time_moves(make_config):
    run = _Run([_pull(n) for n in range(1, 15)])
    run.tick(make_config)
    assert run.github.read_numbers() == [1, 2]
    run.github.reviews[1] = [_review(1, commit=_OLD)]
    run.pulls[0].updated_at = _NOW
    run.clock += SCAN_TICK_INTERVAL

    report = run.tick(make_config)

    assert report.changed_reads == 1
    assert run.github.read_numbers() == [1, 2, 1, 3, 4]
    assert _dismissed(run) == [(1, 1, f"{_PREFIX}it was given on {_OLD}, not on the head {_HEAD}.")]


def test_a_pr_never_read_outside_the_ledger_waits_for_the_sweep(make_config):
    run = _Run([_pull(n) for n in range(1, 15)], reviews={14: [_review(1, commit=_OLD)]})

    report = run.tick(make_config)

    assert (report.changed_reads, run.github.read_numbers(), _dismissed(run)) == (0, [1, 2], [])


def test_a_pr_whose_latest_row_is_in_flight_is_read_each_time_its_key_changes(make_config):
    run = _Run([_pull(n) for n in range(1, 15)], rows={9: _row(9, STATUS_AI_REVIEW_STARTED)})
    run.ledger = _GIVEN + LEDGER_MARGIN
    _sweep_checked(run, 9)

    first = run.tick(make_config)
    run.clock += SCAN_TICK_INTERVAL
    unchanged = run.tick(make_config)
    run.github.reviews[9] = [_review(1)]
    run.rows[9] = _row(9, STATUS_AI_REVIEW_STARTED, version=_ROW_TIME + timedelta(seconds=1))
    run.clock += SCAN_TICK_INTERVAL
    approved = run.tick(make_config)

    assert (first.changed_reads, unchanged.changed_reads, approved.changed_reads) == (1, 0, 1)
    assert run.github.read_numbers()[0] == 9
    assert run.github.read_numbers().count(9) == 2
    assert _dismissed(run) == [(9, 1, f"{_PREFIX}no LAND row backs it on the head.")]


@pytest.mark.parametrize("broken", ["gates", "ledger"])
def test_a_clickhouse_failure_is_an_error_and_only_the_rules_commit_and_base_dismiss(make_config, caplog, broken):
    run = _Run(
        [_pull(7), _pull(8), _pull(9, base="release/2.9")],
        reviews={7: [_review(1)], 8: [_review(2, commit=_OLD)], 9: [_review(3)]},
        rows={7: _row(7, STATUS_NO_LAND, version=_NOW)},
    )
    run.memory.backing.waiting = frozenset({7, 8, 9})
    error = RuntimeError("clickhouse down")
    if broken == "gates":
        run.gates_error = error
    else:
        run.ledger_error = error

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        report = run.tick(make_config)

    assert report.errors == ("GreenLight's ledger on pytorch/vision could not be read: clickhouse down",)
    assert any(record.exc_info for record in caplog.records if "cannot read GreenLight's ledger" in record.message)
    assert [(number, review) for number, review, _message in _dismissed(run)] == [(8, 2), (9, 3)]
    assert (report.changed_reads, report.waiting, run.memory.backing.waiting) == (0, 1, frozenset({7}))
    assert sorted(run.memory.backing.keys) == [8, 9]

    run.clock += SCAN_TICK_INTERVAL
    run.tick(make_config)

    assert run.github.read_numbers().count(7) == 2


def test_a_clickhouse_failure_keeps_each_kept_row_so_an_unchanged_pr_is_not_read(make_config):
    run = _Run(
        [_pull(n, updated_at=_GIVEN.replace(tzinfo=UTC)) for n in range(1, 15)],
        reviews={7: [_review(1)]},
        rows={7: _row(7, STATUS_LAND), 8: _row(8, STATUS_LAND)},
    )
    _sweep_checked(run, 7, 8)
    run.tick(make_config)
    assert run.memory.backing.keys[7] == BackingKey(_GIVEN, _HEAD, "main", (STATUS_LAND, 9, _ROW_TIME), True)
    del run.memory.backing.keys[8]
    run.gates_error = RuntimeError("clickhouse down")
    run.clock += SCAN_TICK_INTERVAL
    before = len(run.github.reads)

    report = run.tick(make_config)

    assert report.changed_reads == 0
    assert 7 not in run.github.read_numbers()[before:]
    assert 8 not in run.github.read_numbers()[before:]
    assert run.memory.backing.keys[7].gate_row == (STATUS_LAND, 9, _ROW_TIME)


def test_the_sweep_reads_every_open_pr_within_its_window_then_restarts(make_config):
    run = _Run([_pull(n) for n in range(1, 15)], rows={12: _row(12, STATUS_AI_REVIEW_STARTED)})
    reads: list[list[int]] = []
    reports = []
    for _ in range(8):
        before = len(run.github.reads)
        reports.append(run.tick(make_config))
        reads.append([number for _kind, number, _status in run.github.reads[before:]])
        run.clock += SCAN_TICK_INTERVAL

    # 12 is a ledger PR (its row is in flight), so it is read on the first tick ahead of the sweep's slice.
    assert reads[:7] == [[12, 1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 13], [14]]
    assert [report.sweep_number for report in reports] == [1, 1, 1, 1, 1, 1, 1, 2]
    assert [(report.sweep_checked, report.sweep_pending) for report in reports[5:7]] == [(13, 1), (14, 0)]
    assert all(report.errors == () for report in reports)
    assert reads[7] == [12, 1]
    assert run.memory.backing.sweep is not None
    assert run.memory.backing.sweep.started_at == _NOW + 7 * SCAN_TICK_INTERVAL


def test_a_sweep_past_its_window_is_an_error_and_goes_on_at_the_steady_rate(make_config):
    run = _Run([_pull(n) for n in range(1, 15)])
    for number in range(1, 15):
        run.github.errors[("reviews", number)] = ValueError("502")
    for _ in range(8):
        run.tick(make_config)
        run.clock += SCAN_TICK_INTERVAL
    run.github.errors.clear()
    before = len(run.github.reads)

    late = run.tick(make_config)

    assert "sweep 1 incomplete after 15 minutes: 14 PRs unread" in late.errors
    assert late.sweep_reads == 2
    assert len(run.github.reads) - before == 2


def test_a_check_that_did_not_run_for_a_window_starts_a_new_sweep(make_config, caplog):
    run = _Run([_pull(n) for n in range(1, 15)])
    run.tick(make_config)
    run.clock += timedelta(minutes=16)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        report = run.tick(make_config)

    assert report.errors == ()
    assert report.sweep_number == 2
    assert run.memory.backing.sweep is not None
    assert run.memory.backing.sweep.started_at == run.clock
    assert any("starting a new sweep" in record.message for record in caplog.records)


def test_a_failed_read_is_reported_and_stays_pending_in_the_sweep(make_config, caplog):
    run = _Run([_pull(1), _pull(2)])
    run.github.errors[("reviews", 1)] = ValueError("502")

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        report = run.tick(make_config)

    assert report.failed == (1,)
    assert report.errors == ("the approval-backing check failed on 1 PR(s): [1]",)
    sweep = run.memory.backing.sweep
    assert sweep is not None
    assert sweep.pending([1, 2]) == [2, 1]
    assert any(record.exc_info for record in caplog.records if "PR #1" in record.message)
    del run.github.errors[("reviews", 1)]
    for _ in range(2):
        run.clock += SCAN_TICK_INTERVAL
        assert run.tick(make_config).failed == ()
    assert run.github.read_numbers() == [2, 1]
    assert run.memory.backing.sweep is None


def test_a_failed_dismissal_is_reported_and_its_pr_stays_pending(make_config):
    run = _Run([_pull(7)], reviews={7: [_review(1, commit=_OLD)]})
    run.github.errors[("dismiss", 7)] = ValueError("422")

    report = run.tick(make_config)

    assert (report.failed, report.dismissed) == ((7,), 0)
    assert run.memory.backing.sweep is not None
    assert run.memory.backing.sweep.pending([7]) == [7]


def test_a_failed_read_of_a_waiting_pr_keeps_it_waiting(make_config):
    run = _Run([_pull(7)], reviews={7: [_review(1)]}, ledger=None)
    run.tick(make_config)
    run.github.errors[("reviews", 7)] = ValueError("502")
    run.clock += SCAN_TICK_INTERVAL

    report = run.tick(make_config)

    assert report.failed == (7,)
    assert run.memory.backing.waiting == frozenset({7})


def test_a_rate_limit_on_a_review_read_sets_the_latch_and_ends_the_check(make_config):
    run = _Run([_pull(n) for n in range(1, 15)], rows={1: _row(1, STATUS_LAND), 2: _row(2, STATUS_LAND)})
    run.github.errors[("reviews", 1)] = RateLimitExceededException(403, {"message": "rate limit"}, {})
    latch = threading.Event()

    report = run.tick(make_config, cancel_event=latch)

    assert latch.is_set()
    assert run.github.read_numbers() == []
    assert (report.failed, report.changed_reads, report.sweep_reads) == ((1,), 1, 0)


def test_a_rate_limit_on_a_dismissal_sets_the_latch_and_ends_the_check(make_config):
    run = _Run([_pull(1), _pull(2)], reviews={1: [_review(1, commit=_OLD)], 2: [_review(2, commit=_OLD)]})
    run.github.errors[("dismiss", 1)] = RateLimitExceededException(403, {"message": "rate limit"}, {})
    latch = threading.Event()

    report = run.tick(make_config, cancel_event=latch)

    assert latch.is_set()
    assert run.github.read_numbers() == [1]
    assert report.failed == (1,)


def test_a_rate_limit_on_the_rules_read_sets_the_latch_and_ends_the_check(make_config):
    run = _Run([_pull(1)], reviews={1: [_review(1, commit=_OLD)]})
    run.rules = RateLimitExceededException(403, {"message": "rate limit"}, {})
    latch = threading.Event()

    report = run.tick(make_config, cancel_event=latch)

    assert latch.is_set()
    assert (report.rules, report.open_prs, report.sweep_number) == (None, 1, 0)
    assert report.errors[0].startswith("GreenLight's gate rules on pytorch/vision could not be read: 403")
    assert (run.gate_reads, run.github.reads) == ([], [])


def test_a_latch_already_set_reads_no_reviews(make_config):
    run = _Run([_pull(1)], reviews={1: [_review(1, commit=_OLD)]})
    latch = threading.Event()
    latch.set()

    report = run.tick(make_config, cancel_event=latch)

    assert run.github.reads == []
    assert report.errors == ()


def test_an_iteration_timeout_propagates_and_closes_the_client(make_config):
    run = _Run([_pull(1)])
    run.github.errors[("reviews", 1)] = IterationTimeout("late")

    with pytest.raises(IterationTimeout):
        run.tick(make_config)
    assert run.github.closed == 1

    run.github.errors.clear()
    run.rules = IterationTimeout("late")
    with pytest.raises(IterationTimeout):
        run.tick(make_config)


def test_an_empty_repo_reads_its_rules_and_starts_a_new_sweep_each_tick(make_config, caplog):
    run = _Run([])

    with caplog.at_level(logging.INFO, logger="greenlight"):
        first = run.tick(make_config)
    run.clock += SCAN_TICK_INTERVAL
    second = run.tick(make_config)

    assert (first.open_prs, first.sweep_number, second.sweep_number, first.errors) == (0, 1, 2, ())
    assert (run.rule_reads, run.gate_reads, run.github.reads) == (2, [[], []], [])
    assert run.memory.backing.sweep is None
    assert re.search(
        r"pytorch/vision: approval backing: 0 open PR\(s\), 0 changed, sweep 1 \(0 checked, 0 pending, 0 read\), "
        r"0 waiting, 0 dismissed, 0 failed, in \d+\.\d s, gate rules enforced$",
        caplog.text,
        re.MULTILINE,
    )


def test_a_closed_prs_kept_reviews_are_forgotten(make_config):
    run = _Run([_pull(7)], rows={7: _row(7, STATUS_LAND)})
    run.tick(make_config)
    run.pulls = []
    run.tick(make_config)
    run.pulls = [_pull(7)]

    run.tick(make_config)

    assert run.github.reads == [("reviews", 7, 200), ("reviews", 7, 200)]


def test_the_reader_outlives_the_tick_and_reads_through_each_ticks_client(make_config):
    run = _Run([_pull(7)], rows={7: _row(7, STATUS_LAND)})
    run.tick(make_config)
    reader = run.memory.backing.reader
    first = run.github
    run.github = _GitHub()
    run.github.reviews = first.reviews
    run.pulls[0].updated_at = _NOW

    run.tick(make_config)

    assert run.memory.backing.reader is reader
    assert run.github.reads == [("reviews", 7, 304)]


def test_clearing_the_drain_keeps_the_backing_check_going(make_config):
    run = _Run([_pull(n) for n in range(1, 15)])
    run.tick(make_config)
    sweep = run.memory.backing.sweep

    run.memory.clear_drain()
    run.clock += SCAN_TICK_INTERVAL
    report = run.tick(make_config)

    assert run.memory.backing.sweep is sweep
    assert report.sweep_number == 1


@pytest.mark.parametrize("bot_login", ["", "greenlight-app", "greenlight-app[bot]", GREENLIGHT_LOGIN.upper()])
def test_a_bot_login_other_than_greenlights_raises_before_any_read(make_config, bot_login):
    run = _Run([_pull(1)])

    with pytest.raises(ValueError, match=re.escape(f"BOT_LOGIN must be {GREENLIGHT_LOGIN}, the account the merge")):
        run.tick(make_config, bot_login=bot_login)
    assert run.rule_reads == 0


def test_a_check_needs_a_token(make_config):
    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        approval_backing.check(make_config(), entry=_ENTRY, memory=ScanMemory(), bot_login=_BOT)


def test_a_listing_failure_raises(make_config):
    run = _Run([_pull(1)])

    def broken(*_args: Any) -> Any:
        raise RuntimeError("listing down")

    with pytest.raises(RuntimeError, match="listing down"):
        approval_backing.check(
            make_config(github_token="t"),
            entry=_ENTRY,
            memory=run.memory,
            bot_login=_BOT,
            build_github=run._build,
            list_prs=broken,
            read_rules=run._rules,
        )
    assert run.github.closed == 1


def test_an_iteration_timeout_reading_the_ledger_propagates(make_config):
    run = _Run([_pull(1)])
    run.gates_error = IterationTimeout("late")

    with pytest.raises(IterationTimeout):
        run.tick(make_config)
    assert run.github.closed == 1
