"""Tests for the registry of review workflow shapes, and for the triggers that keep it honest.

The registry is only as good as two things: what the shape masks and pins, and whether
CI runs these tests (and the replay) when anything the shape reads changes. Both are
checked against this repository's own files. Main's tree is never read here: CI checks
out one commit, so main's variant is checked by digest and the refusal by a synthetic tree.
"""

import copy
import json
import re
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

import yaml
from packaging.specifiers import SpecifierSet
from replay_runner_fixtures import (
    build_arm_tree,
    HEAD_WORKFLOW,
    REPO_POLICIES_RELPATH,
    REPO_ROOT,
    WORKFLOW_PATH,
)
from torchci.greenlight_replay import (
    arm_code,
    ledger,
    ledger_shape,
    policy as policy_mod,
)
from torchci.greenlight_replay.workflow import ACTION_USES_PREFIX, SIZECHECK_STEP_ID
from torchci.greenlight_replay.workflow_steps import (
    RECORD_VERDICT_ASSIGNMENT,
    SETTINGS_LOCAL_RELPATH,
)


REPLAY_WORKFLOW = REPO_ROOT / ".github/workflows/greenlight-policy-replay.yml"
TORCHCI_WORKFLOW = REPO_ROOT / ".github/workflows/torchci.yml"
GREENLIGHT_WORKFLOW = REPO_ROOT / ".github/workflows/greenlight-tests.yml"
GREENLIGHT_ROOT = REPO_ROOT / "greenlight"
REPLAY_JOBS = ("collect", "replay")
DIFF_STEP_NEEDLE = "Diff bytes:"

# Imported as arm_code's drivers import greenlight: cli for the target, redact beside it
# for the verdict.
CLOSURE_DRIVER = (
    "import sys\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "from greenlight import cli, redact\n"
    "for name, module in sorted(sys.modules.items()):\n"
    "    if name == 'greenlight' or name.startswith('greenlight.'):\n"
    "        print(module.__file__)\n"
)

# Each path, and whether the replay's push paths take it.
SAMPLE_PATHS = (
    (".claude/skills/greenlight-review/SKILL.md", True),
    (".claude/skills/greenlight-review/repos/pytorch.md", True),
    (".claude/skills/greenlight-review/repos/test-infra.md", False),
    (".claude/skills/greenlight-review/repos/nested/vision.md", False),
    (".claude/skills/ci-metrics/SKILL.md", True),
    (".claude/hooks/greenlight/restrict-read.py", True),
    (".claude/settings.json", True),
    ("CLAUDE.md", True),
    ("CLAUDE.local.md", True),
    (".mcp.json", True),
    ("docs/CLAUDE.md", False),
    (".github/actions/setup-uv/action.yml", False),
    (".github/actions/upload-claude-usage/action.yml", False),
    (".github/workflows/greenlight-pr-review.yml", True),
    (".github/workflows/greenlight-policy-replay.yml", True),
    (".github/workflows/torchci.yml", False),
    (".github/scripts/greenlight_policy_replay_collect.sh", True),
    (".github/scripts/nested/greenlight_policy_replay_collect.sh", False),
    (".github/scripts/greenlight_policy_replay_collect.py", False),
    ("greenlight/src/greenlight/cli.py", True),
    ("greenlight/pyproject.toml", True),
    ("greenlight/uv.lock", True),
    ("greenlight/repos.yaml", True),
    ("greenlight/tests/test_cli.py", False),
    ("greenlight/REPOS.md", False),
    ("tools/torchci/greenlight_replay/ledger.py", True),
    ("tools/torchci/greenlight_decisions/__main__.py", True),
    ("tools/torchci/tests/greenlight_replay/test_ledger.py", False),
    ("torchci/pages/index.tsx", False),
    ("README.md", False),
)


def glob_regex(pattern: str) -> str:
    """A GitHub path filter pattern as a regex: ``**`` any run, ``*`` any run but ``/``."""
    if re.search(r"[?+\[\]]", pattern):
        raise AssertionError(f"{pattern!r} uses filter syntax this test does not model")
    return "".join(
        ".*" if part == "**" else "[^/]*" if part == "*" else re.escape(part)
        for part in re.split(r"(\*\*|\*)", pattern)
    )


def filter_takes(patterns, path: str) -> bool:
    """Whether GitHub's ``paths`` filter takes ``path``: the last matching pattern wins."""
    taken = False
    for pattern in patterns:
        negated = pattern.startswith("!")
        if re.fullmatch(glob_regex(pattern.lstrip("!")), path):
            taken = not negated
    return taken


def triggers(path: Path, event: str) -> list[str]:
    # PyYAML reads the workflow's `on:` key as the boolean True.
    return yaml.safe_load(path.read_text())[True][event]["paths"]


def jq_mirror() -> str:
    """The program in the plan job that decides whether a PR changes a trigger path."""
    (program,) = [
        match
        for job in yaml.safe_load(REPLAY_WORKFLOW.read_text())["jobs"].values()
        for step in job.get("steps") or []
        for match in re.findall(
            r"changes=\$\(jq -r '(.*?)' <<<\"\$comparison\"\)",
            str(step.get("run") or ""),
            re.DOTALL,
        )
    ]
    return program


def review_steps(document):
    (job,) = [
        job
        for job in document["jobs"].values()
        if any(
            str(step.get("uses") or "").startswith(ACTION_USES_PREFIX)
            for step in job.get("steps") or []
        )
    ]
    return job["steps"]


def find_step(document, test):
    (step,) = [step for step in review_steps(document) if test(step)]
    return step


def action(document):
    return find_step(
        document,
        lambda step: str(step.get("uses") or "").startswith(ACTION_USES_PREFIX),
    )


def run_holding(document, needle):
    return find_step(document, lambda step: needle in str(step.get("run") or ""))


def record_step(document):
    (step,) = [
        step
        for job in document["jobs"].values()
        for step in job.get("steps") or []
        if RECORD_VERDICT_ASSIGNMENT in str(step.get("run") or "")
    ]
    return step


def head_shape(document=HEAD_WORKFLOW, root=REPO_ROOT):
    entries = ledger_shape.shape(document, root, WORKFLOW_PATH)
    return ledger_shape.shape_digest(tuple(entry.digest for entry in entries))


def build_head_tree(root: Path, document=HEAD_WORKFLOW, **layout) -> Path:
    """``build_arm_tree`` plus the local actions the review job uses."""
    build_arm_tree(root, workflow_document=document, **layout)
    for manifest in ledger_shape.local_actions(HEAD_WORKFLOW, REPO_ROOT, WORKFLOW_PATH):
        (root / manifest).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / manifest, root / manifest)
    return root


class TestRegistry(unittest.TestCase):
    def test_the_head_shape_is_registered(self):
        try:
            ledger.require_registered(HEAD_WORKFLOW, REPO_ROOT, WORKFLOW_PATH)
        except ledger.UnregisteredShapeError as exc:
            self.fail(str(exc))

    def test_every_registered_digest_has_a_class_and_every_class_a_digest(self):
        used = {digest for variant in ledger.VARIANTS for digest in variant.digests}
        self.assertEqual(used, set(ledger.CLASSES))
        for variant in ledger.VARIANTS:
            self.assertEqual(len(variant.classes()), len(variant.digests))

    def test_no_two_variants_share_a_shape(self):
        self.assertEqual(len(ledger.REGISTRY), len(ledger.VARIANTS))

    def test_mains_variant_is_registered_with_its_review(self):
        (main,) = [v for v in ledger.VARIANTS if "e4933b776" in v.name]
        self.assertTrue(main.notes)


class TestMasks(unittest.TestCase):
    """What the harness derives or runs may change without changing the shape."""

    def mutated(self, mutate):
        document = copy.deepcopy(HEAD_WORKFLOW)
        mutate(document)
        return document

    def edit_claude_args(self, old, new):
        def mutate(document):
            with_ = action(document)["with"]
            self.assertIn(old, with_["claude_args"])
            with_["claude_args"] = with_["claude_args"].replace(old, new)

        return mutate

    def test_each_derived_or_run_value_is_masked(self):
        def set_in(locate, key, value):
            return lambda document: locate(document).__setitem__(key, value)

        sizecheck_env = lambda d: find_step(
            d, lambda s: s.get("id") == SIZECHECK_STEP_ID
        )["env"]
        budgets = lambda d: next(
            job["env"] for job in d["jobs"].values() if job["steps"] is review_steps(d)
        )
        hooks = run_holding(HEAD_WORKFLOW, SETTINGS_LOCAL_RELPATH)["run"]
        record = record_step(HEAD_WORKFLOW)["run"]
        cases = {
            "a line cap": set_in(sizecheck_env, "MAX_DIFF_LINES", "1"),
            "the file cap": set_in(sizecheck_env, "MAX_DIFF_FILES", "7"),
            "a budget": set_in(budgets, "GREENLIGHT_REVIEW_HARD_BUDGET_MIN", "34"),
            "the prompt": set_in(lambda d: action(d)["with"], "prompt", "Review it."),
            "the output style": set_in(
                lambda d: action(d)["with"], "settings", '{"outputStyle": "Other"}'
            ),
            "the timeout": set_in(action, "timeout-minutes", 30),
            "the model": self.edit_claude_args("claude-opus-5-5", "claude-other"),
            "the effort": self.edit_claude_args("--effort high", "--effort max"),
            "the tools": self.edit_claude_args('"Read,Glob,Grep,Write"', "Read"),
            "a flag spelt with =": self.edit_claude_args(
                "--effort high", "--effort=high"
            ),
            "the hook settings": set_in(
                lambda d: run_holding(d, SETTINGS_LOCAL_RELPATH),
                "run",
                hooks.replace('"timeout": 5', '"timeout": 9'),
            ),
            "the record validation": set_in(record_step, "run", record + "true\n"),
            "the stack step": set_in(
                lambda d: run_holding(d, "/tmp/greenlight-stack"),
                "timeout-minutes",
                3,
            ),
            "a step's name": set_in(
                lambda d: run_holding(d, DIFF_STEP_NEEDLE), "name", "Diff it"
            ),
        }
        for name, mutate in cases.items():
            with self.subTest(name):
                document = self.mutated(mutate)
                self.assertNotEqual(document, HEAD_WORKFLOW)
                self.assertEqual(head_shape(document), head_shape())

    def test_each_reproduced_part_is_pinned(self):
        def diff_run(document):
            step = run_holding(document, DIFF_STEP_NEEDLE)
            step["run"] = step["run"].replace("set -euo pipefail", "set -eo pipefail")

        def add_step(document):
            review_steps(document).insert(3, {"name": "Extra", "run": "true"})

        def reorder(document):
            steps = review_steps(document)
            steps[-1], steps[-2] = steps[-2], steps[-1]

        def gate_the_action(document):
            action(document)["if"] = "always()"

        def drop_file_cap(document):
            find_step(document, lambda s: s.get("id") == SIZECHECK_STEP_ID)["env"].pop(
                "MAX_DIFF_FILES"
            )

        def record_job_step(document):
            (job,) = [
                job
                for job in document["jobs"].values()
                if record_step(document) in job["steps"]
            ]
            job["steps"].append({"name": "Extra", "run": "true"})

        def concurrency(document):
            document["concurrency"]["cancel-in-progress"] = False

        cases = {
            "a reproduced step's run": diff_run,
            "an added step": add_step,
            "two steps reordered": reorder,
            "an added claude_args flag": self.edit_claude_args(
                "--effort high", "--effort high --max-turns 9"
            ),
            "a key added to the action step": gate_the_action,
            "a masked key removed": drop_file_cap,
            "the record job": record_job_step,
            "the workflow's concurrency": concurrency,
        }
        for name, mutate in cases.items():
            with self.subTest(name):
                self.assertNotEqual(head_shape(self.mutated(mutate)), head_shape())

    def test_the_local_action_is_pinned(self):
        with tempfile.TemporaryDirectory() as name:
            root = build_head_tree(Path(name))
            self.assertEqual(head_shape(root=root), head_shape())
            (manifest,) = ledger_shape.local_actions(HEAD_WORKFLOW, root, WORKFLOW_PATH)
            text = (root / manifest).read_text()
            (root / manifest).write_text(text.replace('"0.', '"9.', 1))
            self.assertNotEqual(head_shape(root=root), head_shape())

    def test_a_local_action_outside_the_tree_or_missing_is_refused(self):
        for uses, needle in (
            ("./../escape", "refusing"),
            ("./nowhere", "no action.yml"),
        ):
            with self.subTest(uses=uses):
                document = copy.deepcopy(HEAD_WORKFLOW)
                review_steps(document).insert(0, {"uses": uses})
                with self.assertRaises(ValueError) as caught:
                    head_shape(document)
                self.assertIn(needle, str(caught.exception))


class TestMaterializeRefuses(unittest.TestCase):
    def test_an_unregistered_shape_is_refused_before_any_arm_code_runs(self):
        document = copy.deepcopy(HEAD_WORKFLOW)
        step = run_holding(document, DIFF_STEP_NEEDLE)
        step["run"] += "echo extra\n"
        changed = ledger_shape.shape(document, REPO_ROOT, WORKFLOW_PATH)
        known = {d for variant in ledger.VARIANTS for d in variant.digests}
        (new,) = [entry for entry in changed if entry.digest not in known]
        with tempfile.TemporaryDirectory() as name:
            root = build_head_tree(Path(name), document)
            with mock.patch.object(policy_mod, "_checkout"), mock.patch.object(
                policy_mod, "resolve_target"
            ) as resolve:
                with self.assertRaises(ledger.UnregisteredShapeError) as caught:
                    policy_mod.materialize(
                        "main", root, reviewed_repo="pytorch/pytorch"
                    )
        resolve.assert_not_called()
        message = str(caught.exception)
        self.assertIn(f"{new.label}: {new.digest}", message)
        self.assertIn("PARITY.md", message)


class TestDerivationsForEveryRepo(unittest.TestCase):
    """The head tree materializes, its shape checked, for each repo it configures or
    holds a policy file for."""

    def test_every_configured_repo_and_policy_file_materializes(self):
        configured = [
            entry["repo"]
            for entry in yaml.safe_load((GREENLIGHT_ROOT / "repos.yaml").read_text())[
                "repos"
            ]
        ]
        policies = sorted(
            p.name for p in (REPO_ROOT / REPO_POLICIES_RELPATH).glob("*.md")
        )
        with_policy = [f"pytorch/{name.removesuffix('.md')}" for name in policies]
        for repo in dict.fromkeys(configured + with_policy):
            with self.subTest(repo=repo), tempfile.TemporaryDirectory() as name:
                root = build_head_tree(
                    Path(name),
                    extra_repos=[r for r in with_policy if r not in configured],
                    policies=policies,
                )
                with mock.patch.object(policy_mod, "_checkout"):
                    result = policy_mod.materialize("main", root, reviewed_repo=repo)
                self.assertEqual(result.target.repo, repo)
                self.assertEqual(result.target.policy_present, repo in with_policy)
                self.assertEqual(result.detector_dirname, result.target.checkout)
                self.assertIn(
                    f"**/{result.target.checkout}/CLAUDE.md",
                    result.hook_settings["claudeMdExcludes"],
                )


class TestTriggers(unittest.TestCase):
    """CI and the replay run whenever something the shape or the arm's code reads changes."""

    def read_paths(self):
        completed = arm_code._python(REPO_ROOT, CLOSURE_DRIVER)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        closure = [
            str(Path(line).resolve().relative_to(REPO_ROOT))
            for line in completed.stdout.splitlines()
        ]
        self.assertIn("greenlight/src/greenlight/cli.py", closure)
        hooks = [
            str(p.relative_to(REPO_ROOT))
            for p in (REPO_ROOT / policy_mod.HOOKS_RELPATH).iterdir()
            if p.is_file()
        ]
        return [
            *closure,
            *hooks,
            str(WORKFLOW_PATH.relative_to(REPO_ROOT)),
            "greenlight/repos.yaml",
        ]

    def test_what_the_arm_runs_starts_ci_and_the_replay(self):
        replay = triggers(REPLAY_WORKFLOW, "push")
        torchci = triggers(TORCHCI_WORKFLOW, "pull_request")
        for path in self.read_paths():
            with self.subTest(path=path):
                self.assertTrue(filter_takes(replay, path), "replay on.push.paths")
                self.assertTrue(
                    filter_takes(torchci, path), "torchci pull_request.paths"
                )

    def test_a_local_action_the_shape_pins_starts_ci_but_not_the_replay(self):
        # The replay neither reads nor runs a local action, so a change to one replays
        # two identical arms; the registry's check in torchci CI is what catches it.
        replay = triggers(REPLAY_WORKFLOW, "push")
        torchci = triggers(TORCHCI_WORKFLOW, "pull_request")
        locals_ = ledger_shape.local_actions(HEAD_WORKFLOW, REPO_ROOT, WORKFLOW_PATH)
        self.assertTrue(locals_)
        for path in locals_:
            with self.subTest(path=path):
                self.assertTrue(filter_takes(torchci, path))
                self.assertFalse(filter_takes(replay, path))

    def test_what_these_tests_read_starts_them(self):
        torchci = triggers(TORCHCI_WORKFLOW, "pull_request")
        read = [REPLAY_WORKFLOW, TORCHCI_WORKFLOW, GREENLIGHT_WORKFLOW]
        read += [GREENLIGHT_ROOT / "pyproject.toml", GREENLIGHT_ROOT / "uv.lock"]
        read += sorted((REPO_ROOT / REPO_POLICIES_RELPATH).glob("*.md"))
        for path in read:
            with self.subTest(path=path):
                self.assertTrue(filter_takes(torchci, str(path.relative_to(REPO_ROOT))))

    def test_the_plan_jobs_mirror_takes_exactly_what_the_push_paths_take(self):
        replay = triggers(REPLAY_WORKFLOW, "push")
        samples = list(SAMPLE_PATHS) + [
            (path, True) for path in self.read_paths() if filter_takes(replay, path)
        ]
        stdin = "".join(
            json.dumps({"files": [{"filename": path}]}) + "\n" for path, _ in samples
        )
        completed = subprocess.run(
            ["jq", "-r", jq_mirror()], input=stdin, capture_output=True, text=True
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        answers = completed.stdout.split()
        self.assertEqual(len(answers), len(samples))
        for (path, expected), answer in zip(samples, answers):
            with self.subTest(path=path):
                self.assertEqual(filter_takes(replay, path), expected)
                self.assertEqual(answer, "yes" if expected else "no")

    def test_greenlights_tests_run_when_the_harness_changes(self):
        for event in ("pull_request", "push"):
            with self.subTest(event=event):
                paths = triggers(GREENLIGHT_WORKFLOW, event)
                self.assertIn("tools/torchci/greenlight_replay/**", paths)


class TestReplayEnvironment(unittest.TestCase):
    """The replay jobs run each arm's greenlight as greenlight's own lockfile has it."""

    def jobs(self):
        return yaml.safe_load(REPLAY_WORKFLOW.read_text())["jobs"]

    def test_the_pinned_pyyaml_is_greenlights(self):
        lock = tomllib.loads((GREENLIGHT_ROOT / "uv.lock").read_text())
        (locked,) = [p["version"] for p in lock["package"] if p["name"] == "pyyaml"]
        pins = re.findall(r"PyYAML==(\S+)", REPLAY_WORKFLOW.read_text())
        self.assertTrue(pins)
        self.assertEqual(set(pins), {locked})

    def test_the_replay_jobs_python_satisfies_greenlights_requires_python(self):
        project = tomllib.loads((GREENLIGHT_ROOT / "pyproject.toml").read_text())
        required = SpecifierSet(project["project"]["requires-python"])
        for name in REPLAY_JOBS:
            with self.subTest(job=name):
                (version,) = [
                    str(step["with"]["python-version"])
                    for step in self.jobs()[name]["steps"]
                    if str(step.get("uses") or "").startswith("actions/setup-python@")
                ]
                self.assertIn(version, required)


if __name__ == "__main__":
    unittest.main()
