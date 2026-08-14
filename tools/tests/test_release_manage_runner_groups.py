"""Unit tests for the pure logic in tools/scripts/release_manage_runner_groups.

Run from the repo root with either:
    python3 -m unittest discover -vs tools/tests -p 'test_*.py'
    pytest tools/tests/test_release_manage_runner_groups.py
"""

from unittest import main, TestCase

import tools.scripts.release_manage_runner_groups as m


class TestSelectTargetRefs(TestCase):
    def test_anchor_plus_preceding_release(self) -> None:
        names = [
            "main",
            "nightly",
            "release/2.9",
            "release/2.13",
            "release/2.12",
            "release/2.10",
            "gh/user/1/head",
        ]
        self.assertEqual(
            m.select_target_refs(names, (2, 13)),
            [
                "refs/heads/main",
                "refs/heads/nightly",
                "refs/heads/release/2.13",
                "refs/heads/release/2.12",
            ],
        )

    def test_excludes_release_branches_above_anchor(self) -> None:
        # A prematurely-cut release/2.14 must not be pinned before it is the
        # test-channel version.
        names = ["main", "nightly", "release/2.14", "release/2.13", "release/2.12"]
        self.assertEqual(
            m.select_target_refs(names, (2, 13)),
            [
                "refs/heads/main",
                "refs/heads/nightly",
                "refs/heads/release/2.13",
                "refs/heads/release/2.12",
            ],
        )

    def test_anchor_included_even_if_branch_not_in_scan(self) -> None:
        # Anchor comes from the test version, so it is pinned even if the branch
        # scan does not list it yet; preceding comes from the scan.
        names = ["main", "nightly", "release/2.12", "release/2.11"]
        self.assertEqual(
            m.select_target_refs(names, (2, 13)),
            [
                "refs/heads/main",
                "refs/heads/nightly",
                "refs/heads/release/2.13",
                "refs/heads/release/2.12",
            ],
        )

    def test_handles_missing_fixed_branches(self) -> None:
        self.assertEqual(
            m.select_target_refs(["release/2.12"], (2, 13)),
            ["refs/heads/release/2.13", "refs/heads/release/2.12"],
        )

    def test_ignores_ephemeral_nightly_branches(self) -> None:
        names = ["nightly", "nightly_20260224", "nightlykickoff", "release/2.13"]
        self.assertEqual(
            m.select_target_refs(names, (2, 13)),
            ["refs/heads/nightly", "refs/heads/release/2.13"],
        )

    def test_sorts_release_numerically_not_lexically(self) -> None:
        # 2.9 must rank below 2.10 despite string ordering.
        names = ["release/2.9", "release/2.10"]
        self.assertEqual(
            m.select_target_refs(names, (2, 10)),
            ["refs/heads/release/2.10", "refs/heads/release/2.9"],
        )


class TestReleaseLines(TestCase):
    def test_only_release_branches(self) -> None:
        refs = [
            "refs/heads/main",
            "refs/heads/nightly",
            "refs/heads/release/2.14",
            "refs/heads/release/2.13",
        ]
        self.assertEqual(m.release_lines(refs), [(2, 14), (2, 13)])


class TestSelectTargetTags(TestCase):
    def test_ga_and_newest_candidate(self) -> None:
        names = ["v2.14.0-rc1", "v2.14.0-rc2", "v2.14.0"]
        self.assertEqual(
            m.select_target_tags(names, (2, 14)),
            ["refs/tags/v2.14.0", "refs/tags/v2.14.0-rc2"],
        )

    def test_candidate_only_before_ga(self) -> None:
        self.assertEqual(
            m.select_target_tags(["v2.14.0-rc1"], (2, 14)),
            ["refs/tags/v2.14.0-rc1"],
        )

    def test_patch_release_supersedes_shipped_tags(self) -> None:
        # The preceding line is still patchable: v2.13.1-rc1 must win over the
        # rc15 that shipped as v2.13.0.
        names = ["v2.13.0-rc15", "v2.13.0", "v2.13.1-rc1"]
        self.assertEqual(
            m.select_target_tags(names, (2, 13)),
            ["refs/tags/v2.13.0", "refs/tags/v2.13.1-rc1"],
        )

    def test_sorts_candidates_numerically_not_lexically(self) -> None:
        # rc9 must rank below rc10 despite string ordering.
        names = ["v2.13.0-rc9", "v2.13.0-rc10"]
        self.assertEqual(
            m.select_target_tags(names, (2, 13)),
            ["refs/tags/v2.13.0-rc10"],
        )

    def test_ignores_other_release_lines(self) -> None:
        names = ["v2.1.0", "v2.1.0-rc1", "v2.14.0-rc1", "v3.1.0-rc1"]
        self.assertEqual(
            m.select_target_tags(names, (2, 1)),
            ["refs/tags/v2.1.0", "refs/tags/v2.1.0-rc1"],
        )

    def test_ignores_unconventional_tags(self) -> None:
        names = ["v2.14.0-rc1-test", "v2.14.0rc1", "2.14.0-rc1", "v2.14.0-rc", "v2.14"]
        self.assertEqual(m.select_target_tags(names, (2, 14)), [])

    def test_no_tags_yet(self) -> None:
        self.assertEqual(m.select_target_tags([], (2, 14)), [])


class TestUsesReleaseLabel(TestCase):
    def test_matches_release_labels(self) -> None:
        self.assertTrue(m.uses_release_label("runs-on: rel-l-x86iavx512-44-340"))
        self.assertTrue(m.uses_release_label('runner: "mt-rel-l-arm64g3-44-340"'))
        self.assertTrue(
            m.uses_release_label("'rel-l-x86iavx512-44-340' || 'l-x86iavx512-48-384'")
        )

    def test_rejects_non_release_text(self) -> None:
        self.assertFalse(m.uses_release_label("runs-on: l-x86iavx512-48-384"))
        self.assertFalse(m.uses_release_label("this is a prerelease build, unrelated"))


class TestCollectReleaseWorkflowPaths(TestCase):
    def test_follows_only_release_build_reusable(self) -> None:
        # A linux binary workflow whose build job runs on a release label and
        # calls the build reusable, but whose test/upload jobs run elsewhere.
        files = {
            ".github/workflows/gen-linux.yml": m.WorkflowFile(
                doc={
                    "jobs": {
                        "build": {
                            "uses": "./.github/workflows/_binary-build-linux.yml",
                            "with": {"runs_on": "lf.rel-l-x86iavx512-44-340"},
                        },
                        "test": {
                            "uses": "./.github/workflows/_binary-test-linux.yml",
                            "with": {"runs_on": "l-x86iavx512-16-128"},
                        },
                        "upload": {"uses": "./.github/workflows/_binary-upload.yml"},
                    }
                },
                raw="runs_on: rel-l-x86iavx512-44-340",
            ),
            ".github/workflows/_binary-build-linux.yml": m.WorkflowFile(
                doc={"jobs": {}}, raw="runs-on: ${{ inputs.runs_on }}"
            ),
            ".github/workflows/_binary-test-linux.yml": m.WorkflowFile(
                doc={"jobs": {}}, raw="runs-on: ${{ inputs.runs_on }}"
            ),
            ".github/workflows/_binary-upload.yml": m.WorkflowFile(
                doc={"jobs": {}}, raw="runs-on: ubuntu-24.04"
            ),
            ".github/workflows/unrelated.yml": m.WorkflowFile(
                doc={"jobs": {}}, raw="runs-on: ubuntu-24.04"
            ),
        }
        self.assertEqual(
            m.collect_release_workflow_paths(files),
            {
                ".github/workflows/gen-linux.yml",
                ".github/workflows/_binary-build-linux.yml",
            },
        )

    def test_entry_without_reusable_returns_just_itself(self) -> None:
        # The vLLM case: uses a release label inline, calls no local reusable.
        files = {
            ".github/workflows/build-vllm-wheel.yml": m.WorkflowFile(
                doc={"jobs": {"build": {"runs-on": "mt-rel-l-x86iavx512-44-340"}}},
                raw="runner: mt-rel-l-x86iavx512-44-340",
            ),
            ".github/workflows/docker-release.yml": m.WorkflowFile(
                doc={"jobs": {"build": {"runs-on": "linux.large"}}},
                raw="runs-on: linux.large",
            ),
        }
        self.assertEqual(
            m.collect_release_workflow_paths(files),
            {".github/workflows/build-vllm-wheel.yml"},
        )

    def test_discovers_callers_of_select_release_runner(self) -> None:
        # pytorch/pytorch#190619 moved the rel- labels into
        # _select-release-runner.yml, which emits them as outputs. Callers carry
        # no rel- label of their own (runs-on references needs.<job>.outputs.*),
        # so they must be discovered via their use of the select-runner reusable.
        files = {
            ".github/workflows/docker-release.yml": m.WorkflowFile(
                doc={
                    "jobs": {
                        "select-runner": {
                            "uses": "./.github/workflows/_select-release-runner.yml"
                        },
                        "build": {"runs-on": "${{ matrix.runner }}"},
                    }
                },
                raw="uses: ./.github/workflows/_select-release-runner.yml\n"
                "runs-on: ${{ matrix.runner }}",
            ),
            ".github/workflows/_select-release-runner.yml": m.WorkflowFile(
                doc={"jobs": {"select": {"runs-on": "ubuntu-24.04"}}},
                raw="echo x86=mt-rel-l-x86iavx512-44-340",
            ),
            ".github/workflows/unrelated.yml": m.WorkflowFile(
                doc={"jobs": {"build": {"runs-on": "ubuntu-24.04"}}},
                raw="runs-on: ubuntu-24.04",
            ),
        }
        self.assertEqual(
            m.collect_release_workflow_paths(files),
            {
                ".github/workflows/docker-release.yml",
                ".github/workflows/_select-release-runner.yml",
            },
        )

    def test_paths_filter_mention_is_not_a_caller(self) -> None:
        # Even when the release-label reusable is present, a workflow that only
        # names it in a triggers paths: filter (not an actual job `uses:`) must
        # not be pulled in -- entry detection is by job `uses:`, not raw text.
        files = {
            ".github/workflows/_select-release-runner.yml": m.WorkflowFile(
                doc={"jobs": {"select": {"runs-on": "ubuntu-24.04"}}},
                raw="echo x86=mt-rel-l-x86iavx512-44-340",
            ),
            ".github/workflows/lint.yml": m.WorkflowFile(
                doc={"jobs": {"lint": {"runs-on": "ubuntu-24.04"}}},
                raw="on:\n  pull_request:\n    paths:\n"
                "      - .github/workflows/_select-release-runner.yml",
            ),
        }
        self.assertEqual(
            m.collect_release_workflow_paths(files),
            {".github/workflows/_select-release-runner.yml"},
        )

    def test_follows_reusable_whose_runner_comes_from_selector_outputs(self) -> None:
        # pytorch/pytorch#193378 split the triton build into
        # _build-triton-wheel-linux.yml. Its callers pass the runner through from
        # the select-runner job's outputs, so the calling job carries no rel-
        # label -- the reusable that actually consumes the release runner must
        # still be followed. Upload jobs depend on the build jobs rather than the
        # selector, so they stay out.
        files = {
            ".github/workflows/build-triton-wheel.yml": m.WorkflowFile(
                doc={
                    "jobs": {
                        "select-runner": {
                            "uses": "./.github/workflows/_select-release-runner.yml"
                        },
                        "build-wheel-cuda": {
                            "needs": "select-runner",
                            "uses": "./.github/workflows/_build-triton-wheel-linux.yml",
                            "with": {
                                "runs_on": "${{ needs.select-runner.outputs.x86 }}"
                            },
                        },
                        "build-wheel-win": {"runs-on": "windows.4xlarge"},
                        "upload-wheel-triton": {
                            "needs": ["build-wheel-cuda"],
                            "uses": "./.github/workflows/_upload-triton-wheel.yml",
                        },
                    }
                },
                raw="uses: ./.github/workflows/_select-release-runner.yml\n"
                "runs_on: ${{ needs.select-runner.outputs.x86 }}",
            ),
            ".github/workflows/_select-release-runner.yml": m.WorkflowFile(
                doc={"jobs": {"select": {"runs-on": "ubuntu-24.04"}}},
                raw="echo x86=mt-rel-l-x86iavx512-44-340",
            ),
            ".github/workflows/_build-triton-wheel-linux.yml": m.WorkflowFile(
                doc={"jobs": {"build": {"runs-on": "${{ inputs.runs_on }}"}}},
                raw="runs-on: ${{ inputs.runs_on }}",
            ),
            ".github/workflows/_upload-triton-wheel.yml": m.WorkflowFile(
                doc={"jobs": {"upload": {"runs-on": "ubuntu-24.04"}}},
                raw="runs-on: ubuntu-24.04",
            ),
        }
        self.assertEqual(
            m.collect_release_workflow_paths(files),
            {
                ".github/workflows/build-triton-wheel.yml",
                ".github/workflows/_select-release-runner.yml",
                ".github/workflows/_build-triton-wheel-linux.yml",
            },
        )

    def test_selector_outputs_of_a_non_release_job_are_not_a_signal(self) -> None:
        # needs.<job>.outputs.* only propagates the release signal when that job
        # is a caller of the release-label reusable. A plain matrix-computing job
        # must not pull its consumers' reusables in.
        files = {
            ".github/workflows/gen.yml": m.WorkflowFile(
                doc={
                    "jobs": {
                        "build": {"runs-on": "rel-l-x86iavx512-44-340"},
                        "matrix": {"runs-on": "ubuntu-24.04"},
                        "test": {
                            "needs": "matrix",
                            "uses": "./.github/workflows/_test.yml",
                            "with": {"runs_on": "${{ needs.matrix.outputs.runner }}"},
                        },
                    }
                },
                raw="runs-on: rel-l-x86iavx512-44-340",
            ),
            ".github/workflows/_test.yml": m.WorkflowFile(
                doc={"jobs": {}}, raw="runs-on: ${{ inputs.runs_on }}"
            ),
        }
        self.assertEqual(
            m.collect_release_workflow_paths(files), {".github/workflows/gen.yml"}
        )

    def test_ignores_remote_uses(self) -> None:
        files = {
            ".github/workflows/gen.yml": m.WorkflowFile(
                doc={
                    "jobs": {
                        "x": {
                            "uses": "pytorch/test-infra/.github/workflows/x.yml@main",
                            "with": {"runs_on": "rel-l-x86iavx512-44-340"},
                        }
                    }
                },
                raw="runs_on: rel-l-x86iavx512-44-340",
            )
        }
        self.assertEqual(
            m.collect_release_workflow_paths(files), {".github/workflows/gen.yml"}
        )


class TestBuildDesiredWorkflows(TestCase):
    def test_flattens_per_ref_paths(self) -> None:
        # Per-ref discovery: each ref carries only the workflows that exist there,
        # so a ref (release/2.12) can legitimately omit a workflow (b.yml) that
        # main has. The allow-list must not fabricate the missing combination.
        desired = m.build_desired_workflows(
            {
                "refs/heads/main": {
                    ".github/workflows/a.yml",
                    ".github/workflows/b.yml",
                },
                "refs/heads/release/2.12": {".github/workflows/a.yml"},
            }
        )
        self.assertEqual(
            desired,
            {
                "pytorch/pytorch/.github/workflows/a.yml@refs/heads/main",
                "pytorch/pytorch/.github/workflows/b.yml@refs/heads/main",
                "pytorch/pytorch/.github/workflows/a.yml@refs/heads/release/2.12",
            },
        )


if __name__ == "__main__":
    main()
