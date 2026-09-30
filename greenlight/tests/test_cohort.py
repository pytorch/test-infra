from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import pytest

from greenlight import cohort
from greenlight.pr_hash import BOT_LOGINS

if TYPE_CHECKING:
    from collections.abc import Iterable

_HUMAN = "ezyang"


def test_evaluation_cohort_keeps_humans_and_lowercases():
    assert cohort.evaluation_cohort(frozenset({_HUMAN, "OctoCat"})) == frozenset({_HUMAN, "octocat"})


@pytest.mark.parametrize("bot", sorted(BOT_LOGINS))
def test_evaluation_cohort_drops_every_known_bot(bot: str) -> None:
    assert cohort.evaluation_cohort(frozenset({_HUMAN, bot})) == frozenset({_HUMAN})


def test_evaluation_cohort_drops_app_shaped_logins():
    assert cohort.evaluation_cohort(frozenset({_HUMAN, "some-app[bot]"})) == frozenset({_HUMAN})


@pytest.mark.parametrize(
    "login",
    [
        pytest.param(cohort.GREENLIGHT_APP_SLUG, id="bare-slug"),
        pytest.param(cohort.GREENLIGHT_APP_SLUG.upper(), id="uppercased-slug"),
        pytest.param(f"{cohort.GREENLIGHT_APP_SLUG}[bot]", id="rest-app-login"),
    ],
)
def test_evaluation_cohort_never_includes_greenlight_itself(login: str) -> None:
    assert cohort.evaluation_cohort(frozenset({_HUMAN, login})) == frozenset({_HUMAN})


def test_greenlight_slug_is_not_covered_by_the_bot_predicate():
    # The explicit guard is load-bearing, not belt-and-braces: the bare slug merge_rules would
    # name is absent from BOT_LOGINS and carries no [bot] suffix.
    assert cohort.GREENLIGHT_APP_SLUG not in BOT_LOGINS
    assert not cohort.GREENLIGHT_APP_SLUG.endswith("[bot]")


def test_evaluation_cohort_drops_empty_logins():
    assert cohort.evaluation_cohort(frozenset({_HUMAN, ""})) == frozenset({_HUMAN})


def test_evaluation_cohort_of_an_empty_set_is_empty():
    assert cohort.evaluation_cohort(frozenset()) == frozenset()


_AUTHOR = "albanD"
_TORCH = "torch/nn/functional.py"
_DOCS = "docs/source/nn.rst"


@dataclass(frozen=True)
class _Rule:
    approvers: frozenset[str]
    covers_all: bool = False
    paths: frozenset[str] = frozenset()

    def covers(self, files: Iterable[str]) -> bool:
        return set(files) <= self.paths


def test_evaluation_cohort_membership_is_independent_of_eligibility():
    # A cohort member is evaluated; whether that evaluation has authority is assess's answer.
    resolved = cohort.evaluation_cohort(frozenset({_HUMAN, "octocat"}))
    assert resolved == frozenset({_HUMAN, "octocat"})
    rule = _Rule(frozenset({_HUMAN, "octocat"}), covers_all=True)
    assert cohort.assess("octocat", frozenset({_HUMAN}), (rule,), lambda: None).rule is None
    assert cohort.assess(_HUMAN, frozenset({_HUMAN}), (rule,), lambda: None).rule is rule


def test_assess_rules_refuses_greenlight_itself_although_a_catch_all_rule_names_it():
    greenlight_review_bot = _Rule(frozenset({cohort.GREENLIGHT_APP_SLUG}), covers_all=True)
    assert cohort.assess_rules(cohort.GREENLIGHT_APP_SLUG, (greenlight_review_bot,), lambda: None).rule is None


def test_assess_rules_matches_approvers_in_exact_case():
    miscased = _Rule(frozenset({"alband"}), covers_all=True)
    exact = _Rule(frozenset({_AUTHOR}), covers_all=True)

    assert cohort.assess_rules(_AUTHOR, (miscased,), lambda: None).rule is None
    assert cohort.assess_rules(_AUTHOR, (miscased, exact), lambda: None).rule is exact


def test_assess_rules_needs_one_naming_rule_that_covers_every_changed_file():
    torch_only = _Rule(frozenset({_AUTHOR}), paths=frozenset({_TORCH}))
    docs_only = _Rule(frozenset({_AUTHOR}), paths=frozenset({_DOCS}))
    both = _Rule(frozenset({_AUTHOR}), paths=frozenset({_TORCH, _DOCS}))

    assert cohort.assess_rules(_AUTHOR, (torch_only, docs_only), lambda: (_TORCH, _DOCS)).rule is None
    assert cohort.assess_rules(_AUTHOR, (torch_only, docs_only, both), lambda: (_TORCH, _DOCS)).rule is both
