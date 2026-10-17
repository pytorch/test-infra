from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import pytest
from github import GithubException, UnknownObjectException

from greenlight import verdict_labels
from greenlight.constants import (
    GL_APPROVED_LABEL,
    GL_HUMAN_LABEL,
    GL_SUPERSEDED_LABEL,
)

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence


def _label_gone() -> GithubException:
    body = {
        "message": "Label does not exist",
        "documentation_url": "https://docs.github.com/rest/issues/labels#remove-a-label-from-an-issue",
        "status": "404",
    }
    return GithubException(404, body, message="Label does not exist")


class _FakeLabel:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakePR:
    """A PR's labels and the label writes made to it, one entry per write call.

    ``fail`` makes reading the labels, a removal or an add raise.
    """

    def __init__(self, labels: Sequence[str] = (), *, fail: Mapping[str, Exception] | None = None) -> None:
        self._labels = list(labels)
        self._fail = dict(fail or {})
        self.calls: list[tuple[str, ...]] = []

    @property
    def labels(self) -> list[_FakeLabel]:
        self._raise_if_failing("labels")
        return [_FakeLabel(name) for name in self._labels]

    def remove_from_labels(self, label: str) -> None:
        self.calls.append(("remove", label))
        self._raise_if_failing("remove")
        self._labels.remove(label)

    def add_to_labels(self, *labels: str) -> None:
        self.calls.append(("add", *labels))
        self._raise_if_failing("add")
        self._labels.extend(labels)

    def _raise_if_failing(self, step: str) -> None:
        error = self._fail.get(step)
        if error is not None:
            raise error


def test_sync_removes_the_extras_before_it_adds_the_missing_label():
    pr = _FakePR([GL_APPROVED_LABEL, "module: dynamo", GL_HUMAN_LABEL])

    verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls[-1] == ("add", GL_SUPERSEDED_LABEL)
    assert sorted(pr.calls[:-1]) == [("remove", GL_APPROVED_LABEL), ("remove", GL_HUMAN_LABEL)]


def test_sync_adds_every_missing_label_in_one_call_in_sorted_order():
    pr = _FakePR(["triaged"])

    verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL, GL_HUMAN_LABEL}), number=7)

    assert pr.calls == [("add", GL_HUMAN_LABEL, GL_SUPERSEDED_LABEL)]


def test_sync_makes_its_one_add_call_after_the_removals():
    pr = _FakePR([GL_APPROVED_LABEL])

    verdict_labels.sync_labels(pr, frozenset({GL_HUMAN_LABEL, GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls == [("remove", GL_APPROVED_LABEL), ("add", GL_HUMAN_LABEL, GL_SUPERSEDED_LABEL)]


def test_sync_that_only_removes_makes_no_add_call():
    pr = _FakePR([GL_APPROVED_LABEL, GL_SUPERSEDED_LABEL])

    verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls == [("remove", GL_APPROVED_LABEL)]


def test_sync_leaves_exactly_the_desired_greenlight_labels_and_a_second_sync_writes_nothing():
    pr = _FakePR([GL_HUMAN_LABEL, "triaged", GL_SUPERSEDED_LABEL])
    desired = frozenset({GL_APPROVED_LABEL, GL_SUPERSEDED_LABEL})

    verdict_labels.sync_labels(pr, desired, number=7)

    assert sorted(label.name for label in pr.labels) == [GL_APPROVED_LABEL, GL_SUPERSEDED_LABEL, "triaged"]
    pr.calls.clear()
    verdict_labels.sync_labels(pr, desired, number=7)
    assert pr.calls == []


@pytest.mark.parametrize("held", ["gl/approved", "GL/APPROVED", "Gl/Approved"])
def test_sync_counts_a_differently_cased_label_as_present(held):
    pr = _FakePR([held, "ciflow/trunk"])

    verdict_labels.sync_labels(pr, frozenset({GL_APPROVED_LABEL}), number=7)

    assert pr.calls == []


def test_sync_removes_a_differently_cased_extra_by_the_name_it_read():
    pr = _FakePR(["gl/Human"])

    verdict_labels.sync_labels(pr, frozenset({GL_APPROVED_LABEL}), number=7)

    assert pr.calls == [("remove", "gl/Human"), ("add", GL_APPROVED_LABEL)]


def test_sync_never_touches_a_label_that_is_not_one_of_greenlights():
    others = ["Stale", "Reverted", "ciflow/trunk", "GL/other", "release notes: dynamo"]
    pr = _FakePR([*others, GL_HUMAN_LABEL])

    verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls == [("remove", GL_HUMAN_LABEL), ("add", GL_SUPERSEDED_LABEL)]
    assert [label.name for label in pr.labels] == [*others, GL_SUPERSEDED_LABEL]


def test_sync_writes_and_logs_nothing_when_the_labels_already_match(caplog):
    pr = _FakePR([GL_SUPERSEDED_LABEL, "triaged", GL_APPROVED_LABEL])

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict_labels.sync_labels(pr, frozenset({GL_APPROVED_LABEL, GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls == []
    assert caplog.records == []


def test_sync_logs_the_labels_it_changed(caplog):
    pr = _FakePR([GL_APPROVED_LABEL])

    with caplog.at_level(logging.INFO, logger="greenlight"):
        verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    [record] = caplog.records
    assert record.levelno == logging.INFO
    assert "PR #7" in record.getMessage()
    assert GL_APPROVED_LABEL in record.getMessage()
    assert GL_SUPERSEDED_LABEL in record.getMessage()


def test_sync_counts_a_label_already_gone_as_removed_and_goes_on():
    pr = _FakePR([GL_APPROVED_LABEL], fail={"remove": _label_gone()})

    verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    assert pr.calls == [("remove", GL_APPROVED_LABEL), ("add", GL_SUPERSEDED_LABEL)]


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(UnknownObjectException(404, {"message": "Not Found"}), id="not-found"),
        pytest.param(GithubException(404, None), id="404-without-a-body"),
        pytest.param(GithubException(404, "Label does not exist"), id="404-with-a-non-json-body"),
        pytest.param(GithubException(422, {"message": "Label does not exist"}), id="label-gone-message-on-a-422"),
        pytest.param(GithubException(500, {"message": "Server Error"}), id="server-error"),
    ],
)
def test_sync_raises_any_other_removal_failure_before_adding(error):
    pr = _FakePR([GL_APPROVED_LABEL], fail={"remove": error})

    with pytest.raises(GithubException) as raised:
        verdict_labels.sync_labels(pr, frozenset({GL_SUPERSEDED_LABEL}), number=7)

    assert raised.value is error
    assert pr.calls == [("remove", GL_APPROVED_LABEL)]
