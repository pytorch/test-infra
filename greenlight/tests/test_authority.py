from __future__ import annotations

import logging

import pytest

from greenlight import authority, cohort, merge_authz

_CATCH_ALL_AUTHOR = "albanD"
_SCOPED_AUTHOR = "carol"
_CATCH_ALL = merge_authz.compile_rule("superuser", ["*"], frozenset({_CATCH_ALL_AUTHOR}))
_DOCS = merge_authz.compile_rule("docs", ["docs/**"], frozenset({_SCOPED_AUTHOR}))
_RULES = (_CATCH_ALL, _DOCS)
_LISTED = frozenset({_CATCH_ALL_AUTHOR.lower(), _SCOPED_AUTHOR})
_DOCS_FILE = "docs/source/index.rst"
_TORCH_FILE = "torch/nn/functional.py"


@pytest.mark.parametrize(
    ("login", "changed", "expected"),
    [
        pytest.param(_CATCH_ALL_AUTHOR, None, _CATCH_ALL, id="catch-all"),
        pytest.param(_SCOPED_AUTHOR, (_DOCS_FILE,), _DOCS, id="path-scoped-in-scope"),
        pytest.param(_SCOPED_AUTHOR, (_DOCS_FILE, _TORCH_FILE), None, id="path-scoped-out-of-scope"),
    ],
)
def test_covering_rule_logs_the_listed_authors_reason_and_never_a_rule_name(caplog, login, changed, expected):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        rule = authority.covering_rule(7, login, _LISTED, _RULES, lambda: changed)

    # The scan's logs are public, and which rule matched could reveal a concealed team membership.
    reason = cohort.assess(login, _LISTED, _RULES, lambda: changed).reason
    assert rule is expected
    (record,) = caplog.records
    assert record.getMessage() == f"PR #7 by {login}: {reason}"
    assert _CATCH_ALL.name not in caplog.text
    assert _DOCS.name not in caplog.text
