from __future__ import annotations

import logging
import subprocess

import pytest

from bosco import github


@pytest.mark.parametrize(
    ('checks', 'expected'),
    [
        (github.Checks(passed=1, skipped=0, pending=0, failed=0), github.Status.PASS),
        (github.Checks(passed=1, skipped=1, pending=0, failed=0), github.Status.PASS),
        (
            github.Checks(passed=1, skipped=1, pending=1, failed=0),
            github.Status.PENDING,
        ),
        (github.Checks(passed=1, skipped=1, pending=1, failed=1), github.Status.FAIL),
    ],
)
def test_checks(checks: github.Checks, expected: github.Status) -> None:
    assert checks.status == expected


@pytest.mark.parametrize(
    ('repo', 'expected'),
    [
        (github.Repository('pytorch', 'pytorch'), 'pytorch/pytorch'),
        (github.Repository('example', 'repo'), 'example/repo'),
    ],
)
def test_repo(repo: github.Repository, expected: str) -> None:
    assert str(repo) == expected


@pytest.mark.parametrize(
    ('pr', 'expected'),
    [
        (
            github.PR(github.Repository('pytorch', 'pytorch'), 777),
            'https://github.com/pytorch/pytorch/pull/777',
        ),
        (
            github.PR(github.Repository('example', 'repo'), 88),
            'https://github.com/example/repo/pull/88',
        ),
    ],
)
def test_pr_url(pr: github.PR, expected: str) -> None:
    assert pr.url == expected


@pytest.mark.parametrize(('stderr', 'expected'), [('some contents', True), ('', False)])
def test_log_completed_process(
    stderr: str, expected: bool, caplog: pytest.LogCaptureFixture
) -> None:
    proc = subprocess.CompletedProcess(
        args=['meh', 'blah'],
        returncode=7,
        stdout='irrelevant',
        stderr=stderr,
    )
    caplog.set_level(logging.INFO)
    github._log_completed_process(logging.INFO, proc)
    (record,) = caplog.records
    assert ('stderr' in record.message) == expected
