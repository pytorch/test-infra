"""Tests for reading the steps the replay derives from or runs, by shape.

Each reader is run against this repository's workflow, and against copies of it edited
the way a workflow without a target step differs -- no target step, a detector naming ``pytorch``
literally -- or the way a policy pull request might break it. History is never read:
CI checks out one commit.
"""

import copy
import json
import unittest

from replay_runner_fixtures import HEAD_WORKFLOW, WORKFLOW_PATH
from torchci.greenlight_replay import settings, workflow_steps


def steps_where(document, needle):
    return [
        step
        for job in document["jobs"].values()
        for step in job.get("steps") or []
        if needle in str(step.get("run") or "")
    ]


class StepsTestCase(unittest.TestCase):
    def setUp(self):
        self.document = copy.deepcopy(HEAD_WORKFLOW)

    def refused(self, reader, *args, needle=""):
        with self.assertRaises(ValueError) as caught:
            reader(self.document, WORKFLOW_PATH, *args)
        self.assertIn(needle, str(caught.exception))


class TestHookSettingsText(StepsTestCase):
    def test_the_head_heredoc_is_the_settings_json_with_its_placeholder(self):
        text = workflow_steps.hook_settings_text(self.document, WORKFLOW_PATH)
        self.assertIn(settings.CHECKOUT_PLACEHOLDER, text)
        self.assertEqual(set(json.loads(text)), {"hooks", "claudeMdExcludes"})

    def test_a_second_heredoc_writing_the_file_is_refused(self):
        (step,) = steps_where(self.document, workflow_steps.SETTINGS_LOCAL_RELPATH)
        step["run"] += "\n" + step["run"]
        self.refused(workflow_steps.hook_settings_text, needle="found 2")

    def test_a_heredoc_that_never_ends_is_refused(self):
        (step,) = steps_where(self.document, workflow_steps.SETTINGS_LOCAL_RELPATH)
        step["run"] = step["run"].replace("\nEOF\n", "\nEOT\n")
        self.refused(workflow_steps.hook_settings_text, needle="never ends")


class TestActionStep(StepsTestCase):
    def test_the_head_timeout_and_output_style(self):
        self.assertEqual(
            workflow_steps.action_timeout_minutes(self.document, WORKFLOW_PATH), 37
        )
        self.assertEqual(
            workflow_steps.action_output_style(self.document, WORKFLOW_PATH), "Concise"
        )


class TestDetectorStep(StepsTestCase):
    def detector(self):
        (step,) = steps_where(self.document, workflow_steps.DETECTOR_RELPATH)
        return step

    def test_the_head_form_names_the_targets_checkout(self):
        self.assertEqual(
            workflow_steps.detector_untrusted_dirname(
                self.document, WORKFLOW_PATH, "target"
            ),
            "target",
        )

    def test_the_literal_form_names_pytorch_whatever_the_target(self):
        step = self.detector()
        step["run"] = workflow_steps.DETECTOR_PYTORCH_RUN
        del step["env"]
        self.assertEqual(
            workflow_steps.detector_untrusted_dirname(
                self.document, WORKFLOW_PATH, "target"
            ),
            "pytorch",
        )

    def test_the_literal_form_with_an_env_is_refused(self):
        self.detector()["run"] = workflow_steps.DETECTOR_PYTORCH_RUN
        self.refused(workflow_steps.detector_untrusted_dirname, "pytorch", needle="env")

    def test_a_second_detector_step_is_refused(self):
        self.document["jobs"]["review"]["steps"].append(copy.deepcopy(self.detector()))
        self.refused(
            workflow_steps.detector_untrusted_dirname, "pytorch", needle="found 2"
        )


class TestRecordStep(StepsTestCase):
    def record(self):
        (step,) = steps_where(self.document, workflow_steps.RECORD_VERDICT_ASSIGNMENT)
        return step

    def record_job(self):
        (job,) = [
            job
            for job in self.document["jobs"].values()
            if any(step is self.record() for step in job.get("steps") or [])
        ]
        return job

    def test_the_head_record_step_reads_only_eval_hash_and_its_own_variables(self):
        record = workflow_steps.record_step(self.document, WORKFLOW_PATH)
        self.assertIn("EVAL_HASH", record.run)
        index = workflow_steps.record_verdict_line(record.run)
        self.assertEqual(
            record.run.split("\n")[index].strip(),
            workflow_steps.RECORD_VERDICT_ASSIGNMENT,
        )

    def test_the_head_record_step_sets_no_shell(self):
        self.assertIsNone(
            workflow_steps.record_step(self.document, WORKFLOW_PATH).shell
        )

    def test_the_shell_is_the_steps_else_its_jobs_else_the_workflows(self):
        self.document["defaults"] = {"run": {"shell": "bash"}}
        record = workflow_steps.record_step(self.document, WORKFLOW_PATH)
        self.assertEqual(record.shell, "bash")
        self.document["defaults"] = {"run": {"shell": "sh"}}
        self.record_job()["defaults"] = {"run": {"shell": "bash"}}
        record = workflow_steps.record_step(self.document, WORKFLOW_PATH)
        self.assertEqual(record.shell, "bash")
        self.record_job()["defaults"] = {"run": {"shell": "sh"}}
        self.record()["shell"] = "bash"
        record = workflow_steps.record_step(self.document, WORKFLOW_PATH)
        self.assertEqual(record.shell, "bash")

    def test_a_shell_other_than_bash_is_refused_wherever_it_is_set(self):
        for place in ("step", "job", "workflow"):
            with self.subTest(place=place):
                self.document = copy.deepcopy(HEAD_WORKFLOW)
                holder = {
                    "step": self.record(),
                    "job": self.record_job(),
                    "workflow": self.document,
                }[place]
                if place == "step":
                    holder["shell"] = "sh -e {0}"
                else:
                    holder["defaults"] = {"run": {"shell": "sh"}}
                self.refused(workflow_steps.record_step, needle="shell")

    def test_a_second_record_step_is_refused(self):
        self.document["jobs"]["review"]["steps"].append(copy.deepcopy(self.record()))
        self.refused(workflow_steps.record_step, needle="found 2")

    def test_a_step_env_is_refused(self):
        self.record()["env"] = {"EXTRA": "1"}
        self.refused(workflow_steps.record_step, needle="env block")


if __name__ == "__main__":
    unittest.main()
