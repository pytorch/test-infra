from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, cast

import pytest

from greenlight import github_client, land_approval

if TYPE_CHECKING:
    from github.Commit import Commit

    from greenlight.github_types import VerdictClient, VerdictPR

_BOT = "greenlight-app[bot]"
_REPO = "pytorch/vision"
_HEAD = "a" * 40
_OLD = "b" * 40
_NEW = "c" * 40


class _Review:
    def __init__(self, id: int, login: str, state: str, commit_id: str | None, events: list[str]) -> None:
        self.id = id
        self.user = SimpleNamespace(login=login, type="Bot")
        self.state = state
        self.commit_id = commit_id
        self._events = events
        self.dismissed_with: str | None = None
        self.dismiss_error: Exception | None = None

    def dismiss(self, message: str) -> None:
        self._events.append(f"dismiss:{self.id}")
        if self.dismiss_error is not None:
            raise self.dismiss_error
        self.dismissed_with = message
        self.state = "DISMISSED"


class _PR:
    """A PR whose reviews GitHub lists in order; an approval it creates joins them."""

    def __init__(
        self,
        events: list[str],
        *,
        head: str = _HEAD,
        base: str = "main",
        reviews: list[_Review] | None = None,
        trunk: str | None = None,
    ) -> None:
        self.head = SimpleNamespace(sha=head, ref="feature")
        self.base = SimpleNamespace(ref=base)
        self.raw_data: dict[str, object] = {} if trunk is None else {"stack": {"base": {"ref": trunk}}}
        self.reviews = reviews if reviews is not None else []
        self._events = events
        self.pinned: list[str] = []

    def get_reviews(self) -> list[_Review]:
        return list(self.reviews)

    def create_review(self, *, commit: Commit, body: str, event: str) -> _Review:
        self._events.append(f"approve:{commit.sha}")
        self.pinned.append(commit.sha)
        review = _Review(100 + len(self.pinned), _BOT, "APPROVED", commit.sha, self._events)
        self.reviews.append(review)
        return review


class _Client:
    """Serves the PR the verdict holds; the re-read returns ``fresh`` (or raises ``reread_error``)."""

    def __init__(self, events: list[str], fresh: _PR | None = None, reread_error: Exception | None = None) -> None:
        self._events = events
        self.fresh = fresh
        self.reread_error = reread_error

    def get_repo(self, name: str) -> _Client:
        assert name == _REPO
        return self

    def get_commit(self, sha: str) -> Commit:
        return cast("Commit", SimpleNamespace(sha=sha))

    def get_pull(self, number: int) -> _PR:
        self._events.append(f"reread:{number}")
        if self.reread_error is not None:
            raise self.reread_error
        assert self.fresh is not None
        return self.fresh


def _approve(client: _Client, pr: _PR, *, strict_base: bool = True, bot_login: str = _BOT) -> None:
    land_approval.approve(
        cast("VerdictClient", client),
        cast("VerdictPR", cast("Any", pr)),
        repo=_REPO,
        number=7,
        head_sha=_HEAD,
        bot_login=bot_login,
        strict_base=strict_base,
    )


def test_the_approval_is_pinned_to_the_reviewed_head_and_confirmed_by_a_fresh_read(caplog):
    events: list[str] = []
    pr = _PR(events)
    client = _Client(events, fresh=_PR(events, reviews=pr.reviews))

    with caplog.at_level(logging.INFO, logger="greenlight"):
        _approve(client, pr)

    assert pr.pinned == [_HEAD]
    assert events == [f"approve:{_HEAD}", "reread:7"]
    assert pr.reviews[0].state == "APPROVED"
    assert f"approved {_REPO}#7 at {_HEAD}" in caplog.text


def test_live_approvals_all_on_the_reviewed_head_are_left_as_they_are(caplog):
    events: list[str] = []
    standing = [
        _Review(1, _BOT, "APPROVED", _HEAD, events),
        _Review(2, "GreenLight-App[Bot]", "APPROVED", _HEAD, events),
    ]
    pr = _PR(events, reviews=standing)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        _approve(_Client(events), pr)

    # Nothing to re-read either: no approval was posted.
    assert events == []
    assert f"already approved {_REPO}#7 at {_HEAD}; skipping re-approval" in caplog.text


def test_a_live_approval_on_another_commit_dismisses_them_all_and_approves_again_pinned():
    events: list[str] = []
    standing = [_Review(1, _BOT, "APPROVED", _HEAD, events), _Review(2, _BOT, "APPROVED", _OLD, events)]
    others = [_Review(3, "alice", "APPROVED", _OLD, events), _Review(4, _BOT, "COMMENTED", _OLD, events)]
    pr = _PR(events, reviews=[*standing, *others])

    _approve(_Client(events, fresh=_PR(events, reviews=pr.reviews)), pr)

    assert events == ["dismiss:1", "dismiss:2", f"approve:{_HEAD}", "reread:7"]
    assert [review.dismissed_with for review in standing] == [land_approval.SUPERSEDED_MESSAGE] * 2
    assert [review.dismissed_with for review in others] == [None, None]


def test_a_live_approval_on_an_unknown_commit_is_dismissed_and_replaced():
    events: list[str] = []
    pr = _PR(events, reviews=[_Review(1, _BOT, "APPROVED", None, events)])

    _approve(_Client(events, fresh=_PR(events, reviews=pr.reviews)), pr)

    assert events == ["dismiss:1", f"approve:{_HEAD}", "reread:7"]


def test_a_head_that_moved_by_the_re_read_dismisses_greenlights_approvals(caplog):
    events: list[str] = []
    pr = _PR(events)
    fresh = _PR(events, head=_NEW, reviews=pr.reviews)

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        _approve(_Client(events, fresh=fresh), pr)

    assert events == [f"approve:{_HEAD}", "reread:7", "dismiss:101"]
    assert pr.reviews[0].dismissed_with == land_approval.MOVED_MESSAGE
    assert f"head {_HEAD} -> {_NEW}, base 'main' -> 'main'" in caplog.text


@pytest.mark.parametrize(
    ("fresh", "strict_base", "dismissed"),
    [
        pytest.param({"base": "release/2.9"}, False, True, id="pytorchbot-retarget-off-main"),
        pytest.param({"base": "alice/part-1", "trunk": "main"}, True, True, id="gate-native-stack-on-main"),
        pytest.param({"base": "alice/part-1", "trunk": "main"}, False, False, id="pytorchbot-native-stack-on-main"),
        pytest.param({"base": "main"}, False, False, id="pytorchbot-native-stack-retargeted-to-main"),
        pytest.param({"base": "main"}, True, False, id="gate-still-on-main"),
    ],
)
def test_a_base_the_repos_rule_refuses_by_the_re_read_dismisses_greenlights_approvals(fresh, strict_base, dismissed):
    events: list[str] = []
    pr = _PR(events, base="alice/part-1", trunk="main") if not strict_base else _PR(events)
    re_read = _PR(events, reviews=pr.reviews, **fresh)

    _approve(_Client(events, fresh=re_read), pr, strict_base=strict_base)

    # A gate repo accepts only main; on pytorch a native stack retargeted to main keeps its approval.
    assert events == [f"approve:{_HEAD}", "reread:7", *(["dismiss:101"] if dismissed else [])]


def test_a_failed_re_read_dismisses_the_approval_just_posted_then_raises(caplog):
    events: list[str] = []
    standing = _Review(1, "alice", "APPROVED", _HEAD, events)
    pr = _PR(events, reviews=[standing])

    with caplog.at_level(logging.WARNING, logger="greenlight"), pytest.raises(RuntimeError, match="502"):
        _approve(_Client(events, reread_error=RuntimeError("502")), pr)

    assert events == [f"approve:{_HEAD}", "reread:7", "dismiss:101"]
    assert pr.reviews[1].dismissed_with == land_approval.UNCONFIRMED_MESSAGE
    assert standing.dismissed_with is None
    assert f"dismissed the approval just posted on {_REPO}#7" in caplog.text


def test_a_failed_dismissal_after_a_failed_re_read_is_logged_and_the_read_error_raised(caplog, monkeypatch):
    events: list[str] = []
    pr = _PR(events)
    posted: list[_Review] = []
    real_post = github_client.post_review

    def post_then_break_dismissal(*args: Any, **kwargs: Any) -> Any:
        review = real_post(*args, **kwargs)
        cast("_Review", review).dismiss_error = RuntimeError("dismiss 403")
        posted.append(cast("_Review", review))
        return review

    monkeypatch.setattr(github_client, "post_review", post_then_break_dismissal)

    with caplog.at_level(logging.ERROR, logger="greenlight"), pytest.raises(RuntimeError, match="read 502"):
        _approve(_Client(events, reread_error=RuntimeError("read 502")), pr)

    assert events == [f"approve:{_HEAD}", "reread:7", "dismiss:101"]
    [record] = [r for r in caplog.records if "cannot dismiss the approval just posted" in r.getMessage()]
    assert record.exc_info is not None
    assert str(record.exc_info[1]) == "dismiss 403"


@pytest.mark.parametrize("stage", ["supersede", "moved"])
def test_a_failed_dismissal_raises(stage):
    events: list[str] = []
    if stage == "supersede":
        stale = _Review(1, _BOT, "APPROVED", _OLD, events)
        pr = _PR(events, reviews=[stale])
        stale.dismiss_error = RuntimeError("dismiss 403")
        client = _Client(events)
    else:
        pr = _PR(events)
        client = _Client(events, fresh=_PR(events, head=_NEW, reviews=pr.reviews))
        original = pr.create_review

        def create_unremovable(**kwargs: Any) -> _Review:
            review = original(**kwargs)
            review.dismiss_error = RuntimeError("dismiss 403")
            return review

        pr.create_review = create_unremovable  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="dismiss 403"):
        _approve(client, pr)

    assert events[-1].startswith("dismiss:")


def test_a_failed_approval_raises_and_reads_nothing_more():
    events: list[str] = []

    class _Refusing(_PR):
        def create_review(self, *, commit: Commit, body: str, event: str) -> _Review:
            raise RuntimeError("approve 422")

    with pytest.raises(RuntimeError, match="approve 422"):
        _approve(_Client(events), _Refusing(events))

    assert events == []


def test_dismiss_prior_logs_what_it_dismissed(caplog):
    events: list[str] = []
    pr = _PR(events, reviews=[_Review(1, _BOT, "APPROVED", _OLD, events)])

    with caplog.at_level(logging.INFO, logger="greenlight"):
        land_approval.dismiss_prior(cast("VerdictPR", cast("Any", pr)), repo=_REPO, number=7, bot_login=_BOT)
        land_approval.dismiss_prior(cast("VerdictPR", cast("Any", pr)), repo=_REPO, number=7, bot_login=_BOT)

    assert f"dismissed 1 prior greenlight approval(s) on {_REPO}#7" in caplog.text
    assert f"no prior greenlight approval to dismiss on {_REPO}#7" in caplog.text
