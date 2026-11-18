import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest import main, mock, TestCase


sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "analytics"))

from analytics.nightly_scan import (  # noqa: E402
    failed_job_lines,
    job_category,
    JOBS_PER_PAGE,
    latest_finished_commit,
    latest_rc,
    nightly_result,
    nightly_step_rows,
    rc_runs,
    rc_step_rows,
    run_jobs,
    viable_strict_result,
    viable_strict_step_rows,
)

from torchci import release_portal_config as cfg  # noqa: E402


NOW = datetime(2026, 11, 17, 14, 0, tzinfo=timezone.utc)
DOCKER = ".github/workflows/docker-release.yml"
WHEEL = ".github/workflows/generated-linux-binary-manywheel-nightly.yml"


def run(
    rid, sha, created, name="linux-binary-manywheel", path=WHEEL, status="completed"
):
    return {
        "id": rid,
        "head_sha": sha * 40,
        "created_at": created,
        "status": status,
        "name": name,
        "path": path,
    }


def job(name, conclusion="success"):
    return {"name": name, "conclusion": conclusion, "status": "completed"}


GREEN_JOBS = {
    1: [
        job("manywheel-py3_10-cpu-build"),
        job("libtorch-cpu-shared-with-deps-release-build"),
    ],
    2: [job("build (cpu, runtime)"), job("generate-matrix", "skipped")],
}


def finished(sha="a", day="2026-11-16"):
    return [
        run(1, sha, f"{day}T07:00:00Z"),
        run(2, sha, f"{day}T07:01:00Z", "Build Official Docker Images", DOCKER),
    ]


def result(runs, jobs):
    return nightly_result("pytorch/pytorch", "nightly", runs, lambda r: jobs[r["id"]])


class TestJobCategory(TestCase):
    def test_docker_libtorch_and_wheel(self):
        self.assertEqual(job_category(DOCKER, "build (cpu)"), "docker")
        self.assertEqual(
            job_category(WHEEL, "libtorch-cpu-shared-build / build"), "libtorch"
        )
        self.assertEqual(
            job_category(WHEEL, "manywheel-py3_10-cuda13_4-build"), "wheel"
        )


class TestLatestFinishedCommit(TestCase):
    def test_the_newest_commit_when_it_has_finished(self):
        runs = finished("a", "2026-11-15") + finished("b", "2026-11-16")
        sha, found, passed_over = latest_finished_commit(runs)
        self.assertEqual(sha, "b" * 40)
        self.assertEqual(len(found), 2)
        self.assertIsNone(passed_over)

    def test_an_unfinished_newest_commit_is_passed_over(self):
        runs = finished("a", "2026-11-16") + [
            run(3, "b", "2026-11-17T07:00:00Z", status="in_progress")
        ]
        sha, _, passed_over = latest_finished_commit(runs)
        self.assertEqual(sha, "a" * 40)
        self.assertEqual(passed_over, "b" * 40)

    def test_nothing_finished_and_nothing_at_all(self):
        sha, found, newest = latest_finished_commit(
            [run(3, "b", "2026-11-17T07:00:00Z", status="queued")]
        )
        self.assertEqual((sha, found, newest), (None, [], "b" * 40))
        self.assertEqual(latest_finished_commit([]), (None, [], None))


class TestResult(TestCase):
    def test_done_when_all_three_builds_are_green(self):
        status, text, url, details = result(finished(), GREEN_JOBS)
        self.assertEqual(status, "done")
        self.assertIn("wheel, libtorch and docker builds are green", text)
        self.assertIn("nightly 2026-11-16", text)
        self.assertEqual(
            url, "https://hud.pytorch.org/hud/pytorch/pytorch/nightly/1?per_page=50"
        )
        self.assertEqual(details["jobs"], {"wheel": 1, "libtorch": 1, "docker": 1})
        self.assertEqual(details["failed"], [])

    def test_a_failed_job_blocks_the_step_and_is_listed(self):
        jobs = {**GREEN_JOBS, 2: [job("build (13.4, runtime)", "failure")]}
        status, text, _, details = result(finished(), jobs)
        self.assertEqual(status, "blocked")
        self.assertIn("docker 1 failed", text)
        self.assertEqual(
            details["failed"][0]["workflow"], "Build Official Docker Images"
        )
        self.assertEqual(details["failed"][0]["conclusion"], "failure")

    def test_a_cancelled_job_is_not_green(self):
        jobs = {
            **GREEN_JOBS,
            1: [
                job("manywheel-py3_10-cpu-build", "cancelled"),
                job("libtorch-cpu-build"),
            ],
        }
        status, text, _, _ = result(finished(), jobs)
        self.assertEqual(status, "blocked")
        self.assertIn("wheel 1 failed", text)

    def test_a_missing_category_is_not_green(self):
        jobs = {1: [job("manywheel-py3_10-cpu-build")], 2: GREEN_JOBS[2]}
        status, text, _, _ = result(finished(), jobs)
        self.assertEqual(status, "blocked")
        self.assertIn("no libtorch jobs", text)

    def test_the_latest_finished_commit_replaces_older_results(self):
        old = [dict(r, id=r["id"] + 10) for r in finished("a", "2026-11-15")]
        jobs = {
            1: GREEN_JOBS[1],
            2: [job("build (cpu)", "failure")],
            11: GREEN_JOBS[1],
            12: GREEN_JOBS[2],
        }
        # the old commit was red and the new one is green, and the other way round
        status, _, _, details = result(old + finished("b", "2026-11-16"), jobs)
        self.assertEqual((status, details["sha"]), ("blocked", "b" * 40))
        jobs[1], jobs[2] = GREEN_JOBS[1], GREEN_JOBS[2]
        jobs[12] = [job("build (cpu)", "failure")]
        status, _, _, details = result(old + finished("b", "2026-11-16"), jobs)
        self.assertEqual((status, details["sha"]), ("done", "b" * 40))

    def test_a_running_newest_commit_is_reported_beside_the_finished_one(self):
        runs = finished("a") + [
            run(3, "b", "2026-11-17T07:00:00Z", status="in_progress")
        ]
        status, _, _, details = result(runs, {**GREEN_JOBS, 3: []})
        self.assertEqual(status, "done")
        self.assertEqual(details["newer_commit_running"], "b" * 40)

    def test_a_failure_on_the_running_newest_commit_is_reported_at_once(self):
        # a run that is re-run stays open, but the job that failed is what the nightly is
        runs = finished("a") + [
            run(3, "b", "2026-11-17T07:00:00Z", status="completed"),
            run(
                4,
                "b",
                "2026-11-17T07:01:00Z",
                "windows-binary-wheel",
                status="in_progress",
            ),
        ]
        jobs = {
            **GREEN_JOBS,
            3: [job("manywheel-py3_11-xpu-test / test", "failure")],
            4: [
                job("wheel-py3_11-cpu-build"),
                {
                    "name": "wheel-py3_11-cuda13_5-test",
                    "conclusion": None,
                    "status": "in_progress",
                },
            ],
        }
        status, text, _, details = result(runs, jobs)
        self.assertEqual(status, "blocked")
        self.assertIn("nightly 2026-11-17", text)
        self.assertIn("wheel 1 failed", text)
        self.assertIn("still going", text)
        self.assertEqual(details["sha"], "b" * 40)
        self.assertTrue(details["still_running"])
        # the job that is running is not counted, neither as run nor as failed
        self.assertEqual(details["jobs"]["wheel"], 2)

    def test_a_running_commit_with_nothing_failed_yet_leaves_the_finished_result(self):
        runs = finished("a") + [
            run(3, "b", "2026-11-17T07:00:00Z", status="in_progress")
        ]
        jobs = {
            **GREEN_JOBS,
            3: [
                {
                    "name": "wheel-py3_11-cpu-build",
                    "conclusion": None,
                    "status": "in_progress",
                }
            ],
        }
        status, _, _, details = result(runs, jobs)
        self.assertEqual((status, details["sha"]), ("done", "a" * 40))
        self.assertFalse(details["still_running"])

    def test_a_failure_on_a_commit_with_nothing_finished_is_reported(self):
        runs = [run(3, "b", "2026-11-17T07:00:00Z", status="in_progress")]
        jobs = {3: [job("wheel-py3_11-cpu-build", "failure")]}
        status, text, _, _ = result(runs, jobs)
        self.assertEqual(status, "blocked")
        self.assertIn("not green", text)

    def test_nothing_finished_yet_and_no_runs(self):
        status, text, _, _ = result(
            [run(3, "b", "2026-11-17T07:00:00Z", status="in_progress")], {3: []}
        )
        self.assertEqual(status, "in_progress")
        self.assertIn("still running", text)
        status, text, _, _ = result([], {})
        self.assertEqual(status, "todo")


class TestRows(TestCase):
    config = {
        "steps": [
            {"id": "1.2", "check": {"type": "milestone_outstanding_items"}},
            {
                "id": "1.5",
                "check": {
                    "type": "nightly_binaries",
                    "repo": "pytorch/pytorch",
                    "branch": "nightly",
                },
            },
        ]
    }

    def test_a_blocked_step_is_written_with_the_blocking_flag(self):
        rows = nightly_step_rows(
            "2.16.0",
            self.config,
            lambda repo, branch: ("blocked", "docker 1 failed", "https://hud", {}),
            "0" * 40,
            "1-1",
            "https://run",
            NOW,
        )
        self.assertEqual((rows[0]["status"], rows[0]["blocking"]), ("blocked", 1))
        rows = nightly_step_rows(
            "2.16.0",
            self.config,
            lambda repo, branch: ("in_progress", "still running", "https://hud", {}),
            "0" * 40,
            "1-1",
            "https://run",
            NOW,
        )
        self.assertEqual((rows[0]["status"], rows[0]["blocking"]), ("in_progress", 0))

    def test_one_collector_row_per_nightly_step(self):
        seen = []

        def result_for(repo, branch):
            seen.append((repo, branch))
            return "done", "green", "https://hud", {"sha": "a"}

        rows = nightly_step_rows(
            "2.16.0", self.config, result_for, "0" * 40, "1-1", "https://run", NOW
        )
        self.assertEqual(seen, [("pytorch/pytorch", "nightly")])
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            {
                k: rows[0][k]
                for k in (
                    "release",
                    "step_id",
                    "rc",
                    "status",
                    "blocking",
                    "check_type",
                    "source",
                )
            },
            {
                "release": "2.16.0",
                "step_id": "1.5",
                "rc": "",
                "status": "done",
                "blocking": 0,
                "check_type": "nightly_binaries",
                "source": "collector",
            },
        )
        self.assertEqual(json.loads(rows[0]["details"]), {"sha": "a"})
        self.assertEqual(rows[0]["observed_at"], "2026-11-17 14:00:00.000")


def heads(base_date, branch_date):
    commits = {
        "main": {"sha": "m" * 40, "date": base_date},
        "viable/strict": {"sha": "v" * 40, "date": branch_date},
    }
    return lambda branch: commits[branch]


def lag(base_date, branch_date, max_hours=12):
    return viable_strict_result(
        "pytorch/pytorch",
        "viable/strict",
        "main",
        max_hours,
        heads(base_date, branch_date),
    )


class TestViableStrictLag(TestCase):
    def test_done_when_less_than_the_limit_behind(self):
        status, text, url, details = lag("2026-11-17T12:00:00Z", "2026-11-17T01:30:00Z")
        self.assertEqual(status, "done")
        self.assertIn("viable/strict is 10.5 hours behind main", text)
        self.assertEqual(details["hours_behind"], 10.5)
        self.assertEqual(
            url,
            "https://github.com/pytorch/pytorch/compare/" + "v" * 40 + "..." + "m" * 40,
        )

    def test_blocked_at_the_limit_and_beyond(self):
        status, text, _, details = lag("2026-11-17T12:00:00Z", "2026-11-17T00:00:00Z")
        self.assertEqual(status, "blocked")
        self.assertIn("12.0 hours behind main", text)
        self.assertIn("12 or more", text)
        self.assertEqual(details["max_hours"], 12)
        status, _, _, details = lag("2026-11-17T12:00:00Z", "2026-11-14T12:00:00Z")
        self.assertEqual((status, details["hours_behind"]), ("blocked", 72.0))

    def test_not_behind_at_all(self):
        status, _, _, details = lag("2026-11-17T12:00:00Z", "2026-11-17T12:00:00Z")
        self.assertEqual((status, details["hours_behind"]), ("done", 0.0))
        # a clock skew never gives a negative lag
        _, _, _, details = lag("2026-11-17T12:00:00Z", "2026-11-17T12:05:00Z")
        self.assertEqual(details["hours_behind"], 0.0)

    def test_rows_are_written_with_the_blocking_flag_when_blocked(self):
        config = cfg.load_resolved("2.16.0")
        for stale, blocking in ((True, 1), (False, 0)):
            rows = viable_strict_step_rows(
                "2.16.0",
                config,
                lambda check: lag(
                    "2026-11-17T12:00:00Z",
                    "2026-11-16T00:00:00Z" if stale else "2026-11-17T11:00:00Z",
                    check["max_hours"],
                ),
                "0" * 40,
                "1-1",
                "https://run",
                NOW,
            )
            self.assertEqual([r["step_id"] for r in rows], ["1.4"])
            self.assertEqual(rows[0]["check_type"], "viable_strict_lag")
            self.assertEqual(rows[0]["blocking"], blocking)
            self.assertEqual(rows[0]["status"], "blocked" if stale else "done")


TAG = "v2.15.0-rc10"
RC_URL = "https://hud.pytorch.org/hud/pytorch/pytorch/release%2F2.15/1?per_page=50"


def rc_result(runs, jobs):
    return nightly_result("pytorch/pytorch", TAG, runs, lambda r: jobs[r["id"]], RC_URL)


class TestRcBinaries(TestCase):
    def test_green_candidate_is_done_and_links_to_the_release_branch(self):
        status, text, url, details = rc_result(finished(), GREEN_JOBS)
        self.assertEqual(status, "done")
        self.assertIn(f"green on {TAG} 2026-11-16", text)
        self.assertEqual(url, RC_URL)
        self.assertEqual(details["branch"], TAG)

    def test_a_failed_build_is_blocked(self):
        jobs = {**GREEN_JOBS, 1: [job("wheel-py3_11-cuda13_5-build", "failure")]}
        status, text, _, _ = rc_result(finished(), jobs)
        self.assertEqual(status, "blocked")
        self.assertIn(f"not green on {TAG}", text)

    def test_runs_of_the_tag_are_the_binary_and_docker_workflows(self):
        windows = ".github/workflows/generated-windows-binary-wheel-nightly.yml"
        images = ".github/workflows/build-manywheel-images.yml"

        def tagged(rid, path, branch=TAG, event="push"):
            return dict(
                run(rid, "d", "2026-11-16T07:00:00Z", path=path),
                **{
                    "head_branch": branch,
                    "event": event,
                },
            )

        listed = [
            tagged(1, WHEEL),
            tagged(2, windows),
            tagged(3, DOCKER),
            tagged(4, images),
            tagged(5, ".github/workflows/pull.yml"),
            tagged(6, WHEEL, branch="release/2.15"),
            tagged(7, WHEEL, event="workflow_dispatch"),
        ]
        with mock.patch(
            "analytics.nightly_scan.github_get",
            return_value={"workflow_runs": listed},
        ) as get:
            found = rc_runs("pytorch/pytorch", TAG, "d" * 40)
        self.assertEqual([r["id"] for r in found], [1, 2, 3])
        self.assertIn("head_sha=" + "d" * 40, get.call_args[0][0])

    def refs(self, names, kind="commit"):
        return [
            {
                "ref": f"refs/tags/{n}",
                "object": {"sha": f"{i:040d}", "type": kind},
            }
            for i, n in enumerate(names)
        ]

    def test_the_newest_candidate_is_found_by_number(self):
        refs = self.refs(
            ["v2.15.0-rc2", "v2.15.0-rc10", "v2.15.0-rc9", "v2.15.0-rc10-x"]
        )
        with mock.patch("analytics.nightly_scan.github_get", return_value=refs):
            rc, tag, sha = latest_rc("pytorch/pytorch", "2.15.0")
        self.assertEqual((rc, tag, sha), ("rc10", "v2.15.0-rc10", f"{1:040d}"))

    def test_no_candidate_yet(self):
        with mock.patch("analytics.nightly_scan.github_get", return_value=[]):
            self.assertIsNone(latest_rc("pytorch/pytorch", "2.16.0"))

    def test_an_annotated_tag_is_followed_to_its_commit(self):
        calls = []

        def get(path):
            calls.append(path)
            if "matching-refs" in path:
                return self.refs(["v2.15.0-rc1"], "tag")
            return {"object": {"sha": "c" * 40}}

        with mock.patch("analytics.nightly_scan.github_get", get):
            self.assertEqual(
                latest_rc("pytorch/pytorch", "2.15.0"),
                ("rc1", "v2.15.0-rc1", "c" * 40),
            )
        self.assertEqual(calls[1], f"repos/pytorch/pytorch/git/tags/{0:040d}")

    config = {
        "steps": [
            {"id": "2.1", "check": {"type": "github_ref_exists"}},
            {"id": "2.3", "check": {"type": "rc_binaries", "repo": "pytorch/pytorch"}},
        ]
    }

    def rows(self, found):
        return rc_step_rows(
            "2.15.0",
            self.config,
            lambda repo, version: found,
            "0" * 40,
            "1-1",
            "",
            NOW,
        )

    def test_the_row_is_rc_scoped_and_blocking_when_blocked(self):
        blocked = ("blocked", "not green", RC_URL, {})
        rows = self.rows(("rc10", blocked))
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            {
                k: rows[0][k]
                for k in ("step_id", "rc", "status", "blocking", "check_type")
            },
            {
                "step_id": "2.3",
                "rc": "rc10",
                "status": "blocked",
                "blocking": 1,
                "check_type": "rc_binaries",
            },
        )
        rows = self.rows(("rc10", ("done", "green", RC_URL, {})))
        self.assertEqual((rows[0]["status"], rows[0]["blocking"]), ("done", 0))

    def test_no_row_before_the_first_candidate(self):
        self.assertEqual(self.rows(None), [])

    def test_failed_jobs_of_the_candidate_are_listed_under_its_tag(self):
        jobs = {**GREEN_JOBS, 1: [job("wheel-py3_11-cuda13_5-build", "failure")]}
        status, text, url, details = rc_result(finished(), jobs)
        rows = self.rows(("rc10", (status, text, url, details)))
        lines = failed_job_lines(rows)
        self.assertEqual(lines[0], f"Failed jobs on {TAG}:")
        self.assertIn("wheel-py3_11-cuda13_5-build: failure", lines[2])


class TestSummary(TestCase):
    def rows(self, jobs):
        status, text, url, details = result(finished(), jobs)
        return nightly_step_rows(
            "2.16.0",
            {
                "steps": [
                    {
                        "id": "1.5",
                        "check": {
                            "type": "nightly_binaries",
                            "repo": "pytorch/pytorch",
                            "branch": "nightly",
                        },
                    }
                ]
            },
            lambda repo, branch: (status, text, url, details),
            "0" * 40,
            "1-1",
            "",
            NOW,
        )

    def test_the_failed_jobs_are_listed_with_their_links(self):
        failing = job("build (13.4, runtime)", "failure")
        failing["html_url"] = "https://github.com/pytorch/pytorch/actions/runs/1/job/2"
        lines = failed_job_lines(self.rows({**GREEN_JOBS, 2: [failing]}))
        self.assertEqual(lines[0], "Failed jobs on nightly 2026-11-16:")
        self.assertEqual(
            lines[2],
            "- [Build Official Docker Images / build (13.4, runtime): failure]"
            "(https://github.com/pytorch/pytorch/actions/runs/1/job/2)",
        )

    def test_a_green_nightly_lists_nothing(self):
        self.assertEqual(failed_job_lines(self.rows(GREEN_JOBS)), [])
        self.assertEqual(failed_job_lines([]), [])


class TestRunJobs(TestCase):
    def fetch(self, total):
        """run_jobs of a run with `total` jobs, and the URLs it asked for."""
        urls = []

        def github_get(path):
            urls.append(path)
            query = dict(p.split("=") for p in path.split("?")[1].split("&"))
            per_page, page = int(query["per_page"]), int(query["page"])
            first = (page - 1) * per_page
            return {
                "jobs": [{"id": i} for i in range(first, min(first + per_page, total))]
            }

        with mock.patch("analytics.nightly_scan.github_get", github_get):
            return run_jobs("pytorch/pytorch", {"id": 7}), urls

    def test_pages_are_small_enough_for_github_to_answer(self):
        # a page of 100 jobs of the manywheel nightly (112 jobs, 228 with the earlier
        # attempts) is a 502 from GitHub every time; 30 is not
        self.assertLessEqual(JOBS_PER_PAGE, 30)

    def test_every_page_is_read_and_the_latest_attempts_are_asked_for(self):
        jobs, urls = self.fetch(112)
        self.assertEqual([j["id"] for j in jobs], list(range(112)))
        self.assertEqual(len(urls), -(-112 // JOBS_PER_PAGE))
        for url in urls:
            self.assertIn("filter=latest", url)

    def test_a_run_with_a_whole_number_of_pages_ends_on_an_empty_one(self):
        jobs, urls = self.fetch(2 * JOBS_PER_PAGE)
        self.assertEqual(len(jobs), 2 * JOBS_PER_PAGE)
        self.assertEqual(len(urls), 3)


class TestConfig(TestCase):
    def test_step_2_3_checks_the_binaries_of_the_release_candidate(self):
        for release in ("2.16.0", "2.15.1"):
            steps = {s["id"]: s for s in cfg.load_resolved(release)["steps"]}
            self.assertEqual(
                steps["2.3"]["check"],
                {"type": "rc_binaries", "repo": "pytorch/pytorch"},
            )
            self.assertTrue(steps["2.3"]["rc_scoped"])

    def test_step_1_4_checks_how_far_viable_strict_is_behind_main(self):
        steps = {s["id"]: s for s in cfg.load_resolved("2.16.0")["steps"]}
        self.assertEqual(
            steps["1.4"]["check"],
            {
                "type": "viable_strict_lag",
                "repo": "pytorch/pytorch",
                "branch": "viable/strict",
                "base": "main",
                "max_hours": 12,
            },
        )
        for step_id in ("1.4", "1.5"):
            self.assertTrue(steps[step_id]["blocks_until_branch_cut"])
        patch = {s["id"] for s in cfg.load_resolved("2.15.1")["steps"]}
        self.assertNotIn("1.4", patch)

    def test_step_1_5_checks_the_pytorch_nightly(self):
        steps = {s["id"]: s for s in cfg.load_resolved("2.16.0")["steps"]}
        self.assertEqual(
            steps["1.5"]["check"],
            {
                "type": "nightly_binaries",
                "repo": "pytorch/pytorch",
                "branch": "nightly",
            },
        )
        patch = {s["id"] for s in cfg.load_resolved("2.15.1")["steps"]}
        self.assertNotIn("1.5", patch)


if __name__ == "__main__":
    main()
