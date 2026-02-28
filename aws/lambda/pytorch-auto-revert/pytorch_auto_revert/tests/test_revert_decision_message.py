import json
import unittest

from pytorch_auto_revert.revert_decision_message import (
    BreakingWorkflow,
    RevertDecisionMessage,
    SignalDetail,
)


class TestSignalDetail(unittest.TestCase):
    """Tests for SignalDetail dataclass."""

    def test_minimal_signal_detail(self):
        """Test creating a SignalDetail with only required fields."""
        signal = SignalDetail(key="test-signal")

        self.assertEqual(signal.key, "test-signal")
        self.assertIsNone(signal.job_base_name)
        self.assertIsNone(signal.test_module)
        self.assertIsNone(signal.wf_run_id)
        self.assertIsNone(signal.job_id)
        self.assertIsNone(signal.job_url)
        self.assertIsNone(signal.hud_url)

    def test_full_signal_detail(self):
        """Test creating a SignalDetail with all fields."""
        signal = SignalDetail(
            key="linux-focal-py3.8-gcc7 / test",
            job_base_name="pull / linux-focal-py3.8-gcc7",
            test_module="test.test_module",
            wf_run_id=987654321,
            job_id=123456789,
            job_url="https://github.com/pytorch/pytorch/runs/123456789",
            hud_url="https://hud.pytorch.org/hud/pytorch/pytorch/commit/abc123",
        )

        self.assertEqual(signal.key, "linux-focal-py3.8-gcc7 / test")
        self.assertEqual(signal.job_base_name, "pull / linux-focal-py3.8-gcc7")
        self.assertEqual(signal.test_module, "test.test_module")
        self.assertEqual(signal.wf_run_id, 987654321)
        self.assertEqual(signal.job_id, 123456789)
        self.assertEqual(
            signal.job_url, "https://github.com/pytorch/pytorch/runs/123456789"
        )
        self.assertTrue(signal.hud_url.startswith("https://hud.pytorch.org"))

    def test_signal_detail_requires_key(self):
        """Test that SignalDetail raises ValueError if key is empty."""
        with self.assertRaises(ValueError) as context:
            SignalDetail(key="")
        self.assertIn("key is required", str(context.exception))

    def test_signal_detail_is_frozen(self):
        """Test that SignalDetail is immutable."""
        signal = SignalDetail(key="test-signal")
        with self.assertRaises(Exception):  # FrozenInstanceError
            signal.key = "new-key"  # type: ignore


class TestBreakingWorkflow(unittest.TestCase):
    """Tests for BreakingWorkflow dataclass."""

    def test_breaking_workflow_creation(self):
        """Test creating a BreakingWorkflow with signals."""
        signals = [
            SignalDetail(key="signal-1"),
            SignalDetail(key="signal-2", job_id=123),
        ]
        workflow = BreakingWorkflow(workflow_name="pull", signals=signals)

        self.assertEqual(workflow.workflow_name, "pull")
        self.assertEqual(len(workflow.signals), 2)
        self.assertEqual(workflow.signals[0].key, "signal-1")
        self.assertEqual(workflow.signals[1].key, "signal-2")

    def test_breaking_workflow_requires_name(self):
        """Test that BreakingWorkflow raises ValueError if workflow_name is empty."""
        signals = [SignalDetail(key="signal-1")]
        with self.assertRaises(ValueError) as context:
            BreakingWorkflow(workflow_name="", signals=signals)
        self.assertIn("workflow_name is required", str(context.exception))

    def test_breaking_workflow_requires_signals(self):
        """Test that BreakingWorkflow raises ValueError if signals list is empty."""
        with self.assertRaises(ValueError) as context:
            BreakingWorkflow(workflow_name="pull", signals=[])
        self.assertIn("signals list cannot be empty", str(context.exception))

    def test_breaking_workflow_is_frozen(self):
        """Test that BreakingWorkflow is immutable."""
        signals = [SignalDetail(key="signal-1")]
        workflow = BreakingWorkflow(workflow_name="pull", signals=signals)
        with self.assertRaises(Exception):  # FrozenInstanceError
            workflow.workflow_name = "trunk"  # type: ignore


class TestRevertDecisionMessage(unittest.TestCase):
    """Tests for RevertDecisionMessage dataclass."""

    def setUp(self):
        """Set up common test data."""
        self.valid_message_data = {
            "action": "revert_requested",
            "commit_sha": "abc123def456",
            "pr_number": 12345,
            "pr_url": "https://github.com/pytorch/pytorch/pull/12345",
            "pr_title": "Fix critical bug",
            "repo_full_name": "pytorch/pytorch",
            "timestamp": "2024-01-26T10:00:00Z",
            "revert_action": "run_revert",
            "action_type": "merge",
            "breaking_workflows": [
                BreakingWorkflow(
                    workflow_name="pull",
                    signals=[
                        SignalDetail(
                            key="linux-focal-py3.8-gcc7",
                            job_id=123,
                            job_url="https://github.com/pytorch/pytorch/runs/123",
                        )
                    ],
                )
            ],
            "breaking_notification_msg": "This PR caused regressions in pull workflow",
            "pr_author": "testuser",
        }

    def test_valid_message_creation(self):
        """Test creating a valid RevertDecisionMessage."""
        message = RevertDecisionMessage(**self.valid_message_data)

        self.assertEqual(message.action, "revert_requested")
        self.assertEqual(message.commit_sha, "abc123def456")
        self.assertEqual(message.pr_number, 12345)
        self.assertEqual(message.pr_author, "testuser")
        self.assertEqual(len(message.breaking_workflows), 1)

    def test_message_without_optional_pr_author(self):
        """Test creating a message without pr_author (optional field)."""
        data = self.valid_message_data.copy()
        del data["pr_author"]
        message = RevertDecisionMessage(**data)

        self.assertIsNone(message.pr_author)

    def test_message_requires_action(self):
        """Test that message raises ValueError if action is empty."""
        data = self.valid_message_data.copy()
        data["action"] = ""
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("action is required", str(context.exception))

    def test_message_requires_commit_sha(self):
        """Test that message raises ValueError if commit_sha is empty."""
        data = self.valid_message_data.copy()
        data["commit_sha"] = ""
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("commit_sha is required", str(context.exception))

    def test_message_requires_positive_pr_number(self):
        """Test that message raises ValueError if pr_number is not positive."""
        data = self.valid_message_data.copy()
        data["pr_number"] = 0
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("pr_number must be positive", str(context.exception))

        data["pr_number"] = -1
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("pr_number must be positive", str(context.exception))

    def test_message_requires_pr_url(self):
        """Test that message raises ValueError if pr_url is empty."""
        data = self.valid_message_data.copy()
        data["pr_url"] = ""
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("pr_url is required", str(context.exception))

    def test_message_requires_pr_title(self):
        """Test that message raises ValueError if pr_title is empty."""
        data = self.valid_message_data.copy()
        data["pr_title"] = ""
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("pr_title is required", str(context.exception))

    def test_message_requires_valid_repo_full_name(self):
        """Test that message validates repo_full_name format."""
        data = self.valid_message_data.copy()
        data["repo_full_name"] = ""
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("repo_full_name must be in 'owner/repo' format", str(context.exception))

        data["repo_full_name"] = "invalid-format"
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("repo_full_name must be in 'owner/repo' format", str(context.exception))

    def test_message_requires_timestamp(self):
        """Test that message raises ValueError if timestamp is empty."""
        data = self.valid_message_data.copy()
        data["timestamp"] = ""
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("timestamp is required", str(context.exception))

    def test_message_requires_revert_action(self):
        """Test that message raises ValueError if revert_action is empty."""
        data = self.valid_message_data.copy()
        data["revert_action"] = ""
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("revert_action is required", str(context.exception))

    def test_message_validates_action_type(self):
        """Test that message validates action_type is 'merge' or 'revert'."""
        data = self.valid_message_data.copy()
        data["action_type"] = ""
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("action_type must be 'merge' or 'revert'", str(context.exception))

        data["action_type"] = "invalid"
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("action_type must be 'merge' or 'revert'", str(context.exception))

        # Valid values should work
        data["action_type"] = "merge"
        message = RevertDecisionMessage(**data)
        self.assertEqual(message.action_type, "merge")

        data["action_type"] = "revert"
        message = RevertDecisionMessage(**data)
        self.assertEqual(message.action_type, "revert")

    def test_message_requires_breaking_workflows(self):
        """Test that message raises ValueError if breaking_workflows is empty."""
        data = self.valid_message_data.copy()
        data["breaking_workflows"] = []
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("breaking_workflows must not be empty", str(context.exception))

    def test_message_requires_breaking_notification_msg(self):
        """Test that message raises ValueError if breaking_notification_msg is empty."""
        data = self.valid_message_data.copy()
        data["breaking_notification_msg"] = ""
        with self.assertRaises(ValueError) as context:
            RevertDecisionMessage(**data)
        self.assertIn("breaking_notification_msg is required", str(context.exception))

    def test_message_is_frozen(self):
        """Test that RevertDecisionMessage is immutable."""
        message = RevertDecisionMessage(**self.valid_message_data)
        with self.assertRaises(Exception):  # FrozenInstanceError
            message.action = "new_action"  # type: ignore


class TestRevertDecisionMessageSerialization(unittest.TestCase):
    """Tests for RevertDecisionMessage serialization and deserialization."""

    def setUp(self):
        """Set up common test data."""
        self.message = RevertDecisionMessage(
            action="revert_requested",
            commit_sha="abc123def456",
            pr_number=12345,
            pr_url="https://github.com/pytorch/pytorch/pull/12345",
            pr_title="Fix critical bug",
            pr_author="testuser",
            repo_full_name="pytorch/pytorch",
            timestamp="2024-01-26T10:00:00Z",
            revert_action="run_revert",
            action_type="merge",
            breaking_workflows=[
                BreakingWorkflow(
                    workflow_name="pull",
                    signals=[
                        SignalDetail(
                            key="linux-focal-py3.8-gcc7",
                            job_base_name="pull / linux-focal-py3.8-gcc7",
                            test_module=None,
                            wf_run_id=987654321,
                            job_id=123456789,
                            job_url="https://github.com/pytorch/pytorch/runs/123456789",
                            hud_url="https://hud.pytorch.org/hud",
                        )
                    ],
                ),
                BreakingWorkflow(
                    workflow_name="trunk",
                    signals=[
                        SignalDetail(key="inductor-test", job_id=999),
                        SignalDetail(key="another-test"),
                    ],
                ),
            ],
            breaking_notification_msg="This PR caused regressions in:\n- pull: signal1\n- trunk: signal2",
        )

    def test_to_json(self):
        """Test serializing message to JSON."""
        json_str = self.message.to_json()

        # Verify it's valid JSON
        data = json.loads(json_str)

        # Verify structure
        self.assertEqual(data["action"], "revert_requested")
        self.assertEqual(data["commit_sha"], "abc123def456")
        self.assertEqual(data["pr_number"], 12345)
        self.assertEqual(len(data["breaking_workflows"]), 2)
        self.assertEqual(data["breaking_workflows"][0]["workflow_name"], "pull")
        self.assertEqual(len(data["breaking_workflows"][0]["signals"]), 1)
        self.assertEqual(len(data["breaking_workflows"][1]["signals"]), 2)

    def test_from_json(self):
        """Test deserializing message from JSON."""
        json_str = self.message.to_json()
        deserialized = RevertDecisionMessage.from_json(json_str)

        # Verify all fields match
        self.assertEqual(deserialized.action, self.message.action)
        self.assertEqual(deserialized.commit_sha, self.message.commit_sha)
        self.assertEqual(deserialized.pr_number, self.message.pr_number)
        self.assertEqual(deserialized.pr_author, self.message.pr_author)
        self.assertEqual(
            len(deserialized.breaking_workflows), len(self.message.breaking_workflows)
        )

        # Verify nested structures
        self.assertEqual(
            deserialized.breaking_workflows[0].workflow_name,
            self.message.breaking_workflows[0].workflow_name,
        )
        self.assertEqual(
            deserialized.breaking_workflows[0].signals[0].key,
            self.message.breaking_workflows[0].signals[0].key,
        )
        self.assertEqual(
            deserialized.breaking_workflows[0].signals[0].job_url,
            self.message.breaking_workflows[0].signals[0].job_url,
        )

    def test_from_dict(self):
        """Test creating message from dictionary."""
        data = {
            "action": "revert_requested",
            "commit_sha": "abc123",
            "pr_number": 123,
            "pr_url": "https://github.com/pytorch/pytorch/pull/123",
            "pr_title": "Test",
            "repo_full_name": "pytorch/pytorch",
            "timestamp": "2024-01-26T10:00:00Z",
            "revert_action": "run_revert",
            "action_type": "merge",
            "breaking_workflows": [
                {
                    "workflow_name": "pull",
                    "signals": [
                        {
                            "key": "signal-1",
                            "job_id": 123,
                            "job_url": "https://github.com/runs/123",
                        }
                    ],
                }
            ],
            "breaking_notification_msg": "Test message",
        }

        message = RevertDecisionMessage.from_dict(data)

        self.assertEqual(message.action, "revert_requested")
        self.assertEqual(message.commit_sha, "abc123")
        self.assertIsInstance(message.breaking_workflows[0], BreakingWorkflow)
        self.assertIsInstance(message.breaking_workflows[0].signals[0], SignalDetail)

    def test_roundtrip_serialization(self):
        """Test that serialization and deserialization are symmetric."""
        json_str = self.message.to_json()
        deserialized = RevertDecisionMessage.from_json(json_str)
        json_str2 = deserialized.to_json()

        # The JSON strings should be identical
        self.assertEqual(json_str, json_str2)

    def test_from_json_with_invalid_json(self):
        """Test that from_json raises appropriate error for invalid JSON."""
        with self.assertRaises(json.JSONDecodeError):
            RevertDecisionMessage.from_json("invalid json")

    def test_from_json_with_missing_required_fields(self):
        """Test that from_json validates required fields."""
        incomplete_json = json.dumps({"action": "test", "pr_number": 123})
        with self.assertRaises(Exception):  # Will raise TypeError or ValueError
            RevertDecisionMessage.from_json(incomplete_json)


if __name__ == "__main__":
    unittest.main()
