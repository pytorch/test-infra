from __future__ import annotations

from dataclasses import dataclass

import pytest

from greenlight import cohort, merge_authz
from greenlight.pr_hash import BOT_LOGINS

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


@dataclass(frozen=True)
class _Rule:
    approvers: frozenset[str]
    valid: bool = True


def test_evaluation_cohort_membership_is_independent_of_eligibility():
    # A cohort member is evaluated; whether that evaluation has authority is assess_rules's answer.
    resolved = cohort.evaluation_cohort(frozenset({_HUMAN, "octocat"}))
    assert resolved == frozenset({_HUMAN, "octocat"})
    rule = _Rule(frozenset({_HUMAN}))
    assert cohort.assess_rules("octocat", (rule,)).rule is None
    assert cohort.assess_rules(_HUMAN, (rule,)).rule is rule


def test_assess_rules_refuses_greenlight_itself_although_a_rule_names_it():
    greenlight_review_bot = _Rule(frozenset({cohort.GREENLIGHT_APP_SLUG}))
    assert cohort.assess_rules(cohort.GREENLIGHT_APP_SLUG, (greenlight_review_bot,)) == (
        None,
        "excluded (bot or greenlight)",
    )


def test_assess_rules_refuses_a_missing_author():
    assert cohort.assess_rules(None, (_Rule(frozenset({_AUTHOR})),)) == (None, "no author")
    assert cohort.assess_rules("", (_Rule(frozenset({_AUTHOR})),)) == (None, "no author")


def test_assess_rules_matches_approvers_in_exact_case():
    miscased = _Rule(frozenset({"alband"}))
    exact = _Rule(frozenset({_AUTHOR}))

    assert cohort.assess_rules(_AUTHOR, (miscased,)) == (
        None,
        f"no merge rule names {_AUTHOR!r} in exact case; a rule names 'alband'",
    )
    assert cohort.assess_rules(_AUTHOR, (miscased, exact)) == (exact, "eligible")


def test_assess_rules_accepts_any_valid_rule_naming_the_author_whatever_its_paths():
    docs_only = merge_authz.compile_rule("docs", ["docs/**"], frozenset({_AUTHOR}))

    assert cohort.assess_rules(_AUTHOR, (docs_only,)) == (docs_only, "eligible")


def test_assess_rules_never_qualifies_a_login_named_only_by_an_invalid_rule():
    broken = merge_authz.compile_rule("broken", ["docs/{a,b}/**"], frozenset({_AUTHOR}))
    assert not broken.valid

    # The case-variant hint ignores the invalid rule too: it could not qualify the variant either.
    assert cohort.assess_rules(_AUTHOR, (broken,)) == (None, f"no merge rule names {_AUTHOR!r} in exact case")
    assert (
        cohort.assess_rules(_AUTHOR.lower(), (broken,)).reason
        == f"no merge rule names {_AUTHOR.lower()!r} in exact case"
    )
