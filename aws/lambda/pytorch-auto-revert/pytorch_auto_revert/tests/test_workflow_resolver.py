import os
import sys
import unittest
from unittest.mock import MagicMock

import github


# Ensure package import when running from repo root
sys.path.insert(0, "aws/lambda/pytorch-auto-revert")

from pytorch_auto_revert.github_client_helper import GHClientFactory
from pytorch_auto_revert.workflow_resolver import WorkflowResolver


class TestWorkflowResolverRealRepo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if token:
            GHClientFactory.setup_client(token=token)
        else:
            raise unittest.SkipTest(
                "Skipping real GitHub resolver tests: GITHUB_TOKEN not configured"
            )

    def test_resolve_pull_workflow(self):
        resolver = WorkflowResolver.get("pytorch/pytorch")

        # Resolve by display name
        pull_by_name = resolver.resolve("pull")
        self.assertIsNotNone(pull_by_name, "Expected to resolve 'pull' by display name")

        # Resolve by basename
        pull_by_file = resolver.resolve("pull.yml")
        self.assertIsNotNone(
            pull_by_file, "Expected to resolve 'pull.yml' by file name"
        )
        self.assertTrue(
            pull_by_file.file_name.endswith("pull.yml"),
            "Resolved file name should be 'pull.yml'",
        )

    def test_resolve_trunk_workflow(self):
        resolver = WorkflowResolver.get("pytorch/pytorch")

        trunk_by_name = resolver.resolve("trunk")
        self.assertIsNotNone(
            trunk_by_name, "Expected to resolve 'trunk' by display name"
        )

        trunk_by_file = resolver.resolve("trunk.yml")
        self.assertIsNotNone(
            trunk_by_file, "Expected to resolve 'trunk.yml' by file name"
        )
        self.assertTrue(
            trunk_by_file.file_name.endswith("trunk.yml"),
            "Resolved file name should be 'trunk.yml'",
        )


class TestParseWorkflowInputs(unittest.TestCase):
    """Unit tests for _parse_workflow_inputs without GitHub API calls."""

    def _create_resolver(self) -> WorkflowResolver:
        """Create a resolver with mocked repository for testing."""
        mock_repo = MagicMock(spec=github.Repository.Repository)
        mock_repo.get_workflows.return_value = []
        return WorkflowResolver(repo_full_name="test/repo", repository=mock_repo)

    def test_parse_workflow_with_both_inputs(self):
        resolver = self._create_resolver()
        yaml_content = """
name: trunk
on:
  workflow_dispatch:
    inputs:
      jobs-to-include:
        description: 'Space-separated job names'
        required: false
        type: string
      tests-to-include:
        description: 'Space-separated test modules'
        required: false
        type: string
"""
        result = resolver._parse_workflow_inputs(yaml_content)
        self.assertTrue(result.jobs_to_include)
        self.assertTrue(result.tests_to_include)
        self.assertTrue(result.supports_filtering)

    def test_parse_workflow_with_jobs_only(self):
        resolver = self._create_resolver()
        yaml_content = """
name: trunk
on:
  workflow_dispatch:
    inputs:
      jobs-to-include:
        type: string
"""
        result = resolver._parse_workflow_inputs(yaml_content)
        self.assertTrue(result.jobs_to_include)
        self.assertFalse(result.tests_to_include)

    def test_parse_workflow_with_tests_only(self):
        resolver = self._create_resolver()
        yaml_content = """
name: trunk
on:
  workflow_dispatch:
    inputs:
      tests-to-include:
        type: string
"""
        result = resolver._parse_workflow_inputs(yaml_content)
        self.assertFalse(result.jobs_to_include)
        self.assertTrue(result.tests_to_include)

    def test_parse_workflow_no_inputs(self):
        resolver = self._create_resolver()
        yaml_content = """
name: trunk
on:
  workflow_dispatch:
"""
        result = resolver._parse_workflow_inputs(yaml_content)
        self.assertFalse(result.jobs_to_include)
        self.assertFalse(result.tests_to_include)
        self.assertFalse(result.supports_filtering)

    def test_parse_workflow_no_workflow_dispatch(self):
        resolver = self._create_resolver()
        yaml_content = """
name: ci
on:
  push:
    branches: [main]
  pull_request:
"""
        result = resolver._parse_workflow_inputs(yaml_content)
        self.assertFalse(result.jobs_to_include)
        self.assertFalse(result.tests_to_include)

    def test_parse_workflow_simple_on_trigger(self):
        resolver = self._create_resolver()
        yaml_content = """
name: simple
on: push
"""
        result = resolver._parse_workflow_inputs(yaml_content)
        self.assertFalse(result.jobs_to_include)
        self.assertFalse(result.tests_to_include)

    def test_parse_workflow_empty_yaml(self):
        resolver = self._create_resolver()
        result = resolver._parse_workflow_inputs("")
        self.assertFalse(result.jobs_to_include)
        self.assertFalse(result.tests_to_include)

    def test_parse_workflow_invalid_yaml(self):
        resolver = self._create_resolver()
        # Invalid YAML is caught and returns empty support (doesn't raise)
        result = resolver._parse_workflow_inputs("{{invalid yaml::")
        self.assertFalse(result.jobs_to_include)
        self.assertFalse(result.tests_to_include)

    def test_parse_workflow_on_as_true_yaml11(self):
        """YAML 1.1 parses 'on' as boolean True in some cases."""
        resolver = self._create_resolver()
        # This simulates what happens when YAML parser treats 'on' as True
        yaml_content = """
name: trunk
true:
  workflow_dispatch:
    inputs:
      jobs-to-include:
        type: string
"""
        result = resolver._parse_workflow_inputs(yaml_content)
        self.assertTrue(result.jobs_to_include)


if __name__ == "__main__":
    unittest.main()
