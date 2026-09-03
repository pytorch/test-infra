import pytest

from greenlight import cohort

# The authorization boundary the two authz gates enforce. Pinned here so widening it is a
# deliberate two-place edit rather than a typo.
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
