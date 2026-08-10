"""Parse vLLM Buildkite job logs into structured failure signatures.

Vendored from the vllm-pytorch-ci-triage package (parse_log/strip_markers + the
dataclasses they need). Strips ANSI escape codes and BKT timestamp markers, then
extracts per-test signatures: test id, exception class/message, and the raw section
body from pytest's FAILURES block. Extraction is position-independent -- a failure
far from the end of a huge log is still captured.
"""

import re
from dataclasses import dataclass, field


@dataclass
class FailedTest:
    """A single failed test with its exception signature."""

    test_id: str
    pytest_exception_class: str = (
        ""  # The exception class pytest named on its inline FAILED/ERROR summary line.
    )
    exception_chain: str = ""  # This test's own FAILURES section body
    inline_message: str = ""
    test_is_infra: bool = False


@dataclass
class PytestResult:
    """One pytest session's output within a Buildkite job log."""

    test_failures: list[FailedTest] = field(default_factory=list)
    pytest_summary: str = ""
    expected_test_failure_count: int | None = None


@dataclass
class ParsedLog:
    """Parsed log output from a Buildkite job.

    Either pytest_results is populated (pytest failures) or error_excerpt holds the
    whole cleaned log (a build/crash before pytest ran).
    """

    pytest_results: list[PytestResult] = field(default_factory=list)
    error_excerpt: str = ""
    job_is_infra: bool = False


TIMESTAMP_RE = re.compile(r"^\[[\d\-T:Z]+\]\s*")
FAILED_TEST_RE = re.compile(r"^(?:FAILED|ERROR)\s+(\S+/\S*\.py\S*)")
PYTEST_SUMMARY_RE = re.compile(
    r"=+\s+.*\d+\s+(?:failed|error|passed|skipped|warning|deselected).*\bin\s+\d.*=+"
)
SUMMARY_FAILED_COUNT_RE = re.compile(r"(\d+)\s+failed")
SUMMARY_ERROR_COUNT_RE = re.compile(r"(\d+)\s+error")
TEST_SECTION_HEADER_RE = re.compile(r"_{1,}\s+(.+?)\s+_{1,}")

# The inline path trusts pytest: the text after " - " on a FAILED/ERROR line is
# ExceptionInfo.exconly() output -- "{ExcClass}: {message}". The message is
# optional: exconly() emits a bare class name when the exception has no message.
FAILED_INLINE_EXC_RE = re.compile(
    r"(?:FAILED|ERROR)\s+(.+?)\s+-\s+"
    r"([A-Za-z_][\w.]*(?:::[\w.]+)*)"
    r"(?::\s*(.*))?"
)
FAILED_INLINE_ASSERT_RE = re.compile(r"(?:FAILED|ERROR)\s+(.+?)\s+-\s+(assert\s+.*)")

INFRA_PATTERNS = [
    re.compile(r"nvidia-container-cli", re.IGNORECASE),
    re.compile(r"CUDA driver initialization failed", re.IGNORECASE),
    re.compile(r"exit status 137"),
    re.compile(r"exit(?:ed with)? status 125", re.IGNORECASE),
    re.compile(r"Free memory on device cuda:\d+.*less than desired"),
    re.compile(r"docker.*pull", re.IGNORECASE),
    re.compile(r"command hook exited with status", re.IGNORECASE),
    re.compile(r"toomanyrequests", re.IGNORECASE),
    re.compile(r"Data limit exceeded", re.IGNORECASE),
    re.compile(r"Connection refused", re.IGNORECASE),
    re.compile(r"no space left on device", re.IGNORECASE),
    re.compile(r"manifest unknown", re.IGNORECASE),
    re.compile(r"not found: manifest", re.IGNORECASE),
]


def strip_markers(text: str) -> str:
    """Remove escape sequences from raw Buildkite log text.

    Filters:
        - ANSI CSI sequences (\\x1b[...): colors, cursor movement, erase-to-EOL
        - BKT timestamp markers (\\x1b_bk;t=<ms>\\x07)
        - OSC sequences (\\x1b]...\\x07): inline images (1338), hyperlinks (1339)
    """
    ansi_regex = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
    osc_regex = re.compile(r"\x1b[\]_][^\x07]*\x07")
    return osc_regex.sub("", ansi_regex.sub("", text))


def parse_log(text: str) -> ParsedLog:
    """Clean a raw log and extract structured failure information.

    Args:
        text: Raw log text from Buildkite.

    Returns:
        Parsed log with extracted failure signatures.
    """
    cleaned = strip_markers(text)
    lines = cleaned.splitlines()

    extraction = _extract_pytest_failures(lines)

    if not extraction.pytest_results:
        return ParsedLog(error_excerpt=cleaned, job_is_infra=_matches_infra(cleaned))

    for pytest_result in extraction.pytest_results:
        for failure in pytest_result.test_failures:
            # Both fields hold only what pytest scoped to this specific test:
            #   - pytest_exception_class: the class pytest named on the inline
            #     FAILED/ERROR summary line (set at construction); empty otherwise.
            #   - exception_chain: this test's own FAILURES section body.
            section_body = _get_section_body(failure.test_id, extraction.section_bodies)
            if section_body is not None:
                failure.exception_chain = section_body
            elif failure.pytest_exception_class:
                failure.exception_chain = (
                    f"{failure.pytest_exception_class}: {failure.inline_message}"
                )
        for failure in pytest_result.test_failures:
            failure.test_is_infra = _matches_infra(failure.exception_chain)

    return ParsedLog(pytest_results=extraction.pytest_results)


def _normalize_test_id(test_id: str) -> str:
    """Reduce a test id to the node pytest names its FAILURES section by.

    ``distributed/test_elastic_ep.py::test_scaling_uneven`` -> ``test_scaling_uneven``
    ``suite.py::TestClass::test_method`` -> ``TestClass.test_method`` (pytest joins the
    class and method with a dot in the section header).
    """
    _, separator, node = test_id.partition(".py::")
    node = node if separator else test_id
    return node.replace("::", ".")


def _match_section_name(test_id: str, section_names: list[str]) -> str | None:
    """Resolve which FAILURES section belongs to a test id.

    Both the section header and the ``FAILED`` line come from the same pytest run, so
    the header names the test's node exactly. Matching exactly (not by substring) keeps
    a test whose name prefixes another's (``test_scaling`` vs ``test_scaling_uneven``)
    from stealing its section.
    """
    node = _normalize_test_id(test_id)
    for section_name in section_names:
        if section_name == node:
            return section_name
    return None


def _get_section_body(
    test_id: str,
    section_bodies: dict[str, str],
) -> str | None:
    section_name = _match_section_name(test_id, list(section_bodies))
    return section_bodies[section_name] if section_name is not None else None


class _ExtractionResult:
    """Internal container for extraction output."""

    def __init__(self) -> None:
        self.pytest_results: list[PytestResult] = []
        self.section_bodies: dict[str, str] = {}


def _extract_pytest_failures(lines: list[str]) -> _ExtractionResult:
    """Scan lines, extract pytest sessions and per-test FAILURES section bodies."""
    result = _ExtractionResult()
    current_failures: list[FailedTest] = []
    current_section: str = ""
    section_start: int = -1

    for line_index, line in enumerate(lines):
        stripped = TIMESTAMP_RE.sub("", line).strip()

        section_match = TEST_SECTION_HEADER_RE.search(stripped)
        if section_match:
            name = section_match.group(1).strip()
            if re.search(r"[a-zA-Z0-9]", name):
                _save_section_body(
                    result, current_section, section_start, line_index, lines
                )
                current_section = name
                section_start = line_index + 1
                continue

        if _is_equals_boundary(stripped):
            _save_section_body(
                result, current_section, section_start, line_index, lines
            )
            current_section = ""
            section_start = -1

        # Assert first: the permissive inline regex would otherwise capture
        # "assert" as the class from a rewritten-assertion "- assert x == y" line.
        assert_match = FAILED_INLINE_ASSERT_RE.search(stripped)
        inline_exc_match = (
            None if assert_match else FAILED_INLINE_EXC_RE.search(stripped)
        )
        if inline_exc_match:
            failed_test = FailedTest(
                test_id=inline_exc_match.group(1),
                pytest_exception_class=inline_exc_match.group(2),
                inline_message=(inline_exc_match.group(3) or "").strip(),
            )
            current_failures.append(failed_test)
        elif assert_match:
            failed_test = FailedTest(
                test_id=assert_match.group(1),
                pytest_exception_class="AssertionError",
                inline_message=assert_match.group(2).strip(),
            )
            current_failures.append(failed_test)
        else:
            bare_failed_match = FAILED_TEST_RE.search(stripped)
            if bare_failed_match:
                failed_test = FailedTest(
                    test_id=bare_failed_match.group(1),
                )
                current_failures.append(failed_test)

        if PYTEST_SUMMARY_RE.search(stripped):
            # Record the summary's count.
            expected_count = _parse_summary_count(line.strip())
            result.pytest_results.append(
                PytestResult(
                    test_failures=current_failures,
                    pytest_summary=line.strip(),
                    expected_test_failure_count=expected_count,
                )
            )
            current_failures = []
            current_section = ""
            section_start = -1

    if current_failures:
        result.pytest_results.append(
            PytestResult(
                test_failures=current_failures,
                expected_test_failure_count=None,
            )
        )

    return result


def _is_equals_boundary(stripped: str) -> bool:
    return len(stripped) > 20 and stripped.startswith("=") and stripped.endswith("=")


def _save_section_body(
    result: _ExtractionResult,
    section_name: str,
    start: int,
    end: int,
    lines: list[str],
) -> None:
    if not section_name or start < 0:
        return
    body_lines = []
    for i in range(start, end):
        cleaned = TIMESTAMP_RE.sub("", lines[i]).rstrip()
        body_lines.append(cleaned)
    body = "\n".join(body_lines).strip()
    if body:
        result.section_bodies[section_name] = body


def _matches_infra(text: str) -> bool:
    """
    Return True for a confirmed transient (retryable) infra signature.
    """

    return any(pattern.search(text) for pattern in INFRA_PATTERNS)


def _parse_summary_count(summary: str) -> int:
    count = 0
    failed_match = SUMMARY_FAILED_COUNT_RE.search(summary)
    if failed_match:
        count += int(failed_match.group(1))
    error_match = SUMMARY_ERROR_COUNT_RE.search(summary)
    if error_match:
        count += int(error_match.group(1))
    return count
