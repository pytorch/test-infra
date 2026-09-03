import pytest

from greenlight import cohort
from greenlight.pr_hash import BOT_LOGINS

_HUMAN = "ezyang"

# The approval authority boundary: everyone outside it is evaluated in shadow. Pinned here so
# widening it is a deliberate two-place edit rather than a typo.
_PINNED_TRUSTED_AUTHORS = {
    "albanD",
    "jathu",
    "atalman",
    "huydhn",
    "izaitsevfb",
    "georgehong",
    "jeanschmidt",
    "ezyang",
    "drisspg",
    "janeyx99",
    "bobrenjc93",
}


def test_trusted_authors_membership_is_pinned():
    assert cohort.TRUSTED_AUTHORS == _PINNED_TRUSTED_AUTHORS


def test_trusted_lower_is_lowercase_and_collision_free():
    # A pair of authors differing only in case would silently shrink the gate by one.
    assert all(login == login.lower() for login in cohort._TRUSTED_LOWER)
    assert len(cohort._TRUSTED_LOWER) == len(cohort.TRUSTED_AUTHORS)


@pytest.mark.parametrize(
    ("login", "expected"),
    [
        pytest.param("ezyang", True, id="exact-login"),
        pytest.param("EZYANG", True, id="uppercased"),
        pytest.param("albanD", True, id="canonical-mixed-case"),
        pytest.param("aLBAnd", True, id="mixed-case-login-cased-differently"),
        pytest.param("octocat", False, id="stranger"),
        pytest.param("", False, id="empty"),
        pytest.param(None, False, id="absent"),
    ],
)
def test_is_trusted(login: str | None, expected: bool) -> None:
    assert cohort.is_trusted(login) is expected


@pytest.mark.parametrize(
    ("login", "expected"),
    [
        pytest.param("ezyang", False, id="trusted-author"),
        pytest.param("EZYANG", False, id="trusted-author-uppercased"),
        pytest.param("octocat", True, id="stranger"),
        pytest.param("", True, id="empty"),
        pytest.param(None, True, id="absent-fails-closed"),
    ],
)
def test_is_shadow(login: str | None, expected: bool) -> None:
    assert cohort.is_shadow(login) is expected


def test_is_shadow_is_the_complement_of_is_trusted():
    for login in (*cohort.TRUSTED_AUTHORS, "octocat", "", None):
        assert cohort.is_shadow(login) is not cohort.is_trusted(login)


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


def test_evaluation_cohort_membership_is_independent_of_trust():
    # A cohort member is evaluated; whether that evaluation has authority is is_shadow's answer.
    resolved = cohort.evaluation_cohort(frozenset({_HUMAN, "octocat"}))
    assert resolved == frozenset({_HUMAN, "octocat"})
    assert cohort.is_shadow("octocat") is True
    assert cohort.is_shadow(_HUMAN) is False
