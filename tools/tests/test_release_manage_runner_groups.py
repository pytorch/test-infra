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
    def test_is_cross_product(self) -> None:
        desired = m.build_desired_workflows(
            [".github/workflows/a.yml", ".github/workflows/b.yml"],
            ["refs/heads/main", "refs/heads/nightly"],
        )
        self.assertEqual(
            desired,
            {
                "pytorch/pytorch/.github/workflows/a.yml@refs/heads/main",
                "pytorch/pytorch/.github/workflows/a.yml@refs/heads/nightly",
                "pytorch/pytorch/.github/workflows/b.yml@refs/heads/main",
                "pytorch/pytorch/.github/workflows/b.yml@refs/heads/nightly",
            },
        )


if __name__ == "__main__":
    main()
