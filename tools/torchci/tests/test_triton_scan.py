import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest import main, TestCase


sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "analytics"))

from analytics.triton_scan import (  # noqa: E402
    branch_result,
    pypi_result,
    triton_branch,
    triton_step_rows,
)

from torchci import release_portal_config as cfg  # noqa: E402


NOW = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)


def config(triton="3.9.0", branch="release/2.16"):
    return {
        "branch": branch,
        "versions": {"triton": triton, "torchvision": None, "torchaudio": None},
        "steps": [
            {"id": "1.1", "check": {"type": "triton_release_branch"}},
            {"id": "1.2", "check": {"type": "milestone_outstanding_items"}},
            {
                "id": "2.15",
                "check": {
                    "type": "pypi_release",
                    "package": "triton",
                    "version": "{triton_version}",
                },
            },
        ],
    }


def rows(cfg_, exists=True, pin=("aad2a60d95ff", "main"), landed=True, uploaded="x"):
    return triton_step_rows(
        "2.16.0",
        cfg_,
        lambda branch: exists,
        lambda release_branch: pin,
        lambda p, branch: landed,
        lambda package, version: (
            "2026-10-27T18:38:49Z" if uploaded == "x" else uploaded
        ),
        "0" * 40,
        "1-1",
        "https://example.com/run",
        NOW,
    )


class TestBranch(TestCase):
    def test_the_branch_of_a_triton_version(self):
        self.assertEqual(triton_branch("3.9.0"), "release/3.9.x")
        self.assertEqual(triton_branch("3.10.1"), "release/3.10.x")

    def test_done_when_the_branch_exists_and_the_pin_is_on_it(self):
        status, text, url, details = branch_result(
            "2.16.0",
            "3.9.0",
            "release/2.16",
            lambda b: True,
            lambda r: ("aad2a60d95ff", "release/2.16"),
            lambda pin, b: True,
        )
        self.assertEqual(status, "done")
        self.assertIn("release/3.9.x exists", text)
        self.assertIn("aad2a60d95", text)
        self.assertEqual(
            url, "https://github.com/triton-lang/triton/tree/release/3.9.x"
        )
        self.assertEqual(details["pin_read_from"], "release/2.16")

    def test_todo_without_the_branch_and_without_a_version(self):
        status, text, _, _ = branch_result(
            "2.16.0", "3.9.0", "release/2.16", lambda b: False, None, None
        )
        self.assertEqual(status, "todo")
        self.assertIn("no branch release/3.9.x", text)
        status, text, _, _ = branch_result(
            "2.16.0", None, "release/2.16", lambda b: True, None, None
        )
        self.assertEqual(status, "todo")
        self.assertIn("versions.triton is not set", text)

    def test_in_progress_while_the_pin_is_not_on_the_branch(self):
        for landed, why in ((False, "is not on it"), (None, "not a triton commit")):
            status, text, _, _ = branch_result(
                "2.16.0",
                "3.9.0",
                "release/2.16",
                lambda b: True,
                lambda r: ("b7ddcf86c0aa", "main"),
                lambda pin, b, landed=landed: landed,
            )
            self.assertEqual(status, "in_progress")
            self.assertIn(why, text)


class TestPypi(TestCase):
    def test_done_once_uploaded_and_todo_before(self):
        status, text, url, details = pypi_result(
            "triton", "3.9.0", "2.16.0", lambda v: "2026-10-27T18:38:49Z"
        )
        self.assertEqual(status, "done")
        self.assertIn("triton 3.9.0 is on PyPI (uploaded 2026-10-27)", text)
        self.assertEqual(url, "https://pypi.org/project/triton/3.9.0/")
        self.assertEqual(details["uploaded_at"], "2026-10-27T18:38:49Z")
        status, text, _, _ = pypi_result("triton", "3.9.0", "2.16.0", lambda v: None)
        self.assertEqual((status, text), ("todo", "triton 3.9.0 is not on PyPI"))

    def test_todo_without_a_version(self):
        status, text, _, _ = pypi_result("triton", None, "2.16.0", lambda v: "x")
        self.assertEqual(status, "todo")
        self.assertIn("versions.triton is not set", text)


class TestRows(TestCase):
    def test_one_row_per_triton_step_and_nothing_else(self):
        result = rows(config())
        self.assertEqual([r["step_id"] for r in result], ["1.1", "2.15"])
        first = result[0]
        self.assertEqual(first["status"], "done")
        self.assertEqual(first["check_type"], "triton_release_branch")
        self.assertEqual(first["source"], "collector")
        self.assertEqual(first["rc"], "")
        self.assertEqual(first["run_id"], "1-1")
        self.assertEqual(first["observed_at"], "2026-11-16 12:00:00.000")
        self.assertEqual(result[1]["check_type"], "pypi_release")
        self.assertEqual(result[1]["status"], "done")

    def test_a_release_without_a_triton_version_has_both_steps_to_do(self):
        result = rows(config(triton=None))
        self.assertEqual([r["status"] for r in result], ["todo", "todo"])
        self.assertTrue(all("versions.triton" in r["evidence_text"] for r in result))

    def test_the_branch_step_follows_the_branch_and_the_pin(self):
        self.assertEqual(rows(config(), exists=False)[0]["status"], "todo")
        self.assertEqual(rows(config(), landed=False)[0]["status"], "in_progress")
        self.assertEqual(rows(config(), uploaded=None)[1]["status"], "todo")

    def test_the_committed_steps_are_what_the_scan_reads(self):
        resolved = cfg.load_resolved("2.16.0")
        ids = {
            s["id"]: s["check"]["type"]
            for s in resolved["steps"]
            if s["check"]["type"] in ("triton_release_branch", "pypi_release")
        }
        self.assertEqual(ids, {"1.1": "triton_release_branch", "2.15": "pypi_release"})
        patch = cfg.load_resolved("2.15.1")
        self.assertEqual(
            [
                s["id"]
                for s in patch["steps"]
                if s["check"]["type"] in ("triton_release_branch", "pypi_release")
            ],
            ["2.15"],
        )


if __name__ == "__main__":
    main()
