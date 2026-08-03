import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, cast

import pytest

from greenlight import scan_runner
from greenlight.comment_format import RECHECK_REFUSAL_MARKER
from greenlight.guards import IterationTimeout
from greenlight.review_gate import CHANGES_REQUESTED, HUMAN_APPROVED, ReviewSkip

if TYPE_CHECKING:
    from concurrent.futures import Future

    from github import Github

# post_refusals threads the client straight through to the get_pr seam and never inspects it.
_CLIENT = cast("Github", object())
_REPO = "pytorch/pytorch"


def _skip(detail: str = "changes requested by bob") -> ReviewSkip:
    return ReviewSkip(CHANGES_REQUESTED, detail)


class _RaisingFuture:
    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    def result(self) -> object:
        raise self._exc


def test_post_refusals_no_skips_is_noop():
    calls: list[str] = []

    def get_pr(_client, _repo, number):
        calls.append("get_pr")
        return number

    def upsert(_pr, **_kwargs):
        calls.append("upsert")

    scan_runner.post_refusals(_CLIENT, _REPO, [], bot_login="gl[bot]", get_pr=get_pr, upsert_comment=upsert)

    assert calls == []


def test_post_refusals_empty_bot_login_logs_and_skips_posting(caplog):
    upserts: list[object] = []

    def get_pr(_client, _repo, number):
        return number

    def upsert(pr, **_kwargs):
        upserts.append(pr)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        scan_runner.post_refusals(_CLIENT, _REPO, [(5, _skip())], bot_login="", get_pr=get_pr, upsert_comment=upsert)

    # No bot login -> the comment cannot be author-scoped, so posting is skipped with an error.
    assert upserts == []
    assert "BOT_LOGIN is required to post" in caplog.text


def test_post_refusals_posts_one_comment_per_skip_without_run_id():
    posted: list[tuple[object, dict[str, object]]] = []

    def get_pr(_client, repo, number):
        return (repo, number)

    def upsert(pr, **kwargs):
        posted.append((pr, kwargs))

    scan_runner.post_refusals(
        _CLIENT,
        _REPO,
        [(5, _skip("changes requested by bob")), (7, _skip("changes requested by carol"))],
        bot_login="gl[bot]",
        get_pr=get_pr,
        upsert_comment=upsert,
    )

    assert [pr for pr, _ in posted] == [(_REPO, 5), (_REPO, 7)]
    for _pr, kwargs in posted:
        assert kwargs["marker"] == RECHECK_REFUSAL_MARKER
        assert kwargs["author_login"] == "gl[bot]"
        # A refusal is standalone, not a run-owned status comment, so it passes no run_id.
        assert "run_id" not in kwargs
    assert "changes requested by bob" in str(posted[0][1]["body"])
    assert "changes requested by carol" in str(posted[1][1]["body"])


def test_post_refusals_swallows_per_pr_failure_and_continues(caplog):
    posted: list[int] = []

    def get_pr(_client, _repo, number):
        if number == 5:
            raise RuntimeError("fetch boom")
        return number

    def upsert(pr, **_kwargs):
        posted.append(pr)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        scan_runner.post_refusals(
            _CLIENT, _REPO, [(5, _skip()), (7, _skip())], bot_login="gl[bot]", get_pr=get_pr, upsert_comment=upsert
        )

    # PR5's post failure is isolated and logged; PR7 still gets its refusal, and nothing is raised.
    assert posted == [7]
    assert "failed to post recheck refusal for PR #5" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_post_refusals_iteration_timeout_propagates():
    def get_pr(_client, _repo, number):
        return number

    def upsert(_pr, **_kwargs):
        raise IterationTimeout("iteration exceeded")

    # IterationTimeout is the per-iteration watchdog signal, not a post failure: it must propagate
    # past the swallow arm rather than being logged and ignored.
    with pytest.raises(IterationTimeout):
        scan_runner.post_refusals(
            _CLIENT, _REPO, [(5, _skip())], bot_login="gl[bot]", get_pr=get_pr, upsert_comment=upsert
        )


def test_post_refusals_skips_non_changes_requested_reason(caplog):
    posted: list[object] = []

    def get_pr(_client, _repo, number):
        return number

    def upsert(pr, **_kwargs):
        posted.append(pr)

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        scan_runner.post_refusals(
            _CLIENT,
            _REPO,
            [(5, ReviewSkip(HUMAN_APPROVED, "approved by bob"))],
            bot_login="gl[bot]",
            get_pr=get_pr,
            upsert_comment=upsert,
        )

    # The "changes requested" body only fits a CHANGES_REQUESTED skip; any other reason must be
    # dropped with a warning, never posted with a body that misdescribes the skip.
    assert posted == []
    assert "unexpected skip reason" in caplog.text


def test_evaluate_pr_iteration_timeout_propagates():
    failed: list[int] = []
    skips: list[tuple[int, ReviewSkip]] = []
    future = cast("Future[tuple[str, str] | ReviewSkip]", _RaisingFuture(IterationTimeout("boom")))

    # IterationTimeout is the soft per-iteration timeout; _evaluate_pr must let it propagate to
    # abort the iteration, not swallow it into `failed` like an ordinary fingerprint error.
    with pytest.raises(IterationTimeout):
        scan_runner._evaluate_pr(
            5,
            future,
            {},
            now=datetime(2026, 1, 1, tzinfo=UTC),
            timeout=timedelta(hours=1),
            failed=failed,
            skips=skips,
            force=False,
        )

    assert failed == []
    assert skips == []
