"""GreenLight's own reviews (``approvals``): the moved review predicates, the gate decision, the conditional
reader and the dismissal request."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from greenlight import approvals, constants
from greenlight.approvals import (
    GREENLIGHT_LOGIN,
    PullFacts,
    ReviewActor,
    ReviewReader,
    ReviewRecord,
    counted_review,
    gate_decision,
    live_approvals,
    on_commit,
    payload_is,
    payload_optional,
    payload_required,
)
from greenlight.cohort import GREENLIGHT_APP_SLUG
from tests.test_github_client import _FakeActor, _FakeVerdictPR, _FakeVerdictReview

HEAD = "a" * 40
OLD = "b" * 40
OLDER = "c" * 40


def test_dismiss_prior_greenlight_approvals_only_dismisses_own_approved():
    reviews = [
        _FakeVerdictReview(1, _FakeActor("greenlight-app[bot]"), "APPROVED"),
        _FakeVerdictReview(2, _FakeActor("alice"), "APPROVED"),
        _FakeVerdictReview(3, _FakeActor("greenlight-app[bot]"), "COMMENTED"),
        _FakeVerdictReview(4, None, "APPROVED"),
        _FakeVerdictReview(5, _FakeActor(""), "APPROVED"),
        _FakeVerdictReview(6, _FakeActor("GreenLight-App[Bot]"), "APPROVED"),
    ]
    pr = _FakeVerdictPR(reviews=reviews)

    dismissed = approvals.dismiss_prior_greenlight_approvals(pr, bot_login="greenlight-app[bot]", message="superseded")

    assert dismissed == [1, 6]
    assert reviews[0].dismissed_with == "superseded"
    assert reviews[5].dismissed_with == "superseded"
    assert [r.dismissed_with for r in reviews[1:5]] == [None, None, None, None]


def test_dismiss_prior_greenlight_approvals_when_none_match():
    reviews = [_FakeVerdictReview(1, _FakeActor("alice"), "APPROVED")]
    pr = _FakeVerdictPR(reviews=reviews)

    dismissed = approvals.dismiss_prior_greenlight_approvals(pr, bot_login="greenlight-app[bot]", message="x")

    assert dismissed == []
    assert reviews[0].dismissed_with is None


def _record(
    id: int,
    state: str = "APPROVED",
    commit_id: str | None = HEAD,
    login: str | None = GREENLIGHT_LOGIN,
    type: str | None = "Bot",
) -> ReviewRecord:
    user = None if login is None and type is None else ReviewActor(login=login, type=type)
    return ReviewRecord(id=id, user=user, state=state, commit_id=commit_id, submitted_at=None)


def test_greenlight_login_is_the_app_bot_account():
    assert GREENLIGHT_LOGIN == f"{GREENLIGHT_APP_SLUG}{constants.BOT_LOGIN_SUFFIX}" == "pytorchgreenlight[bot]"


def test_dismiss_approvals_dismisses_each_in_order_and_returns_their_ids():
    reviews = [_FakeVerdictReview(4, _FakeActor("a"), "APPROVED"), _FakeVerdictReview(2, _FakeActor("b"), "APPROVED")]

    assert approvals.dismiss_approvals(reviews, "gone") == [4, 2]
    assert [r.dismissed_with for r in reviews] == ["gone", "gone"]


def test_dismiss_approvals_raises_on_a_failed_dismissal_and_dismisses_nothing_after_it():
    class _Refusing(_FakeVerdictReview):
        def dismiss(self, message: str) -> None:
            raise RuntimeError("403")

    later = _FakeVerdictReview(2, _FakeActor("a"), "APPROVED")

    with pytest.raises(RuntimeError, match="403"):
        approvals.dismiss_approvals([_Refusing(1, _FakeActor("a"), "APPROVED"), later], "gone")
    assert later.dismissed_with is None


@pytest.mark.parametrize(
    ("commit", "sha", "on"),
    [
        pytest.param(HEAD, HEAD, True, id="same"),
        pytest.param(HEAD.upper(), HEAD, True, id="case"),
        pytest.param(OLD, HEAD, False, id="other"),
        pytest.param(None, HEAD, False, id="unknown"),
        pytest.param("", "", False, id="empty"),
    ],
)
def test_on_commit_is_a_known_commit_equal_to_the_sha_in_any_case(commit: str | None, sha: str, on: bool) -> None:
    assert on_commit(_record(1, commit_id=commit), sha) is on


def test_counted_review_is_the_latest_review_of_the_login_that_is_not_a_comment_or_pending():
    reviews = [
        _record(1, commit_id=OLD),
        _record(2, state="DISMISSED"),
        _record(3, state="COMMENTED"),
        _record(4, state="PENDING"),
        _record(5, login="alice"),
        _record(6, login=None, type=None),
    ]

    counted = counted_review(reviews, GREENLIGHT_LOGIN)

    assert counted is not None
    assert counted.id == 2


def test_counted_review_folds_the_logins_case():
    counted = counted_review([_record(1), _record(2, login="PyTorchGreenLight[BOT]", state="DISMISSED")], "x")
    found = counted_review(
        [_record(1), _record(2, login="PyTorchGreenLight[BOT]", state="DISMISSED")], GREENLIGHT_LOGIN
    )

    assert counted is None
    assert found is not None
    assert found.id == 2


def test_counted_review_is_none_with_only_comments():
    assert counted_review([_record(1, state="COMMENTED"), _record(2, login="")], GREENLIGHT_LOGIN) is None


def test_live_approvals_inexact_folds_case_and_ignores_type():
    reviews = [
        _record(1, login="PyTorchGreenLight[bot]", type="User"),
        _record(2, state="DISMISSED"),
        _record(3, state="COMMENTED"),
        _record(4, login="alice"),
        _record(5),
    ]

    assert [r.id for r in live_approvals(reviews, GREENLIGHT_LOGIN)] == [1, 5]


def test_live_approvals_exact_requires_same_login_and_bot_type():
    reviews = [
        _record(1, login="PyTorchGreenLight[bot]"),
        _record(2, type="User"),
        _record(3, type=None),
        _record(4),
    ]

    assert [r.id for r in live_approvals(reviews, GREENLIGHT_LOGIN, exact=True)] == [4]


@pytest.mark.parametrize("exact", [False, True])
def test_live_approvals_never_match_null_user_or_empty_login(exact: bool) -> None:
    reviews = [_record(1, login=None, type=None), _record(2, login=None), _record(3, login="")]

    assert live_approvals(reviews, GREENLIGHT_LOGIN, exact=exact) == []
    assert live_approvals(reviews, "", exact=exact) == []


def test_live_approvals_accept_pygithub_shaped_objects():
    class _User:
        login = GREENLIGHT_LOGIN
        type = "Bot"

    class _Review:
        user = _User()
        state = "APPROVED"
        commit_id = HEAD

    review = _Review()
    assert live_approvals([review], GREENLIGHT_LOGIN, exact=True) == [review]


def test_gate_passes_with_no_greenlight_review():
    decision = gate_decision([_record(1, login="alice", type="User", commit_id=OLD)], HEAD)

    assert decision.passes
    assert decision.reason == "no live GreenLight approval"


def test_gate_passes_with_only_dismissed_and_commented_reviews():
    decision = gate_decision([_record(1, state="DISMISSED", commit_id=OLD), _record(2, state="COMMENTED")], HEAD)

    assert decision.passes
    assert decision.reason == "no live GreenLight approval"


def test_gate_passes_when_every_live_approval_is_on_the_head():
    decision = gate_decision([_record(1, commit_id=HEAD), _record(2, commit_id=HEAD.upper())], HEAD)

    assert decision.passes
    assert HEAD in decision.reason


def test_gate_holds_on_an_approval_of_an_older_commit():
    decision = gate_decision([_record(1, commit_id=OLD)], HEAD)

    assert not decision.passes
    assert decision.reason == f"live GreenLight approval on {OLD} while the head is {HEAD}"


def test_gate_holds_on_an_older_approval_behind_a_newer_dismissed_one():
    reviews = [_record(1, commit_id=OLDER), _record(2, state="DISMISSED", commit_id=OLD), _record(3, commit_id=HEAD)]

    decision = gate_decision(reviews, HEAD)

    assert not decision.passes
    assert decision.reason == f"live GreenLight approval on {OLDER} while the head is {HEAD}"


def test_gate_names_each_stale_commit_once_and_an_unknown_one():
    reviews = [_record(1, commit_id=OLD), _record(2, commit_id=None), _record(3, commit_id=OLD)]

    decision = gate_decision(reviews, HEAD)

    assert not decision.passes
    assert decision.reason == f"live GreenLight approval on {OLD}, an unknown commit while the head is {HEAD}"


def test_gate_ignores_an_approval_from_a_user_spelling_the_app_login():
    decision = gate_decision([_record(1, type="User", commit_id=OLD)], HEAD)

    assert decision.passes


def _review_payload(id: int, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": id,
        "user": {"login": GREENLIGHT_LOGIN, "type": "Bot"},
        "state": "APPROVED",
        "commit_id": HEAD,
        "submitted_at": "2026-11-17T10:20:30Z",
    }
    payload.update(overrides)
    return payload


def _pull_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "number": 7,
        "state": "open",
        "head": {"sha": HEAD, "ref": "feature"},
        "base": {"ref": "main", "repo": {"default_branch": "main"}},
        "updated_at": "2026-11-17T10:20:30Z",
    }
    payload.update(overrides)
    return payload


def test_review_record_parses_the_payload():
    record = ReviewRecord.from_payload(_review_payload(5))

    assert record == ReviewRecord(
        id=5,
        user=ReviewActor(login=GREENLIGHT_LOGIN, type="Bot"),
        state="APPROVED",
        commit_id=HEAD,
        submitted_at=datetime(2026, 11, 17, 10, 20, 30, tzinfo=UTC),
    )


def test_review_record_takes_null_user_commit_and_time():
    record = ReviewRecord.from_payload(_review_payload(5, user=None, commit_id=None, submitted_at=None))

    assert (record.user, record.commit_id, record.submitted_at) == (None, None, None)


def test_review_record_converts_an_offset_time_to_utc():
    record = ReviewRecord.from_payload(_review_payload(5, submitted_at="2026-11-17T12:20:30+02:00"))

    assert record.submitted_at == datetime(2026, 11, 17, 10, 20, 30, tzinfo=UTC)


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param([], id="not-an-object"),
        pytest.param({**_review_payload(5), "id": True}, id="bool-id"),
        pytest.param({**_review_payload(5), "id": "5"}, id="string-id"),
        pytest.param(_review_payload(5, state=None), id="no-state"),
        pytest.param(_review_payload(5, user="x"), id="user-not-object"),
        pytest.param(_review_payload(5, user={"login": 3}), id="login-not-string"),
        pytest.param(_review_payload(5, submitted_at="2026-11-17T10:20:30"), id="naive-time"),
        pytest.param(_review_payload(5, submitted_at="yesterday"), id="bad-time"),
    ],
)
def test_review_record_rejects_a_bad_payload(payload: object) -> None:
    with pytest.raises(ValueError):
        ReviewRecord.from_payload(payload)


def test_pull_facts_parse_the_payload():
    facts = PullFacts.from_payload(_pull_payload())

    assert facts == PullFacts(number=7, state="open", head_sha=HEAD, base_ref="main")
    assert facts.is_open


def test_pull_facts_of_a_closed_pr_are_not_open():
    assert not PullFacts.from_payload(_pull_payload(state="closed")).is_open


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(None, id="null"),
        pytest.param(_pull_payload(head=None), id="no-head"),
        pytest.param(_pull_payload(head={"ref": "x"}), id="no-head-sha"),
        pytest.param(_pull_payload(base={"repo": None}), id="no-base-ref"),
        pytest.param(_pull_payload(number="7"), id="string-number"),
    ],
)
def test_pull_facts_reject_a_bad_payload(payload: object) -> None:
    with pytest.raises(ValueError):
        PullFacts.from_payload(payload)


@pytest.mark.parametrize(
    ("value", "kind", "passes"),
    [
        pytest.param(7, int, True, id="int"),
        pytest.param(True, int, False, id="bool-is-no-int"),
        pytest.param(False, bool, True, id="bool"),
        pytest.param("7", int, False, id="text-is-no-int"),
        pytest.param(None, str, False, id="null"),
    ],
)
def test_payload_is_counts_a_json_boolean_only_as_a_bool(value: object, kind: type, passes: bool) -> None:
    assert payload_is(value, kind) is passes


def test_payload_required_names_the_field_it_rejects():
    assert payload_required({"n": 3}, "n", int, "thing") == 3
    with pytest.raises(ValueError, match="thing field 'n' is not a int: True"):
        payload_required({"n": True}, "n", int, "thing")
    with pytest.raises(ValueError, match="thing field 'n' is not a int: None"):
        payload_required({}, "n", int, "thing")


def test_payload_optional_takes_an_absent_or_null_field_as_none():
    assert payload_optional({}, "n", int, "thing") is None
    assert payload_optional({"n": None}, "n", int, "thing") is None
    assert payload_optional({"n": 4}, "n", int, "thing") == 4
    with pytest.raises(ValueError, match="thing field 'n'"):
        payload_optional({"n": "4"}, "n", int, "thing")


def test_payload_mapping_names_what_is_not_an_object():
    assert approvals.payload_mapping({"a": 1}, "thing") == {"a": 1}
    with pytest.raises(ValueError, match="thing is not an object: list"):
        approvals.payload_mapping([], "thing")


class _FakeRequester:
    """Answers GETs from ``pages`` (url -> page -> list of (etag, body)); a request whose If-None-Match equals the
    current etag gets a 304 (no body)."""

    def __init__(self) -> None:
        self.current: dict[tuple[str, int], tuple[str | None, Any]] = {}
        self.calls: list[tuple[str, str, dict[str, Any] | None, dict[str, str] | None, Any]] = []
        self.fail: Exception | None = None

    def set(self, url: str, body: Any, etag: str | None, page: int = 0) -> None:
        self.current[(url, page)] = (etag, body)

    def requestJsonAndCheck(
        self,
        verb: str,
        url: str,
        parameters: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        input: Any | None = None,
    ) -> tuple[dict[str, Any], Any]:
        self.calls.append((verb, url, parameters, headers, input))
        if self.fail is not None:
            raise self.fail
        if verb != "GET":
            return {}, {}
        page = (parameters or {}).get("page", 0)
        etag, body = self.current[(url, page)]
        if etag is not None and headers is not None and headers.get("If-None-Match") == etag:
            return {"etag": etag}, None
        return ({} if etag is None else {"etag": etag}), body

    def gets(self) -> list[tuple[int, str | None]]:
        return [((p or {}).get("page", 0), (h or {}).get("If-None-Match")) for _v, _u, p, h, _i in self.calls]


_PULL_URL = "/repos/pytorch/vision/pulls/7"
_REVIEWS_URL = "/repos/pytorch/vision/pulls/7/reviews"


def _page(*ids: int) -> list[dict[str, Any]]:
    return [_review_payload(i) for i in ids]


def test_reader_pull_reuses_its_result_on_304():
    requester = _FakeRequester()
    requester.set(_PULL_URL, _pull_payload(), '"e1"')
    reader = ReviewReader(requester)

    first = reader.pull("pytorch/vision", 7)
    second = reader.pull("pytorch/vision", 7)

    assert first == second
    assert requester.gets() == [(0, None), (0, '"e1"')]


def test_reader_replaces_its_entry_on_200():
    requester = _FakeRequester()
    requester.set(_PULL_URL, _pull_payload(), '"e1"')
    reader = ReviewReader(requester)
    reader.pull("pytorch/vision", 7)
    requester.set(_PULL_URL, _pull_payload(state="closed"), '"e2"')

    assert not reader.pull("pytorch/vision", 7).is_open
    assert not reader.pull("pytorch/vision", 7).is_open
    assert requester.gets()[-1] == (0, '"e2"')


def test_reader_keeps_nothing_without_an_etag():
    requester = _FakeRequester()
    requester.set(_PULL_URL, _pull_payload(), None)
    reader = ReviewReader(requester)

    reader.pull("pytorch/vision", 7)
    reader.pull("pytorch/vision", 7)

    assert requester.gets() == [(0, None), (0, None)]


def test_reader_refuses_an_empty_body_with_nothing_kept():
    requester = _FakeRequester()
    requester.set(_PULL_URL, None, None)

    with pytest.raises(ValueError, match="no body"):
        ReviewReader(requester).pull("pytorch/vision", 7)


def test_reader_propagates_read_failures():
    requester = _FakeRequester()
    requester.fail = RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        ReviewReader(requester).reviews("pytorch/vision", 7)


def test_reader_rejects_a_reviews_payload_that_is_not_a_list():
    requester = _FakeRequester()
    requester.set(_REVIEWS_URL, {"message": "x"}, '"p1"', page=1)

    with pytest.raises(ValueError, match="not a list"):
        ReviewReader(requester).reviews("pytorch/vision", 7)


def test_reader_paginates_until_a_short_page():
    requester = _FakeRequester()
    requester.set(_REVIEWS_URL, _page(1, 2), '"p1"', page=1)
    requester.set(_REVIEWS_URL, _page(3, 4), '"p2"', page=2)
    requester.set(_REVIEWS_URL, _page(5), '"p3"', page=3)

    records = ReviewReader(requester, per_page=2).reviews("pytorch/vision", 7)

    assert [r.id for r in records] == [1, 2, 3, 4, 5]
    assert [p for _v, _u, p, _h, _i in requester.calls] == [
        {"per_page": 2, "page": 1},
        {"per_page": 2, "page": 2},
        {"per_page": 2, "page": 3},
    ]


def test_reader_default_page_size_is_100():
    requester = _FakeRequester()
    requester.set(_REVIEWS_URL, [], '"p1"', page=1)

    assert ReviewReader(requester).reviews("pytorch/vision", 7) == []
    assert requester.calls[0][2] == {"per_page": approvals.REVIEWS_PER_PAGE, "page": 1}
    assert approvals.REVIEWS_PER_PAGE == 100


def test_reader_reads_past_an_unchanged_full_last_page():
    requester = _FakeRequester()
    requester.set(_REVIEWS_URL, _page(1, 2), '"p1"', page=1)
    requester.set(_REVIEWS_URL, [], '"p2-empty"', page=2)
    reader = ReviewReader(requester, per_page=2)
    assert [r.id for r in reader.reviews("pytorch/vision", 7)] == [1, 2]
    requester.set(_REVIEWS_URL, _page(3), '"p2"', page=2)

    records = reader.reviews("pytorch/vision", 7)

    assert [r.id for r in records] == [1, 2, 3]
    assert requester.gets()[-2:] == [(1, '"p1"'), (2, '"p2-empty"')]


def test_reader_ends_on_an_unchanged_partial_page():
    requester = _FakeRequester()
    requester.set(_REVIEWS_URL, _page(1, 2), '"p1"', page=1)
    requester.set(_REVIEWS_URL, _page(3), '"p2"', page=2)
    reader = ReviewReader(requester, per_page=2)
    reader.reviews("pytorch/vision", 7)

    records = reader.reviews("pytorch/vision", 7)

    assert [r.id for r in records] == [1, 2, 3]
    assert requester.gets()[-2:] == [(1, '"p1"'), (2, '"p2"')]
    assert len(requester.calls) == 4


def test_reader_forgets_pages_past_the_last_one():
    requester = _FakeRequester()
    requester.set(_REVIEWS_URL, _page(1, 2), '"p1"', page=1)
    requester.set(_REVIEWS_URL, _page(3), '"p2"', page=2)
    reader = ReviewReader(requester, per_page=2)
    reader.reviews("pytorch/vision", 7)
    requester.set(_REVIEWS_URL, _page(1), '"p1-short"', page=1)
    reader.reviews("pytorch/vision", 7)
    requester.set(_REVIEWS_URL, _page(1, 2), '"p1"', page=1)

    reader.reviews("pytorch/vision", 7)

    assert requester.gets()[-1] == (2, None)


def test_reader_prune_keeps_only_the_named_prs():
    requester = _FakeRequester()
    other_pull = "/repos/pytorch/vision/pulls/8"
    requester.set(_PULL_URL, _pull_payload(), '"e7"')
    requester.set(other_pull, _pull_payload(number=8), '"e8"')
    requester.set(_REVIEWS_URL, _page(1), '"r7"', page=1)
    requester.set(f"{other_pull}/reviews", _page(2), '"r8"', page=1)
    reader = ReviewReader(requester)
    for number in (7, 8):
        reader.pull("pytorch/vision", number)
        reader.reviews("pytorch/vision", number)

    reader.prune({8})
    for number in (7, 8):
        reader.pull("pytorch/vision", number)
        reader.reviews("pytorch/vision", number)

    assert requester.gets()[-4:] == [(0, None), (1, None), (0, '"e8"'), (1, '"r8"')]


def test_reader_rebind_sends_later_reads_through_the_new_requester_and_keeps_its_results():
    first = _FakeRequester()
    first.set(_REVIEWS_URL, _page(1), '"r1"', page=1)
    reader = ReviewReader(first)
    assert [r.id for r in reader.reviews("pytorch/vision", 7)] == [1]
    second = _FakeRequester()
    second.set(_REVIEWS_URL, _page(1), '"r1"', page=1)

    reader.rebind(second)

    assert [r.id for r in reader.reviews("pytorch/vision", 7)] == [1]
    assert first.gets() == [(1, None)]
    assert second.gets() == [(1, '"r1"')]


def test_dismiss_review_puts_the_dismissal():
    requester = _FakeRequester()

    approvals.dismiss_review(requester, "pytorch/vision", 7, 99, "superseded")

    assert requester.calls == [
        (
            "PUT",
            "/repos/pytorch/vision/pulls/7/reviews/99/dismissals",
            None,
            None,
            {"message": "superseded", "event": "DISMISS"},
        )
    ]


def test_dismiss_review_propagates_failures():
    requester = _FakeRequester()
    requester.fail = RuntimeError("422")

    with pytest.raises(RuntimeError, match="422"):
        approvals.dismiss_review(requester, "pytorch/vision", 7, 99, "superseded")
