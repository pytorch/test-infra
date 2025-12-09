import os
import sys
import unittest


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


if __name__ == "__main__":
    unittest.main()
