from __future__ import annotations

import logging

import pytest

from greenlight import authority, cohort, merge_authz

_CATCH_ALL_AUTHOR = "albanD"
_SCOPED_AUTHOR = "carol"
_CATCH_ALL = merge_authz.compile_rule("superuser", ["*"], frozenset({_CATCH_ALL_AUTHOR}))
_DOCS = merge_authz.compile_rule("docs", ["docs/**"], frozenset({_SCOPED_AUTHOR}))
_RULES = (_CATCH_ALL, _DOCS)


@pytest.mark.parametrize(
    ("login", "expected"),
    [
        pytest.param(_CATCH_ALL_AUTHOR, _CATCH_ALL, id="catch-all"),
        pytest.param(_SCOPED_AUTHOR, _DOCS, id="path-scoped"),
        pytest.param(_CATCH_ALL_AUTHOR.upper(), None, id="named-only-in-another-case"),
        pytest.param("mallory", None, id="named-by-no-rule"),
        pytest.param(None, None, id="no-author"),
    ],
)
def test_eligible_rule_logs_every_assessed_prs_reason_and_never_a_rule_name(caplog, login, expected):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        rule = authority.eligible_rule(7, login, _RULES)

    # The scan's logs are public, and which rule matched could reveal a concealed team membership.
    reason = cohort.assess_rules(login, _RULES).reason
    assert rule is expected
    (record,) = caplog.records
    assert record.levelno == logging.INFO
    assert record.getMessage() == f"PR #7 by {login}: {reason}"
    assert _CATCH_ALL.name not in caplog.text
    assert _DOCS.name not in caplog.text


def _authority(
    authors: dict[int, str | None],
    *,
    recorded: frozenset[int] = frozenset(),
    target: authority.Target | None = None,
) -> authority.Authority:
    return authority.Authority(rules=_RULES, authors=authors, recorded=recorded, target=target)


def test_authority_is_shadow_unless_a_valid_rule_names_the_listed_author():
    judge = _authority({1: _CATCH_ALL_AUTHOR, 2: _SCOPED_AUTHOR, 3: "mallory", 4: None})

    # 5 stands for a PR listed on a base trymerge refuses: the listing hands no author for it.
    assert [judge.shadow(number) for number in (1, 2, 3, 4, 5)] == [False, False, True, True, True]


def test_authority_judges_each_pr_once_per_pass(caplog):
    judge = _authority({1: _SCOPED_AUTHOR})

    with caplog.at_level(logging.INFO, logger="greenlight"):
        assert judge.shadow(1) is False
        assert judge.shadow(1) is False

    assert len(caplog.records) == 1


def test_authority_keeps_the_pr_gates_answer_for_its_target():
    judge = _authority({}, target=authority.Target(9, _CATCH_ALL_AUTHOR, shadow=True))

    assert judge.shadow(9) is True


def test_a_recorded_prs_reverted_row_is_never_shadow():
    judge = _authority({1: "mallory", 2: "mallory"}, recorded=frozenset({1, 3}))

    assert judge.reverted_shadow(1) is False
    assert judge.reverted_shadow(2) is True
    assert judge.reverted_shadow(3) is False
