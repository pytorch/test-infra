"""Tests for parse_log/strip_markers against real Buildkite log fixtures.

Log fixtures are tails (~100 lines) from real Buildkite job logs.
raw_log_snippet.bin has ANSI + BKT markers for strip testing.
"""

import unittest
from pathlib import Path

from torchci.vllm_log_parser import get_test_signature, parse_log, strip_markers


FIXTURES_DIR = Path(__file__).parent / "fixtures"


def read_fixture_text(name: str) -> str:
    return (FIXTURES_DIR / name).read_text()


def read_fixture_bytes(name: str) -> bytes:
    return (FIXTURES_DIR / name).read_bytes()


class TestStripMarkers(unittest.TestCase):
    """ANSI escape and BKT timestamp marker removal."""

    def test_strips_ansi_escapes(self) -> None:
        raw = "\x1b[31mFAILED\x1b[0m test_foo"
        self.assertEqual(strip_markers(raw), "FAILED test_foo")

    def test_strips_bkt_timestamps(self) -> None:
        raw = "\x1b_bk;t=1720000000\x07some log line"
        self.assertEqual(strip_markers(raw), "some log line")

    def test_strips_both(self) -> None:
        raw = "\x1b_bk;t=123\x07\x1b[1m\x1b[31mERROR\x1b[0m oops"
        self.assertEqual(strip_markers(raw), "ERROR oops")

    def test_passthrough_clean_text(self) -> None:
        clean = "FAILED tests/test_foo.py::test_bar - AssertionError"
        self.assertEqual(strip_markers(clean), clean)

    def test_strips_group_marker_with_ansi(self) -> None:
        raw = "\x1b_bk;t=1778129393332\x07+++ \x1b[33m:test_tube:\x1b[0m Command (1/1): bash run-test.sh\r"
        cleaned = strip_markers(raw)
        self.assertTrue(cleaned.startswith("+++ "))
        self.assertIn(":test_tube:", cleaned)
        self.assertNotIn("\x1b", cleaned)

    def test_strips_osc_image_and_hyperlink(self) -> None:
        raw = (
            "before"
            "\x1b]1338;url=http://example.com/img.gif;alt=screenshot\x07"
            "middle"
            "\x1b]1339;url=https://google.com;content=Google\x07"
            "after"
        )
        self.assertEqual(strip_markers(raw), "beforemiddleafter")

    def test_strips_progress_bar_with_erase_to_eol(self) -> None:
        raw = (
            "\x1b_bk;t=100\x07remote: Counting objects:   0% (1/163)\x1b[K"
            "\x1b_bk;t=100\x07\rremote: Counting objects:   1% (2/163)\x1b[K"
            "\x1b_bk;t=100\x07\rremote: Counting objects: 100% (163/163)\x1b[K"
            "\x1b_bk;t=100\x07\r\r"
        )
        cleaned = strip_markers(raw)
        self.assertNotIn("\x1b", cleaned)
        self.assertNotIn("\x07", cleaned)
        self.assertIn("remote: Counting objects", cleaned)

    def test_strips_cursor_movement_codes(self) -> None:
        raw = "\x1b_bk;t=123\x07\x1b[?25h\x1b[1A\x1b[0G\x1b[?25l[+] Building 0.2s (1/2)  docker:default"
        cleaned = strip_markers(raw)
        self.assertNotIn("\x1b", cleaned)
        self.assertIn("[+] Building 0.2s (1/2)", cleaned)

    def test_strips_cursor_only_line(self) -> None:
        raw = "\x1b_bk;t=123\x07\x1b[1A\x1b[1B\x1b[0G\x1b[?25l\r\r"
        cleaned = strip_markers(raw)
        self.assertNotIn("\x1b", cleaned)
        self.assertEqual(cleaned.strip("\r"), "")

    def test_real_raw_snippet(self) -> None:
        raw_log_snippet = read_fixture_bytes("raw_log_snippet.bin")
        text = raw_log_snippet.decode("utf-8", errors="replace")
        cleaned = strip_markers(text)
        self.assertNotIn("\x1b", cleaned)
        self.assertTrue("FAILED" in cleaned or "failed" in cleaned)


class TestCleanLog(unittest.TestCase):
    """Full log cleaning: strip + extract structured fields."""

    def test_nixl_import_per_test_cause(self) -> None:
        log_nixl_import = read_fixture_text("log_nixl_import_error.txt")
        parsed_log = parse_log(log_nixl_import)
        all_failures = []
        for pytest_result in parsed_log.pytest_results:
            for failure in pytest_result.test_failures:
                all_failures.append(failure)
        self.assertEqual(len(all_failures), 1)
        self.assertEqual(all_failures[0].pytest_exception_class, "ImportError")
        self.assertIn("nixl_ep_cpp", all_failures[0].exception_chain)

    def test_nixl_import_summary(self) -> None:
        log_nixl_import = read_fixture_text("log_nixl_import_error.txt")
        parsed_log = parse_log(log_nixl_import)
        found_summary = False
        for pytest_result in parsed_log.pytest_results:
            if "1 failed" in pytest_result.pytest_summary:
                found_summary = True
        self.assertTrue(found_summary)

    def test_engine_many_failures(self) -> None:
        log_engine_cuda_fail = read_fixture_text("log_engine_cuda_init_fail.txt")
        parsed_log = parse_log(log_engine_cuda_fail)
        found_summary = False
        for pytest_result in parsed_log.pytest_results:
            if "50 failed" in pytest_result.pytest_summary:
                found_summary = True
        self.assertTrue(found_summary)

    def test_engine_per_test_causes(self) -> None:
        log_engine_cuda_fail = read_fixture_text("log_engine_cuda_init_fail.txt")
        parsed_log = parse_log(log_engine_cuda_fail)
        all_failures = []
        for pytest_result in parsed_log.pytest_results:
            for failure in pytest_result.test_failures:
                all_failures.append(failure)
        self.assertEqual(len(all_failures), 50)
        for failure in all_failures:
            self.assertTrue(failure.pytest_exception_class)

    def test_engine_sentinel_and_direct_failures(self) -> None:
        """Engine tail: some tests have CUDA driver error directly, sentinels
        are identified by their exception_chain."""
        log_engine_cuda_fail = read_fixture_text("log_engine_cuda_init_fail.txt")
        parsed_log = parse_log(log_engine_cuda_fail)
        direct_cuda_count = 0
        sentinel_count = 0
        for pytest_result in parsed_log.pytest_results:
            for failure in pytest_result.test_failures:
                if "CUDA driver initialization failed" in failure.exception_chain:
                    direct_cuda_count += 1
                elif "See root cause above" in failure.exception_chain:
                    sentinel_count += 1
        self.assertGreater(direct_cuda_count, 0)
        self.assertGreater(sentinel_count, 0)

    def test_dynamo_regression_chain_scoped_to_section(self) -> None:
        """Chain is a single raw section body from the FAILURES block,
        scoped to this test — includes the subprocess wrapper's inner
        traceback but not the EngineCore process output."""
        log_dynamo_regression = read_fixture_text("log_dynamo_regression.txt")
        parsed_log = parse_log(log_dynamo_regression)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertEqual(failure.pytest_exception_class, "RuntimeError")
        self.assertIn("Test subprocess", failure.exception_chain)
        self.assertIn("RuntimeError", failure.exception_chain)
        self.assertIn("Server exited unexpectedly", failure.exception_chain)


class TestExpandedExceptionSuffixes(unittest.TestCase):
    """Exception classes beyond Error/Exception/Failure."""

    def test_system_exit(self) -> None:
        log = "FAILED tests/test_runner.py::test_spawn - SystemExit: 1\n= 1 failed in 5.00s ="
        parsed_log = parse_log(log)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertEqual(failure.pytest_exception_class, "SystemExit")
        self.assertIn("1", failure.exception_chain)

    def test_keyboard_interrupt(self) -> None:
        log = "FAILED tests/test_server.py::test_startup - KeyboardInterrupt: \n= 1 failed in 30.00s ="
        parsed_log = parse_log(log)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertEqual(failure.pytest_exception_class, "KeyboardInterrupt")

    def test_exception_group(self) -> None:
        log = (
            "FAILED tests/test_async.py::test_gather - ExceptionGroup: multiple errors (2 sub-exceptions)\n"
            "= 1 failed in 2.00s ="
        )
        parsed_log = parse_log(log)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertEqual(failure.pytest_exception_class, "ExceptionGroup")

    def test_warning_as_error(self) -> None:
        log = (
            "FAILED tests/test_compat.py::test_legacy - DeprecationWarning: function X is deprecated\n"
            "= 1 failed in 1.00s ="
        )
        parsed_log = parse_log(log)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertEqual(failure.pytest_exception_class, "DeprecationWarning")

    def test_stop_iteration(self) -> None:
        log = "FAILED tests/test_gen.py::test_iter - StopIteration: \n= 1 failed in 0.50s ="
        parsed_log = parse_log(log)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertEqual(failure.pytest_exception_class, "StopIteration")

    def test_dotted_torch_exception(self) -> None:
        log = (
            "FAILED tests/test_gpu.py::test_alloc - torch.cuda.OutOfMemoryError: CUDA out of memory\n"
            "= 1 failed in 10.00s ="
        )
        parsed_log = parse_log(log)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertEqual(failure.pytest_exception_class, "torch.cuda.OutOfMemoryError")


class TestErrorLinesParsing(unittest.TestCase):
    """ERROR lines from setup/teardown/collection failures."""

    def test_error_with_exception(self) -> None:
        log = "ERROR tests/test_foo.py - SyntaxError: invalid syntax\n= 1 error in 0.50s ="
        parsed_log = parse_log(log)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertEqual(failure.test_id, "tests/test_foo.py")
        self.assertEqual(failure.pytest_exception_class, "SyntaxError")

    def test_error_with_nodeid(self) -> None:
        log = "ERROR tests/test_db.py::test_query - ConnectionRefusedError: [Errno 111]\n= 1 error in 1.00s ="
        parsed_log = parse_log(log)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertEqual(failure.test_id, "tests/test_db.py::test_query")
        self.assertEqual(failure.pytest_exception_class, "ConnectionRefusedError")

    def test_error_and_failed_together(self) -> None:
        log = (
            "ERROR tests/conftest.py - ImportError: No module named 'foo'\n"
            "FAILED tests/test_bar.py::test_baz - ValueError: bad\n"
            "= 1 failed, 1 error in 2.00s ="
        )
        parsed_log = parse_log(log)
        pytest_result = parsed_log.pytest_results[0]
        self.assertEqual(len(pytest_result.test_failures), 2)
        by_id = {failure.test_id: failure for failure in pytest_result.test_failures}
        self.assertEqual(
            by_id["tests/conftest.py"].pytest_exception_class, "ImportError"
        )
        self.assertEqual(
            by_id["tests/test_bar.py::test_baz"].pytest_exception_class, "ValueError"
        )

    def test_error_does_not_match_log_noise(self) -> None:
        log = (
            "(EngineCore pid=2181) ERROR 06-19 12:57:13 [core.py:1229] something broke\n"
            "FAILED tests/test_x.py::test_y - RuntimeError: fail\n"
            "= 1 failed in 5.00s ="
        )
        parsed_log = parse_log(log)
        pytest_result = parsed_log.pytest_results[0]
        self.assertEqual(len(pytest_result.test_failures), 1)
        self.assertEqual(
            pytest_result.test_failures[0].test_id, "tests/test_x.py::test_y"
        )


class TestExpectedFailureCount(unittest.TestCase):
    """Validate extracted count against pytest summary line."""

    def test_count_from_failed_only(self) -> None:
        log = (
            "FAILED tests/test_a.py::test_one - ValueError: bad\n"
            "FAILED tests/test_a.py::test_two - TypeError: wrong\n"
            "= 2 failed in 1.00s ="
        )
        parsed_log = parse_log(log)
        pytest_result = parsed_log.pytest_results[0]
        self.assertEqual(pytest_result.expected_test_failure_count, 2)
        self.assertEqual(len(pytest_result.test_failures), 2)

    def test_count_from_failed_and_passed(self) -> None:
        log = "FAILED tests/test_a.py::test_one - ValueError: bad\n= 1 failed, 5 passed in 2.00s ="
        parsed_log = parse_log(log)
        self.assertEqual(parsed_log.pytest_results[0].expected_test_failure_count, 1)

    def test_count_from_errors_only(self) -> None:
        log = "ERROR tests/conftest.py - SyntaxError: invalid syntax\n= 1 error in 0.50s ="
        parsed_log = parse_log(log)
        self.assertEqual(parsed_log.pytest_results[0].expected_test_failure_count, 1)

    def test_count_from_failed_and_errors(self) -> None:
        log = (
            "ERROR tests/conftest.py - ImportError: no module\n"
            "FAILED tests/test_a.py::test_one - ValueError: bad\n"
            "= 1 failed, 1 error in 2.00s ="
        )
        parsed_log = parse_log(log)
        pytest_result = parsed_log.pytest_results[0]
        self.assertEqual(pytest_result.expected_test_failure_count, 2)
        self.assertEqual(len(pytest_result.test_failures), 2)

    def test_none_when_no_summary(self) -> None:
        log = "some random log output\n"
        parsed_log = parse_log(log)
        self.assertEqual(len(parsed_log.pytest_results), 0)

    def test_mismatch_does_not_raise_and_records_counts(self) -> None:
        # A summary count that disagrees with the parsed failures must not raise:
        # both counts stay readable (expected_test_failure_count vs the actual
        # test_failures length) so a consumer can detect the mismatch itself.
        log = (
            "FAILED tests/test_a.py::test_one - ValueError: bad\n= 3 failed in 1.00s ="
        )
        parsed_log = parse_log(log)
        pytest_result = parsed_log.pytest_results[0]
        self.assertEqual(pytest_result.expected_test_failure_count, 3)
        self.assertEqual(len(pytest_result.test_failures), 1)

    def test_mismatch_does_not_discard_later_sessions(self) -> None:
        # A mismatched session must degrade to itself, not lose a well-formed
        # session that follows it in the same log.
        log = (
            "FAILED tests/test_a.py::test_one - ValueError: bad\n"
            "= 3 failed in 1.00s =\n"
            "FAILED tests/test_b.py::test_two - TypeError: wrong\n"
            "= 1 failed in 2.00s ="
        )
        parsed_log = parse_log(log)
        self.assertEqual(len(parsed_log.pytest_results), 2)
        good_session = parsed_log.pytest_results[1]
        self.assertEqual(good_session.expected_test_failure_count, 1)
        self.assertEqual(len(good_session.test_failures), 1)
        self.assertEqual(
            good_session.test_failures[0].test_id, "tests/test_b.py::test_two"
        )

    def test_real_fixture_counts_match(self) -> None:
        log_cuda_init_fail = read_fixture_text("log_cudagraph_cuda_init_fail.txt")
        parsed_log = parse_log(log_cuda_init_fail)
        for pytest_result in parsed_log.pytest_results:
            if pytest_result.test_failures:
                self.assertEqual(
                    pytest_result.expected_test_failure_count,
                    len(pytest_result.test_failures),
                )

    def test_real_engine_counts_match(self) -> None:
        log_engine_cuda_fail = read_fixture_text("log_engine_cuda_init_fail.txt")
        parsed_log = parse_log(log_engine_cuda_fail)
        total_failures = 0
        for pytest_result in parsed_log.pytest_results:
            total_failures += len(pytest_result.test_failures)
        self.assertEqual(total_failures, 50)


class TestMultipleSessionsGrouping(unittest.TestCase):
    """Multiple pytest sessions within a single Buildkite job log."""

    def test_two_sessions_grouped_separately(self) -> None:
        log = (
            "FAILED tests/test_a.py::test_one - ValueError: bad\n"
            "= 1 failed, 2 passed in 5.00s =\n"
            "+++ Command (2/2): pytest tests/test_b.py\n"
            "FAILED tests/test_b.py::test_two - TypeError: wrong\n"
            "FAILED tests/test_b.py::test_three - KeyError: missing\n"
            "= 2 failed in 3.00s ="
        )
        parsed_log = parse_log(log)
        self.assertEqual(len(parsed_log.pytest_results), 2)

        session_one = parsed_log.pytest_results[0]
        self.assertEqual(len(session_one.test_failures), 1)
        self.assertEqual(
            session_one.test_failures[0].test_id, "tests/test_a.py::test_one"
        )
        self.assertEqual(
            session_one.test_failures[0].pytest_exception_class, "ValueError"
        )
        self.assertIn("bad", session_one.test_failures[0].exception_chain)
        self.assertEqual(session_one.expected_test_failure_count, 1)

        session_two = parsed_log.pytest_results[1]
        self.assertEqual(len(session_two.test_failures), 2)
        self.assertEqual(
            session_two.test_failures[0].test_id, "tests/test_b.py::test_two"
        )
        self.assertEqual(
            session_two.test_failures[0].pytest_exception_class, "TypeError"
        )
        self.assertIn("wrong", session_two.test_failures[0].exception_chain)
        self.assertEqual(
            session_two.test_failures[1].test_id, "tests/test_b.py::test_three"
        )
        self.assertEqual(
            session_two.test_failures[1].pytest_exception_class, "KeyError"
        )
        self.assertIn("missing", session_two.test_failures[1].exception_chain)
        self.assertEqual(session_two.expected_test_failure_count, 2)

    def test_passing_session_produces_empty_result(self) -> None:
        log = (
            "= 5 passed in 1.00s =\n"
            "+++ Command (2/2): pytest tests/test_b.py\n"
            "FAILED tests/test_b.py::test_one - RuntimeError: boom\n"
            "= 1 failed in 2.00s ="
        )
        parsed_log = parse_log(log)
        self.assertEqual(len(parsed_log.pytest_results), 2)

        session_one = parsed_log.pytest_results[0]
        self.assertEqual(len(session_one.test_failures), 0)
        self.assertEqual(session_one.expected_test_failure_count, 0)
        self.assertIn("5 passed", session_one.pytest_summary)

        session_two = parsed_log.pytest_results[1]
        self.assertEqual(len(session_two.test_failures), 1)
        self.assertEqual(session_two.expected_test_failure_count, 1)

    def test_failing_then_passing_session(self) -> None:
        log = (
            "FAILED tests/test_a.py::test_one - ValueError: bad\n"
            "= 1 failed, 2 passed in 5.00s =\n"
            "+++ Command (2/2): pytest tests/test_b.py\n"
            "= 12 passed in 3.00s ="
        )
        parsed_log = parse_log(log)
        self.assertEqual(len(parsed_log.pytest_results), 2)

        session_one = parsed_log.pytest_results[0]
        self.assertEqual(len(session_one.test_failures), 1)
        self.assertEqual(
            session_one.test_failures[0].test_id, "tests/test_a.py::test_one"
        )

        session_two = parsed_log.pytest_results[1]
        self.assertEqual(len(session_two.test_failures), 0)
        self.assertEqual(session_two.expected_test_failure_count, 0)

    def test_real_cudagraph_end_to_end(self) -> None:
        """Full end-to-end: cudagraph fixture has 2 sessions, 4 failures."""
        log_cuda_init_fail = read_fixture_text("log_cudagraph_cuda_init_fail.txt")
        parsed_log = parse_log(log_cuda_init_fail)
        self.assertEqual(len(parsed_log.pytest_results), 2)

        failing_session = parsed_log.pytest_results[0]
        self.assertEqual(len(failing_session.test_failures), 4)
        self.assertEqual(failing_session.expected_test_failure_count, 4)
        self.assertIn("4 failed", failing_session.pytest_summary)

        sentinel_one = failing_session.test_failures[0]
        self.assertEqual(
            sentinel_one.test_id,
            "v1/cudagraph/test_cudagraph_mode.py::test_backend_and_cudagraph_mode_combo[FA2-FULL-True]",
        )
        self.assertEqual(sentinel_one.pytest_exception_class, "RuntimeError")
        self.assertIn("Engine core initialization failed", sentinel_one.exception_chain)
        # The chain is scoped to this test's own section: the real root cause
        # (a ValueError in another test's failure) is not merged in here.
        self.assertNotIn("Memory of devices", sentinel_one.exception_chain)

        direct_one = failing_session.test_failures[2]
        self.assertEqual(
            direct_one.test_id,
            "v1/cudagraph/test_cudagraph_mode.py::test_cudagraph_compilation_combo[FA2-FULL-3-True]",
        )
        self.assertEqual(direct_one.pytest_exception_class, "ValueError")
        self.assertIn("Memory of devices", direct_one.exception_chain)

        passing_session = parsed_log.pytest_results[1]
        self.assertEqual(len(passing_session.test_failures), 0)
        self.assertEqual(passing_session.expected_test_failure_count, 0)
        self.assertIn("12 passed", passing_session.pytest_summary)

    def test_real_elastic_ep_end_to_end(self) -> None:
        """Full end-to-end: elastic EP has 2 failures with distinct assertions."""
        raw_log_64854_elastic_ep = read_fixture_text(
            "raw_log_64854_elastic_ep_scaling.txt"
        )
        parsed_log = parse_log(raw_log_64854_elastic_ep)

        failing_session = None
        for pytest_result in parsed_log.pytest_results:
            if pytest_result.test_failures:
                failing_session = pytest_result
        self.assertIsNotNone(failing_session)
        assert failing_session is not None
        self.assertEqual(len(failing_session.test_failures), 2)
        self.assertEqual(failing_session.expected_test_failure_count, 2)
        self.assertIn("2 failed", failing_session.pytest_summary)

        scaling_failure = failing_session.test_failures[0]
        self.assertEqual(
            scaling_failure.test_id,
            "distributed/test_elastic_ep.py::test_elastic_ep_scaling",
        )
        self.assertEqual(scaling_failure.pytest_exception_class, "AssertionError")
        self.assertIn("assert False", scaling_failure.exception_chain)

        uneven_failure = failing_session.test_failures[1]
        self.assertEqual(
            uneven_failure.test_id,
            "distributed/test_elastic_ep.py::test_elastic_ep_scaling_uneven",
        )
        self.assertEqual(uneven_failure.pytest_exception_class, "AssertionError")
        self.assertIn(
            "GSM8K accuracy 0.000 is below expected threshold",
            uneven_failure.exception_chain,
        )
        self.assertNotIn("assert False", uneven_failure.exception_chain)

    def test_multi_root_cause_sentinels_end_to_end(self) -> None:
        """Two sentinel tests with different root causes — each chain is
        a single raw section body containing the full traceback."""
        log_multi_root_cause_sentinels = read_fixture_text(
            "log_multi_root_cause_sentinels.txt"
        )
        parsed_log = parse_log(log_multi_root_cause_sentinels)

        failing_session = None
        for pytest_result in parsed_log.pytest_results:
            if pytest_result.test_failures:
                failing_session = pytest_result
        self.assertIsNotNone(failing_session)
        assert failing_session is not None
        self.assertEqual(len(failing_session.test_failures), 2)
        self.assertEqual(failing_session.expected_test_failure_count, 2)

        model_loading = failing_session.test_failures[0]
        self.assertEqual(model_loading.test_id, "test_engine.py::test_model_loading")
        self.assertEqual(model_loading.pytest_exception_class, "RuntimeError")
        self.assertIn(
            "Engine core initialization failed", model_loading.exception_chain
        )
        body = model_loading.exception_chain
        self.assertIn("ValueError: GPU memory exhausted on device 0", body)
        self.assertIn("RuntimeError: Engine core initialization failed", body)

        kernel_dispatch = failing_session.test_failures[1]
        self.assertEqual(
            kernel_dispatch.test_id, "test_engine.py::test_kernel_dispatch"
        )
        self.assertEqual(kernel_dispatch.pytest_exception_class, "RuntimeError")
        self.assertIn(
            "Engine core initialization failed", kernel_dispatch.exception_chain
        )
        body = kernel_dispatch.exception_chain
        self.assertIn("TypeError: unsupported dtype bfloat16 for this kernel", body)
        self.assertIn("RuntimeError: Engine core initialization failed", body)

    def test_orphan_failures_no_summary(self) -> None:
        """Truncated log: FAILED lines but no summary (timeout kill)."""
        log = (
            "FAILED tests/test_a.py::test_one - ValueError: bad\n"
            "FAILED tests/test_a.py::test_two - TypeError: wrong\n"
        )
        parsed_log = parse_log(log)
        self.assertEqual(len(parsed_log.pytest_results), 1)

        orphan_result = parsed_log.pytest_results[0]
        self.assertIsNone(orphan_result.expected_test_failure_count)
        self.assertEqual(len(orphan_result.test_failures), 2)


class TestInfraTagging(unittest.TestCase):
    """Infrastructure failures are tagged (test_is_infra), not filtered out."""

    def _only_failure(self, parsed_log):
        failures = [
            failure
            for pytest_result in parsed_log.pytest_results
            for failure in pytest_result.test_failures
        ]
        self.assertEqual(len(failures), 1)
        return failures[0]

    def test_nvidia_container_cli_tagged(self) -> None:
        log = (
            "FAILED tests/test_a.py::test_one - RuntimeError: nvidia-container-cli: initialization error\n"
            "= 1 failed in 1.00s ="
        )
        self.assertTrue(self._only_failure(parse_log(log)).test_is_infra)

    def test_oom_killed_tagged(self) -> None:
        log = "FAILED tests/test_a.py::test_one - RuntimeError: exit status 137\n= 1 failed in 1.00s ="
        self.assertTrue(self._only_failure(parse_log(log)).test_is_infra)

    def test_gpu_memory_tagged(self) -> None:
        log = (
            "FAILED tests/test_a.py::test_one - ValueError: Free memory on device "
            "cuda:0 (1.2/80.0 GiB) on startup is less than desired\n"
            "= 1 failed in 1.00s ="
        )
        self.assertTrue(self._only_failure(parse_log(log)).test_is_infra)

    def test_connection_refused_tagged(self) -> None:
        log = "FAILED tests/test_a.py::test_one - ConnectionRefusedError: Connection refused\n= 1 failed in 1.00s ="
        self.assertTrue(self._only_failure(parse_log(log)).test_is_infra)

    def test_no_space_tagged(self) -> None:
        log = "FAILED tests/test_a.py::test_one - OSError: no space left on device\n= 1 failed in 1.00s ="
        self.assertTrue(self._only_failure(parse_log(log)).test_is_infra)

    def test_docker_pull_tagged(self) -> None:
        log = "FAILED tests/test_a.py::test_one - RuntimeError: docker pull failed\n= 1 failed in 1.00s ="
        self.assertTrue(self._only_failure(parse_log(log)).test_is_infra)

    def test_regular_error_not_tagged(self) -> None:
        log = "FAILED tests/test_a.py::test_one - ValueError: invalid literal\n= 1 failed in 1.00s ="
        failure = self._only_failure(parse_log(log))
        self.assertEqual(failure.test_id, "tests/test_a.py::test_one")
        self.assertFalse(failure.test_is_infra)

    def test_infra_and_real_tests_tagged_independently(self) -> None:
        log = (
            "=================================== FAILURES ===================================\n"
            "____________________________ test_one _____________________________\n"
            "    def test_one():\n"
            ">       run()\n"
            "E   RuntimeError: exit status 137\n"
            "tests/test_a.py:10: RuntimeError\n"
            "____________________________ test_two _____________________________\n"
            "    def test_two():\n"
            ">       run()\n"
            "E   ValueError: bad value\n"
            "tests/test_b.py:20: ValueError\n"
            "=========================== short test summary info ============================\n"
            "FAILED tests/test_a.py::test_one - RuntimeError: exit status 137\n"
            "FAILED tests/test_b.py::test_two - ValueError: bad value\n"
            "= 2 failed in 1.00s ="
        )
        by_id = {
            failure.test_id: failure
            for pytest_result in parse_log(log).pytest_results
            for failure in pytest_result.test_failures
        }
        self.assertTrue(by_id["tests/test_a.py::test_one"].test_is_infra)
        self.assertFalse(by_id["tests/test_b.py::test_two"].test_is_infra)


class TestCustomRunnerSummaryIgnored(unittest.TestCase):
    """Non-pytest summary lines must not be treated as pytest summaries."""

    def test_subtest_runner_summary_ignored(self) -> None:
        log = (
            "subtest: [param-1] PASSED\n"
            "subtest: [param-2] PASSED\n"
            "============= 1 failed, 31 passed of 32 total tests =============\n"
            "============= Failed subtests =============\n"
            "[param-3]\n"
            "FAILED tests/test_moe.py::test_moe_layer[param-3] - AssertionError: Tensor-likes are not close!\n"
            "= 1 failed, 31 passed, 297 skipped in 632.60s (0:10:32) =\n"
        )
        parsed_log = parse_log(log)
        self.assertEqual(len(parsed_log.pytest_results), 1)
        session = parsed_log.pytest_results[0]
        self.assertEqual(session.expected_test_failure_count, 1)
        self.assertEqual(len(session.test_failures), 1)
        self.assertEqual(
            session.test_failures[0].test_id,
            "tests/test_moe.py::test_moe_layer[param-3]",
        )

    def test_multiple_custom_summaries_before_real(self) -> None:
        log = (
            "============= 1 failed, 31 passed of 32 total tests =============\n"
            "============= 1 failed, 31 passed of 32 total tests =============\n"
            "FAILED tests/test_a.py::test_one - ValueError: bad\n"
            "= 1 failed, 220 passed, 297 skipped, 21 warnings in 632.60s (0:10:32) =\n"
        )
        parsed_log = parse_log(log)
        self.assertEqual(len(parsed_log.pytest_results), 1)
        self.assertEqual(parsed_log.pytest_results[0].expected_test_failure_count, 1)


class TestSectionBodyCapture(unittest.TestCase):
    """Raw section body capture from the FAILURES block."""

    def test_section_body_contains_full_traceback(self) -> None:
        log = (
            "=================================== FAILURES ===================================\n"
            "____________________________ test_moe_forward _____________________________\n"
            "\n"
            "    def test_moe_forward():\n"
            ">       run_moe()\n"
            "\n"
            "E   AssertionError: expected size 3072==2880, stride 1==1 at dim=0\n"
            "E   Error in op: torch.ops.vllm.moe_forward.default\n"
            "E   This error most often comes from a incorrect fake (aka meta) kernel for a custom op.\n"
            "\n"
            "tests/test_moe.py:42: AssertionError\n"
            "=========================== short test summary info ============================\n"
            "FAILED tests/test_moe.py::test_moe_forward - AssertionError: "
            "expected size 3072==2880, stride 1==1 at dim=0\n"
            "= 1 failed in 5.00s ="
        )
        parsed_log = parse_log(log)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertIn(
            "Error in op: torch.ops.vllm.moe_forward.default", failure.exception_chain
        )
        self.assertIn("This error most often comes from", failure.exception_chain)
        self.assertIn("expected size 3072==2880", failure.exception_chain)

    def test_bare_failed_line_leaves_class_empty(self) -> None:
        """A bare FAILED line (no class on pytest's summary line) leaves
        pytest_exception_class empty -- the class is not inferred from the
        section footer -- while exception_chain still carries the traceback."""
        log = (
            "=================================== FAILURES ===================================\n"
            "_________________ test_check_padding _________________\n"
            "\n"
            "    def test_check_padding():\n"
            "        layer = make_layer(4096, 96)\n"
            ">       assert check_supports(layer, 32, allow_padding=True)\n"
            "E       assert False\n"
            "E        +  where False = check_supports(..., 32, allow_padding=True)\n"
            "\n"
            "tests/test_padding.py:42: AssertionError\n"
            "=========================== short test summary info ============================\n"
            "FAILED tests/test_padding.py::test_check_padding\n"
            "= 1 failed in 5.00s ="
        )
        parsed_log = parse_log(log)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertEqual(failure.pytest_exception_class, "")
        self.assertIn("assert False", failure.exception_chain)
        self.assertIn("AssertionError", failure.exception_chain)

    def test_no_section_body_uses_fallback(self) -> None:
        """Without FAILURES section headers, chain falls back to body exceptions."""
        log = (
            "E   ValueError: bad value\n"
            "INFO 06-19 12:57:13 [core.py:1229] some log line\n"
            "FAILED tests/test_a.py::test_one - ValueError: bad value\n"
            "= 1 failed in 5.00s ="
        )
        parsed_log = parse_log(log)
        failure = parsed_log.pytest_results[0].test_failures[0]
        self.assertNotIn("some log line", failure.exception_chain)


class TestNonPytestFallback(unittest.TestCase):
    def test_non_pytest_log_produces_error_excerpt(self) -> None:
        log = "Step 1: Building wheel...\nerror: command 'gcc' failed with exit code 1\nBuild failed.\n"
        parsed_log = parse_log(log)
        self.assertEqual(parsed_log.pytest_results, [])
        self.assertIn("error: command 'gcc' failed", parsed_log.error_excerpt)

    def test_segfault_log_produces_error_excerpt(self) -> None:
        log = "importing torch...\nSegmentation fault (core dumped)\n"
        parsed_log = parse_log(log)
        self.assertEqual(parsed_log.pytest_results, [])
        self.assertIn("Segmentation fault", parsed_log.error_excerpt)

    def test_pytest_log_has_empty_error_excerpt(self) -> None:
        log = (
            "FAILED tests/test_a.py::test_one - ValueError: bad\n= 1 failed in 1.00s ="
        )
        parsed_log = parse_log(log)
        self.assertEqual(len(parsed_log.pytest_results), 1)
        self.assertEqual(parsed_log.error_excerpt, "")

    def test_empty_log_has_empty_error_excerpt(self) -> None:
        parsed_log = parse_log("")
        self.assertEqual(parsed_log.pytest_results, [])
        self.assertEqual(parsed_log.error_excerpt, "")

    def test_error_excerpt_strips_ansi_markers(self) -> None:
        log = "\x1b[31mFatal Python error\x1b[0m: Segmentation fault\n"
        parsed_log = parse_log(log)
        self.assertEqual(parsed_log.pytest_results, [])
        self.assertNotIn("\x1b", parsed_log.error_excerpt)
        self.assertIn("Fatal Python error", parsed_log.error_excerpt)


class TestNonPytestInfraTagging(unittest.TestCase):
    """Infra failures on the non-pytest (prior-failure) path keep their
    excerpt and are tagged job_is_infra instead of being dropped."""

    def test_non_pytest_nvidia_container_cli_tagged(self) -> None:
        log = "nvidia-container-cli: initialization error\nBuild failed.\n"
        parsed_log = parse_log(log)
        self.assertEqual(parsed_log.pytest_results, [])
        self.assertIn("nvidia-container-cli", parsed_log.error_excerpt)
        self.assertTrue(parsed_log.job_is_infra)

    def test_non_pytest_oom_killed_tagged(self) -> None:
        log = "Downloading wheel...\nexit status 137\n"
        parsed_log = parse_log(log)
        self.assertEqual(parsed_log.pytest_results, [])
        self.assertIn("exit status 137", parsed_log.error_excerpt)
        self.assertTrue(parsed_log.job_is_infra)

    def test_non_pytest_connection_refused_tagged(self) -> None:
        log = "importing torch...\nConnection refused\n"
        parsed_log = parse_log(log)
        self.assertEqual(parsed_log.pytest_results, [])
        self.assertIn("Connection refused", parsed_log.error_excerpt)
        self.assertTrue(parsed_log.job_is_infra)

    def test_non_pytest_regular_error_not_tagged(self) -> None:
        log = "error: command 'gcc' failed with exit code 1\nBuild failed.\n"
        parsed_log = parse_log(log)
        self.assertEqual(parsed_log.pytest_results, [])
        self.assertIn("gcc", parsed_log.error_excerpt)
        self.assertFalse(parsed_log.job_is_infra)


class TestTransientInfraSignatures(unittest.TestCase):
    """Retryable transient-infra signatures from the triage skill are tagged."""

    def _only_failure(self, log: str):
        parsed_log = parse_log(log)
        failures = [
            failure
            for pytest_result in parsed_log.pytest_results
            for failure in pytest_result.test_failures
        ]
        self.assertEqual(len(failures), 1)
        return failures[0]

    def test_cuda_driver_init_failed_tagged(self) -> None:
        log = (
            "FAILED tests/test_a.py::test_one - RuntimeError: CUDA driver initialization failed, "
            "you might not have a CUDA gpu.\n"
            "= 1 failed in 1.00s ="
        )
        self.assertTrue(self._only_failure(log).test_is_infra)

    def test_engine_core_init_wrapper_with_cuda_root_cause_tagged(self) -> None:
        log = (
            "=================================== FAILURES ===================================\n"
            "____________________________ test_engine _____________________________\n"
            "    def test_engine():\n"
            ">       run()\n"
            "E   RuntimeError: CUDA driver initialization failed, you might not have a CUDA gpu.\n"
            "E   RuntimeError: Engine core initialization failed. See root cause above.\n"
            "tests/test_a.py:10: RuntimeError\n"
            "=========================== short test summary info ============================\n"
            "FAILED tests/test_a.py::test_engine - RuntimeError: "
            "Engine core initialization failed. See root cause above.\n"
            "= 1 failed in 1.00s ="
        )
        self.assertTrue(self._only_failure(log).test_is_infra)

    def test_exit_status_125_tagged(self) -> None:
        parsed_log = parse_log(
            "Error: The command exited with status 125\nBuild failed.\n"
        )
        self.assertTrue(parsed_log.job_is_infra)

    def test_docker_setup_hook_tagged(self) -> None:
        parsed_log = parse_log("docker command hook exited with status 1\n")
        self.assertTrue(parsed_log.job_is_infra)

    def test_ecr_toomanyrequests_tagged(self) -> None:
        parsed_log = parse_log(
            "Error response from daemon: toomanyrequests: Rate exceeded\n"
        )
        self.assertTrue(parsed_log.job_is_infra)

    def test_ecr_data_limit_exceeded_tagged(self) -> None:
        parsed_log = parse_log("denied: Data limit exceeded\n")
        self.assertTrue(parsed_log.job_is_infra)

    def test_manifest_unknown_tagged(self) -> None:
        log = (
            "+ docker pull 12345.dkr.ecr.us-east-1.amazonaws.com/pytorch:abc123\n"
            "Error response from daemon: manifest for pytorch:abc123 not found: manifest unknown\n"
        )
        self.assertTrue(parse_log(log).job_is_infra)

    def test_not_found_manifest_tagged(self) -> None:
        self.assertTrue(
            parse_log(
                "failed to resolve reference: not found: manifest unknown\n"
            ).job_is_infra
        )


class TestNonInfraNotTagged(unittest.TestCase):
    """Signatures with no infra pattern stay untagged (job_is_infra False)."""

    def test_module_not_found_torch_not_tagged(self) -> None:
        parsed_log = parse_log(
            "ModuleNotFoundError: No module named 'torch'\nBuild failed.\n"
        )
        self.assertFalse(parsed_log.job_is_infra)

    def test_undefined_symbol_not_tagged(self) -> None:
        parsed_log = parse_log(
            "ImportError: /lib/libtorch.so: undefined symbol: _ZN3c10\n"
        )
        self.assertFalse(parsed_log.job_is_infra)


class TestGetTestSignature(unittest.TestCase):
    """Signature is the (test_id, pytest_exception_class) 2-tuple."""

    def test_signature_is_id_and_class(self) -> None:
        log = "FAILED tests/test_a.py::test_one - ValueError: bad\n= 1 failed in 1.00s ="
        failure = parse_log(log).pytest_results[0].test_failures[0]
        self.assertEqual(
            get_test_signature(failure),
            ("tests/test_a.py::test_one", "ValueError"),
        )

    def test_signature_empty_class_for_bare_failed(self) -> None:
        log = "FAILED tests/test_a.py::test_one\n= 1 failed in 1.00s ="
        failure = parse_log(log).pytest_results[0].test_failures[0]
        self.assertEqual(
            get_test_signature(failure), ("tests/test_a.py::test_one", "")
        )


if __name__ == "__main__":
    unittest.main()
