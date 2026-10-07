"""Tests for the filing gate in the vLLM torch-nightly triage.

The gate reads fields the analysis agent writes into findings.json. Those two
sides live in different files (the agent's schema is prompted from
.github/workflows/vllm-torch-nightly-triage.yml), so a rename on one side is
invisible to the other -- exactly how ``confidence`` ->
``classification_confidence`` silently disabled all filing. Each case below
pins one field of that contract.
"""

import contextlib
import email.message
import io
import json
import os
import re
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from torchci import vllm_triage_file_issues as vtfi
from torchci.vllm_deduplication import UpstreamStatus
from torchci.vllm_triage_file_issues import (
    classification_confidence,
    cluster_fingerprint,
    eligible,
    fingerprint,
    issue_clusters,
    legacy_fingerprint,
    merge_clusters,
    near_duplicate,
    new_failure_confidence,
    normalize_signature,
)


def cause(**overrides):
    """A cause that is eligible, so each test can break exactly one field."""
    base = {
        "title": "torch.compile miscompiles fused rmsnorm",
        "signature": "AssertionError: Tensor-likes are not close",
        "clusters": [":nvidia: (H100) Kernels"],
        "routing": "pytorch/pytorch",
        "classification_confidence": "high",
        "new_failure_confidence": "high",
        "determined": True,
    }
    base.update(overrides)
    return base


class TestEligible(unittest.TestCase):
    def test_high_confidence_torch_cause_is_filed(self):
        self.assertTrue(eligible(cause()))

    def test_undetermined_cause_is_skipped(self):
        self.assertFalse(eligible(cause(determined=False)))

    def test_unroutable_causes_are_skipped(self):
        # `vllm-project/vllm` used to be skipped here too. It is filed now --
        # see TestRoutingIsNotAFilingGate -- because routing says which repo
        # fixes the bug, not whether the bug is worth tracking.
        self.assertFalse(eligible(cause(routing="infra")))
        self.assertFalse(eligible(cause(routing="")))

    def test_routing_is_matched_case_and_space_insensitively(self):
        self.assertTrue(eligible(cause(routing=" PyTorch/PyTorch ")))
        self.assertTrue(eligible(cause(routing=" VLLM-Project/vLLM ")))

    def test_low_classification_confidence_is_skipped(self):
        self.assertFalse(eligible(cause(classification_confidence="low")))

    def test_known_variant_is_skipped_but_medium_is_filed(self):
        # low == "likely a variant of an existing known issue", which would
        # duplicate a child issue; medium is still worth a look.
        self.assertFalse(eligible(cause(new_failure_confidence="low")))
        self.assertTrue(eligible(cause(new_failure_confidence="medium")))

    def test_med_and_medium_are_the_same_level(self):
        # CONFIDENCE.md documents "med"; the workflow schema says "medium".
        self.assertEqual(
            new_failure_confidence({"new_failure_confidence": "med"}), "medium"
        )
        self.assertEqual(
            classification_confidence({"classification_confidence": "MED"}), "medium"
        )

    def test_legacy_confidence_field_still_gates(self):
        # Pre-rename findings.json: one `confidence`, no new_failure_confidence.
        legacy = {
            "routing": "pytorch/pytorch",
            "confidence": "high",
            "determined": True,
        }
        self.assertTrue(eligible(legacy))
        self.assertFalse(eligible({**legacy, "confidence": "low"}))

    def test_missing_confidence_is_not_eligible_and_is_reported_as_absent(self):
        no_conf = {"routing": "pytorch/pytorch", "determined": True}
        self.assertFalse(eligible(no_conf))
        self.assertEqual(classification_confidence(no_conf), "")
        self.assertEqual(new_failure_confidence(no_conf), "")

    def test_current_agent_schema_is_understood(self):
        # Shape emitted by run 33008738638. The point of the case is that the
        # gate reads the fields rather than failing closed on an unknown schema.
        # The nixl_ep entry is now filed -- it is a well-evidenced cause whose
        # fix happens to live in vLLM, and dropping it is what this change
        # stopped doing; the infra entry is still skipped.
        observed = [
            {
                "title": "torch-nightly cpu and arm64 CI images missing from ECR",
                "routing": "infra",
                "classification_confidence": "high",
                "new_failure_confidence": "high",
                "determined": True,
            },
            {
                "title": "nixl_ep has no torch-2.15 ABI variant",
                "routing": "vllm-project/vllm",
                "classification_confidence": "medium",
                "new_failure_confidence": "high",
                "determined": True,
            },
        ]
        self.assertEqual([eligible(c) for c in observed], [False, True])
        self.assertEqual(
            [classification_confidence(c) for c in observed], ["high", "medium"]
        )

    def test_vllm_requires_a_no_hits_check(self):
        vllm = cause(routing="vllm-project/vllm")

        self.assertFalse(eligible(vllm, UpstreamStatus.UPSTREAM_CANDIDATES, True))
        self.assertFalse(eligible(vllm, UpstreamStatus.SEARCH_INCOMPLETE, True))
        self.assertFalse(eligible(vllm, None, True))
        self.assertTrue(eligible(vllm, UpstreamStatus.NO_HITS, True))

    def test_pytorch_does_not_require_upstream_clearance(self):
        self.assertTrue(eligible(cause(), None, True))


class TestUpstreamFilingRecovery(unittest.TestCase):
    def test_unavailable_clearance_holds_vllm_and_preserves_torch(self):
        cases = {
            "invalid artifact": {"checks": "invalid"},
            "missing cause check": {"checks": []},
            "missing artifact": None,
        }
        for scenario, artifact in cases.items():
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as tmp:
                findings = Path(tmp) / "findings.json"
                report = Path(tmp) / "report.json"
                findings.write_text(
                    json.dumps({"causes": [cause(), cause(routing=vtfi.VLLM_ROUTING)]})
                )
                report.write_text(json.dumps({"torch_version_minor": "2.15"}))
                argv = [
                    "filer",
                    "--findings",
                    str(findings),
                    "--report",
                    str(report),
                    "--check-vllm-upstream",
                ]
                if artifact is not None:
                    checks = Path(tmp) / "upstream-checks.json"
                    checks.write_text(json.dumps(artifact))
                    argv.extend(["--upstream-checks", str(checks)])
                output = io.StringIO()
                with (
                    mock.patch.object(sys, "argv", argv),
                    mock.patch.dict(os.environ, {"GITHUB_TOKEN": "dry-run-token"}),
                    mock.patch.object(vtfi, "_req") as req,
                    contextlib.redirect_stdout(output),
                    contextlib.redirect_stderr(output),
                ):
                    self.assertEqual(vtfi.main(), 0)
                    req.assert_not_called()
                self.assertIn("child [pytorch/pytorch]", output.getvalue())
                self.assertNotIn("child [vllm-project/vllm]", output.getvalue())


class TestFingerprint(unittest.TestCase):
    """The key must identify the cause, not the log excerpt it arrived in."""

    # Verbatim from test-infra#8761 and #8783: one bug, two issues. Same test,
    # same assertion, same cluster -- but #8761's signature kept pytest's
    # continuation line and #8783's did not, so the raw-text hash differed and
    # the recurrence check filed a second issue two days later.
    SIG_WITH_TAIL = (
        "AssertionError: assert 2 == 0\n"
        " +  where 2 = op_count(<OpOverload(op='aten.slice_scatter', "
        "overload='default')>)"
    )
    SIG_BARE = "AssertionError: assert 2 == 0"
    CLUSTERS = [":nvidia: (L4) PyTorch Compilation Passes"]

    def _cause(self, signature):
        return {"signature": signature, "clusters": list(self.CLUSTERS)}

    def test_truncated_pytest_tail_does_not_split_a_cause(self):
        self.assertEqual(
            fingerprint("pytorch/test-infra", self._cause(self.SIG_WITH_TAIL)),
            fingerprint("pytorch/test-infra", self._cause(self.SIG_BARE)),
        )

    def test_legacy_key_reproduces_the_issues_actually_filed(self):
        # Guards the migration path: these are the keys in the live issue
        # bodies, so a lookup fallback on them must keep matching.
        self.assertEqual(
            legacy_fingerprint("pytorch/test-infra", self._cause(self.SIG_WITH_TAIL)),
            "7c92bb1993d0f853",
        )
        self.assertEqual(
            legacy_fingerprint("pytorch/test-infra", self._cause(self.SIG_BARE)),
            "982efc048a4aed36",
        )

    def test_whitespace_and_blank_lines_are_not_identity(self):
        self.assertEqual(
            fingerprint("pytorch/test-infra", self._cause("RuntimeError:  boom")),
            fingerprint("pytorch/test-infra", self._cause("\nRuntimeError: boom  \n")),
        )

    def test_different_exceptions_stay_distinct(self):
        self.assertNotEqual(
            fingerprint(
                "pytorch/test-infra", self._cause("AssertionError: assert 2 == 0")
            ),
            fingerprint(
                "pytorch/test-infra", self._cause("AssertionError: assert 3 == 0")
            ),
        )

    # Verbatim from test-infra#8786 (MI355) and #8839 (B200): byte-identical
    # GSM8K assertion on two accelerators, filed twice because the cluster name
    # was part of the key. One cause, so one issue with both clusters on it.
    def test_same_exception_in_a_different_cluster_is_one_cause(self):
        a = {
            "signature": self.SIG_BARE,
            "clusters": [":nvidia: (L4) PyTorch Compilation Passes"],
        }
        b = {"signature": self.SIG_BARE, "clusters": [":nvidia: (B200) Distributed"]}
        self.assertEqual(
            fingerprint("pytorch/test-infra", a), fingerprint("pytorch/test-infra", b)
        )

    def test_cluster_key_reproduces_the_issues_actually_filed(self):
        # The keys in the live issue bodies of #8808 and #8786. The fallback
        # lookup must keep matching them or every open child is re-filed once.
        self.assertEqual(
            cluster_fingerprint(
                "pytorch/test-infra",
                {
                    "signature": "RuntimeError: DeepEPv2 communicator properties "
                    "query failed; networking capability could not be determined.",
                    "clusters": [
                        ":nvidia: (B200) Distributed",
                        ":nvidia: (B200) FusedMoE Layer Kernels",
                    ],
                },
            ),
            "a693ee5560dce401",
        )
        self.assertEqual(
            cluster_fingerprint(
                "pytorch/test-infra",
                {
                    "signature": "AssertionError: GSM8K metric too low: "
                    "0.0000 < 0.9200 - 0.0800 = 0.8400",
                    "clusters": [":amd: (MI355) LM Eval Spec Decode"],
                },
            ),
            "15ba5aedfb5c45d1",
        )

    def test_normalize_keeps_the_assertion_drops_the_explanation(self):
        self.assertEqual(
            normalize_signature(self.SIG_WITH_TAIL), "AssertionError: assert 2 == 0"
        )

    # test-infra#8838 quoted the same failure as #8761 with the introspection
    # tail folded onto the assertion line, which the `^`-anchored strip missed.
    SIG_INLINE_TAIL = (
        "AssertionError: assert 2 == 0 +  where 2 = "
        "op_count(<OpOverload(op='aten.slice_scatter', overload='default')>)"
    )

    def test_inline_pytest_tail_does_not_split_a_cause(self):
        self.assertEqual(
            normalize_signature(self.SIG_INLINE_TAIL), "AssertionError: assert 2 == 0"
        )
        self.assertEqual(
            fingerprint("pytorch/test-infra", self._cause(self.SIG_INLINE_TAIL)),
            fingerprint("pytorch/test-infra", self._cause(self.SIG_BARE)),
        )

    # test-infra#8875 rewrote #8761's tail without pytest's `+` marker and with
    # the OpOverload repr collapsed.
    SIG_BARE_WHERE = (
        "AssertionError: assert 2 == 0 where 2 = op_count(aten.slice_scatter.default)"
    )

    def test_tail_without_the_plus_marker_does_not_split_a_cause(self):
        self.assertEqual(
            normalize_signature(self.SIG_BARE_WHERE), "AssertionError: assert 2 == 0"
        )
        self.assertEqual(
            fingerprint("pytorch/test-infra", self._cause(self.SIG_BARE_WHERE)),
            fingerprint("pytorch/test-infra", self._cause(self.SIG_WITH_TAIL)),
        )

    def test_where_outside_an_assertion_is_kept(self):
        # Only pytest's introspection tail is noise; "where" in a message is
        # part of the identity.
        self.assertEqual(
            normalize_signature("RuntimeError: cannot tell where the graph broke"),
            "RuntimeError: cannot tell where the graph broke",
        )

    def test_a_plus_that_is_not_pytest_introspection_is_kept(self):
        # Only the ` + where|and|assert ` form is pytest's; arithmetic in a
        # message is part of the identity.
        self.assertEqual(
            normalize_signature("AssertionError: 1 + 2 != 4"),
            "AssertionError: 1 + 2 != 4",
        )


class TestRoutingIsNotAFilingGate(unittest.TestCase):
    """A vLLM-side cause is filed too; routing picks the umbrella section."""

    def test_vllm_routed_cause_is_eligible(self):
        # Verbatim shape of the cuda-bindings 13.4 cudaIpcMemHandle_t finding,
        # emitted on three consecutive runs and dropped each time.
        c = cause(routing="vllm-project/vllm", new_failure_confidence="high")
        self.assertTrue(eligible(c))

    def test_torch_routed_cause_is_still_eligible(self):
        self.assertTrue(eligible(cause(routing="pytorch/pytorch")))

    def test_infra_and_undetermined_routings_are_still_skipped(self):
        for r in ("infra", "", "undetermined"):
            self.assertFalse(eligible(cause(routing=r)), r)

    def test_each_routing_has_a_section(self):
        for r in vtfi.FILED_ROUTINGS:
            self.assertIn(r, vtfi.SECTIONS)


class TestNeedsInvestigation(unittest.TestCase):
    """Widespread infra/undetermined causes are filed for a human."""

    CLUSTERS = [f":nvidia: (H200 MIG 35GB) Job {i}" for i in range(79)]

    def test_widespread_infra_cause_is_investigated(self):
        # Shape of the 2026-10-06 CUDA-init finding: 79 clusters, routed infra.
        c = cause(routing="infra", new_failure_confidence="low", clusters=self.CLUSTERS)
        self.assertFalse(eligible(c))
        self.assertTrue(vtfi.needs_investigation(c, 10))

    def test_widespread_undetermined_cause_is_investigated(self):
        c = cause(determined=False, clusters=self.CLUSTERS)
        self.assertTrue(vtfi.needs_investigation(c, 10))

    def test_small_infra_cause_is_still_dropped(self):
        c = cause(routing="infra", clusters=self.CLUSTERS[:3])
        self.assertFalse(vtfi.needs_investigation(c, 10))

    def test_eligible_cause_is_not_double_counted(self):
        self.assertFalse(vtfi.needs_investigation(cause(clusters=self.CLUSTERS), 10))

    def test_zero_disables(self):
        c = cause(routing="infra", clusters=self.CLUSTERS)
        self.assertFalse(vtfi.needs_investigation(c, 0))

    def test_template_ships_the_section(self):
        self.assertIn(vtfi.INVESTIGATE_SECTION, vtfi.umbrella_body("2.15", {}))

    def test_child_body_says_why_it_was_filed(self):
        c = cause(routing="infra", clusters=self.CLUSTERS)
        body = vtfi.child_body(c, {}, "k")
        self.assertIn("Filed for investigation", body)
        self.assertIn("79 job clusters", body)

    def test_dry_run_lists_investigation_after_eligible(self):
        with tempfile.TemporaryDirectory() as tmp:
            findings = Path(tmp) / "findings.json"
            report = Path(tmp) / "report.json"
            findings.write_text(
                json.dumps(
                    {
                        "causes": [
                            cause(
                                title="CUDA init storm",
                                routing="infra",
                                clusters=self.CLUSTERS,
                            ),
                            cause(title="small infra", routing="infra"),
                            cause(),
                        ]
                    }
                )
            )
            report.write_text(json.dumps({"torch_version_minor": "2.15"}))
            argv = ["filer", "--findings", str(findings), "--report", str(report)]
            output = io.StringIO()
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.dict(os.environ, {"GITHUB_TOKEN": "dry-run-token"}),
                mock.patch.object(vtfi, "_req") as req,
                contextlib.redirect_stdout(output),
            ):
                self.assertEqual(vtfi.main(), 0)
                req.assert_not_called()
        out = output.getvalue()
        self.assertIn("1 eligible, 1 for investigation, 1 skipped", out)
        self.assertLess(
            out.index("child [pytorch/pytorch]"), out.index("child [infra]")
        )
        self.assertNotIn("small infra  key=", out)


class TestSkippedRecurrence(unittest.TestCase):
    """A tracked cause the agent re-labels as infra still gets a comment."""

    def test_skipped_cause_matching_an_issue_is_recorded(self):
        skipped = cause(
            title="free-memory startup check",
            routing="infra",
            new_failure_confidence="low",
        )
        tracked = {"number": 8940, "body": ""}
        with tempfile.TemporaryDirectory() as tmp:
            findings = Path(tmp) / "findings.json"
            report = Path(tmp) / "report.json"
            findings.write_text(json.dumps({"causes": [skipped]}))
            report.write_text(json.dumps({"torch_version_minor": "2.15"}))
            argv = [
                "filer",
                "--findings",
                str(findings),
                "--report",
                str(report),
                "--execute",
            ]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.dict(os.environ, {"GITHUB_TOKEN": "tok"}),
                mock.patch.object(vtfi, "find_umbrella", return_value={"number": 1}),
                mock.patch.object(vtfi, "open_children", return_value=[tracked]),
                mock.patch.object(
                    vtfi, "find_existing", return_value=(tracked, "near-duplicate")
                ),
                mock.patch.object(vtfi, "record_recurrence") as record,
                mock.patch.object(vtfi, "report_silences") as silences,
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(vtfi.main(), 0)
        record.assert_called_once()
        self.assertIn("routing=`infra`", record.call_args.args[6])
        # ...and the silence check treats it as matched.
        self.assertIn(8940, silences.call_args.args[4])

    def test_recurrence_comment_carries_the_note(self):
        body = vtfi.recurrence_comment(
            {"torch_nightly_build": 93069}, cause(), [], [], "key", "NOTE-TEXT"
        )
        self.assertIn("Still reproducing on torch-nightly build", body)
        self.assertIn("NOTE-TEXT", body)


class TestMaxIssues(unittest.TestCase):
    """--max-issues caps new issues; recurrences on tracked ones are not counted."""

    def _run(self, causes, existing):
        with tempfile.TemporaryDirectory() as tmp:
            findings = Path(tmp) / "findings.json"
            report = Path(tmp) / "report.json"
            findings.write_text(json.dumps({"causes": causes}))
            report.write_text(json.dumps({"torch_version_minor": "2.15"}))
            argv = [
                "filer",
                "--findings",
                str(findings),
                "--report",
                str(report),
                "--max-issues",
                "1",
                "--execute",
            ]
            output = io.StringIO()
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.dict(os.environ, {"GITHUB_TOKEN": "tok"}),
                mock.patch.object(vtfi, "find_umbrella", return_value={"number": 1}),
                mock.patch.object(vtfi, "open_children", return_value=[]),
                mock.patch.object(vtfi, "find_existing", side_effect=existing),
                mock.patch.object(vtfi, "_req", return_value={"number": 99}) as req,
                mock.patch.object(vtfi, "append_to_umbrella"),
                mock.patch.object(vtfi, "record_recurrence") as record,
                mock.patch.object(vtfi, "report_silences") as silences,
                contextlib.redirect_stdout(output),
            ):
                self.assertEqual(vtfi.main(), 0)
        return req, record, silences, output.getvalue()

    def test_recurrences_do_not_use_up_the_cap(self):
        causes = [
            cause(title=f"cause {i}", signature=f"E{i}Error: x") for i in range(3)
        ]
        existing = [({"number": 10}, "key"), ({"number": 11}, "key"), (None, "key")]
        req, record, silences, _ = self._run(causes, existing)
        self.assertEqual(record.call_count, 2)
        self.assertEqual(req.call_count, 1)  # the one new issue
        self.assertEqual(silences.call_args.args[4], {10, 11, 99})

    def test_new_issues_past_the_cap_are_not_filed(self):
        causes = [
            cause(title=f"cause {i}", signature=f"E{i}Error: x") for i in range(3)
        ]
        req, record, _, out = self._run(causes, [(None, "key")] * 3)
        record.assert_not_called()
        self.assertEqual(req.call_count, 1)
        self.assertIn("(2 not filed this run)", out)


def _http_error(code, reason="Forbidden", **headers):
    msg = email.message.Message()
    for name, value in headers.items():
        msg[name.replace("_", "-")] = value
    return urllib.error.HTTPError("https://api.github.com/x", code, reason, msg, None)


class TestRateLimit(unittest.TestCase):
    """_req waits out GitHub rate limits instead of failing the run."""

    def setUp(self):
        ok = mock.MagicMock()
        ok.__enter__.return_value.read.return_value = b'{"ok": true}'
        self.ok = ok
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.sleep = stack.enter_context(mock.patch.object(vtfi.time, "sleep"))
        stack.enter_context(mock.patch.object(vtfi, "_last_search", 0.0))
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def test_retry_after_is_honoured(self):
        errors = [_http_error(403, Retry_After="7"), self.ok]
        with mock.patch.object(vtfi.urllib.request, "urlopen", side_effect=errors):
            self.assertEqual(vtfi._req("GET", "/repos/x", "tok"), {"ok": True})
        self.sleep.assert_called_once_with(7.0)

    def test_secondary_limit_without_headers_backs_off(self):
        errors = [_http_error(429, "Too Many Requests"), self.ok]
        with mock.patch.object(vtfi.urllib.request, "urlopen", side_effect=errors):
            vtfi._req("POST", "/repos/x/issues", "tok", {"title": "t"})
        self.sleep.assert_called_once_with(60.0)

    def test_permission_error_is_not_retried(self):
        with (
            mock.patch.object(
                vtfi.urllib.request, "urlopen", side_effect=[_http_error(403)]
            ),
            self.assertRaises(urllib.error.HTTPError),
        ):
            vtfi._req("GET", "/repos/x", "tok")
        self.sleep.assert_not_called()

    def test_wait_past_the_ceiling_raises(self):
        reset = str(int(vtfi.time.time()) + 3600)
        err = _http_error(403, X_RateLimit_Remaining="0", X_RateLimit_Reset=reset)
        with (
            mock.patch.object(vtfi.urllib.request, "urlopen", side_effect=[err]),
            self.assertRaises(urllib.error.HTTPError),
        ):
            vtfi._req("GET", "/repos/x", "tok")
        self.sleep.assert_not_called()

    def test_searches_are_paced(self):
        with mock.patch.object(
            vtfi.urllib.request, "urlopen", side_effect=[self.ok, self.ok]
        ):
            vtfi._req("GET", "/search/issues?q=a", "tok")
            vtfi._req("GET", "/search/issues?q=b", "tok")
        self.assertEqual(self.sleep.call_count, 1)
        self.assertGreater(self.sleep.call_args.args[0], 0)


class TestInsertInSection(unittest.TestCase):
    # The live #8610 body: the vLLM section precedes the torch one, so
    # appending at the end of the body files everything as a torch regression.
    BODY = (
        "## torch 2.15 nightly - vLLM CI regressions\n\n"
        "### Method\n\nsome prose\n\n"
        "### Regression on vLLM side\n\n"
        "- [ ]  https://github.com/vllm-project/vllm/issues/58599\n\n"
        "### Confirmed regressions\n\n"
        "- [ ] #8745 - qk-norm+rope fusion pass matches zero times\n"
    )

    def _lines_under(self, body, section):
        rest = body.partition(section)[2]
        nxt = re.search(r"^### ", rest, re.M)
        chunk = rest[: nxt.start()] if nxt else rest
        return [ln for ln in chunk.splitlines() if ln.startswith("- [")]

    def test_vllm_entry_lands_in_the_vllm_section(self):
        out = vtfi.insert_in_section(
            self.BODY, vtfi.SECTIONS["vllm-project/vllm"], "- [ ] #9001 - minimax"
        )
        self.assertIn(
            "- [ ] #9001 - minimax",
            self._lines_under(out, "### Regression on vLLM side"),
        )
        # ...and did not leak into the torch list.
        self.assertEqual(
            self._lines_under(out, "### Confirmed regressions"),
            ["- [ ] #8745 - qk-norm+rope fusion pass matches zero times"],
        )

    def test_torch_entry_lands_in_the_torch_section(self):
        out = vtfi.insert_in_section(
            self.BODY, vtfi.SECTIONS["pytorch/pytorch"], "- [ ] #9002 - inductor"
        )
        self.assertEqual(
            self._lines_under(out, "### Confirmed regressions"),
            [
                "- [ ] #8745 - qk-norm+rope fusion pass matches zero times",
                "- [ ] #9002 - inductor",
            ],
        )
        self.assertEqual(len(self._lines_under(out, "### Regression on vLLM side")), 1)

    def test_existing_entry_is_not_duplicated(self):
        line = "- [ ] #8745 - qk-norm+rope fusion pass matches zero times"
        self.assertEqual(
            vtfi.insert_in_section(self.BODY, vtfi.SECTIONS["pytorch/pytorch"], line),
            self.BODY,
        )

    def test_missing_section_is_created(self):
        body = "## title\n\n### Confirmed regressions\n\n- [ ] #1 - a\n"
        out = vtfi.insert_in_section(
            body, vtfi.SECTIONS["vllm-project/vllm"], "- [ ] #2 - b"
        )
        self.assertIn("### Regression on vLLM side", out)
        self.assertIn("- [ ] #2 - b", self._lines_under(out, "### Regression on vLLM"))

    def test_the_template_ships_both_sections(self):
        body = vtfi.umbrella_body("2.15", {})
        for s in vtfi.SECTIONS.values():
            self.assertIn(s, body)


class TestNearDuplicate(unittest.TestCase):
    """The rewording case the key cannot catch, from #8808 and #8817."""

    B200 = [":nvidia: (B200) Distributed", ":nvidia: (B200) FusedMoE Layer Kernels"]

    def _issue(self, number, signature, clusters):
        body = (
            f"## Signature\n\n```\n{signature}\n```\n\n"
            "## Affected job clusters\n\n"
            + "\n".join(f"- `{c}`" for c in clusters)
            + "\n\n## Suggested routing\n\npytorch/pytorch\n"
        )
        return {"number": number, "body": body}

    def test_reworded_same_cause_is_matched(self):
        child = self._issue(
            8808,
            "RuntimeError: DeepEPv2 communicator properties query failed; "
            "networking capability could not be determined.",
            self.B200,
        )
        cause = {
            "signature": "RuntimeError: Failed to determine NCCL GIN support",
            "clusters": list(reversed(self.B200)),
        }
        self.assertEqual(near_duplicate(cause, [child])["number"], 8808)

    def test_different_exception_type_is_not_a_duplicate(self):
        child = self._issue(8808, "RuntimeError: boom", self.B200)
        cause = {"signature": "AssertionError: boom", "clusters": list(self.B200)}
        self.assertIsNone(near_duplicate(cause, [child]))

    def test_disjoint_clusters_are_not_a_duplicate(self):
        child = self._issue(8808, "RuntimeError: boom", self.B200)
        cause = {
            "signature": "RuntimeError: something else",
            "clusters": [":amd: (MI355) LM Eval Spec Decode"],
        }
        self.assertIsNone(near_duplicate(cause, [child]))

    def test_a_single_shared_cluster_out_of_many_is_not_enough(self):
        child = self._issue(8808, "RuntimeError: boom", self.B200)
        cause = {
            "signature": "RuntimeError: unrelated",
            "clusters": [
                ":nvidia: (B200) Distributed",
                ":amd: (MI355) LM Eval Spec Decode",
                ":nvidia: (L4) PyTorch Compilation Passes",
                ":nvidia: (H100) Fusion E2E Quick",
            ],
        }
        self.assertIsNone(near_duplicate(cause, [child]))

    def test_children_are_scoped_to_one_torch_minor(self):
        # A cause from the current cycle must not land on last cycle's issue.
        # near_duplicate() matches on exception type and clusters alone, so the
        # scoping has to happen when the candidates are fetched.
        items = [
            {"number": 8000, "title": "[vllm][torch 2.14] older cause", "body": ""},
            {"number": 8900, "title": "[vllm][torch 2.15] current cause", "body": ""},
        ]
        with mock.patch.object(vtfi, "_req", return_value={"items": items}):
            self.assertEqual(
                [i["number"] for i in vtfi.open_children("t", "r", "2.15")], [8900]
            )
            self.assertEqual(
                [i["number"] for i in vtfi.open_children("t", "r")], [8000, 8900]
            )

    def test_signature_without_an_exception_type_never_matches(self):
        child = self._issue(8808, "RuntimeError: boom", self.B200)
        cause = {"signature": "something went wrong", "clusters": list(self.B200)}
        self.assertIsNone(near_duplicate(cause, [child]))


class TestMergeClusters(unittest.TestCase):
    BODY = (
        "## Signature\n\n```\nRuntimeError: boom\n```\n\n"
        "## Affected job clusters\n\n- `:nvidia: (B200) Distributed`\n\n"
        "## Suggested routing\n\npytorch/pytorch\n"
    )

    def test_new_cluster_is_appended_and_reported(self):
        merged, added = merge_clusters(
            self.BODY,
            [":nvidia: (B200) Distributed", ":amd: (MI355) LM Eval Spec Decode"],
        )
        self.assertEqual(added, [":amd: (MI355) LM Eval Spec Decode"])
        self.assertEqual(
            issue_clusters(merged),
            [":nvidia: (B200) Distributed", ":amd: (MI355) LM Eval Spec Decode"],
        )
        # The surrounding template must survive the rewrite.
        self.assertIn("## Suggested routing", merged)
        self.assertIn("RuntimeError: boom", merged)

    def test_known_cluster_is_a_no_op(self):
        merged, added = merge_clusters(self.BODY, [":nvidia: (B200) Distributed"])
        self.assertEqual(added, [])
        self.assertEqual(merged, self.BODY)


class TestReportSilences(unittest.TestCase):
    """A cause is only called quiet when its clusters actually ran and passed."""

    MINOR = "2.15"

    def _child(self, number, clusters):
        body = (
            "## Signature\n\n```\nRuntimeError: boom\n```\n\n"
            "## Affected job clusters\n\n"
            + "\n".join(f"- `{c}`" for c in clusters)
            + "\n"
        )
        return {
            "number": number,
            "title": f"[vllm][torch {self.MINOR}] something broke",
            "body": body,
        }

    def _run(self, report, children, matched=frozenset()):
        posted = []

        def fake_req(method, path, token, body=None):
            if method == "GET" and "/comments" in path:
                return []
            posted.append((method, path, body))
            return {}

        with mock.patch.object(vtfi, "_req", side_effect=fake_req):
            vtfi.report_silences(
                "t", "pytorch/test-infra", report, children, set(matched), self.MINOR
            )
        return posted

    def test_all_clusters_passed_is_reported(self):
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        posted = self._run(
            {
                "torch_nightly_build": 90640,
                "baseline_build": 90589,
                "passed": [":nvidia: (B200) Distributed"],
            },
            [child],
        )
        self.assertEqual(len(posted), 1)
        body = posted[0][2]["body"]
        self.assertIn("Did not reproduce", body)
        self.assertIn("First quiet run", body)
        self.assertIn(f"<!-- {vtfi.SILENT_PREFIX}: 1 -->", body)

    def test_a_cluster_that_did_not_run_is_not_a_fix(self):
        # The regression-vs-missing-coverage trap: absence from the failing
        # buckets is not evidence of a pass.
        child = self._child(
            8784,
            [":nvidia: (B200) Distributed", ":amd: (MI355) LM Eval Spec Decode"],
        )
        posted = self._run(
            {
                "torch_nightly_build": 90640,
                "baseline_build": 90589,
                "passed": [":nvidia: (B200) Distributed"],
            },
            [child],
        )
        self.assertEqual(posted, [])

    def test_a_cause_that_reproduced_is_not_reported_quiet(self):
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        posted = self._run(
            {
                "torch_nightly_build": 90640,
                "baseline_build": 90589,
                "passed": [":nvidia: (B200) Distributed"],
            },
            [child],
            matched={8784},
        )
        self.assertEqual(posted, [])

    def test_other_torch_versions_are_left_alone(self):
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        child["title"] = "[vllm][torch 2.14] something broke"
        posted = self._run(
            {
                "torch_nightly_build": 90640,
                "baseline_build": 90589,
                "passed": [":nvidia: (B200) Distributed"],
            },
            [child],
        )
        self.assertEqual(posted, [])

    def test_a_report_without_passed_data_says_nothing(self):
        # An older report.json predating the `passed` field must not be read
        # as "every tracked cause is fixed".
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        posted = self._run(
            {"torch_nightly_build": 90640, "baseline_build": 90589}, [child]
        )
        self.assertEqual(posted, [])

    def test_streak_stops_repeating_past_the_limit(self):
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        report = {
            "torch_nightly_build": 90640,
            "baseline_build": 90589,
            "passed": [":nvidia: (B200) Distributed"],
        }
        posted = []

        def fake_req(method, path, token, body=None):
            if method == "GET" and "/comments" in path:
                return [
                    {
                        "body": f"<!-- {vtfi.SILENT_PREFIX}: "
                        f"{vtfi.SILENT_COMMENT_LIMIT} -->"
                    }
                ]
            posted.append((method, path, body))
            return {}

        with mock.patch.object(vtfi, "_req", side_effect=fake_req):
            vtfi.report_silences(
                "t", "pytorch/test-infra", report, [child], set(), self.MINOR
            )
        self.assertEqual(posted, [])

    def test_a_recurrence_resets_the_streak(self):
        child = self._child(8784, [":nvidia: (B200) Distributed"])
        report = {
            "torch_nightly_build": 90640,
            "baseline_build": 90589,
            "passed": [":nvidia: (B200) Distributed"],
        }
        posted = []

        def fake_req(method, path, token, body=None):
            if method == "GET" and "/comments" in path:
                return [
                    {"body": f"<!-- {vtfi.SILENT_PREFIX}: 2 -->"},
                    {"body": "Still reproducing on torch-nightly build [#1](x)."},
                ]
            posted.append((method, path, body))
            return {}

        with mock.patch.object(vtfi, "_req", side_effect=fake_req):
            vtfi.report_silences(
                "t", "pytorch/test-infra", report, [child], set(), self.MINOR
            )
        self.assertIn(f"<!-- {vtfi.SILENT_PREFIX}: 1 -->", posted[0][2]["body"])


if __name__ == "__main__":
    unittest.main()
