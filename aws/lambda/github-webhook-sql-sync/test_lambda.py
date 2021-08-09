import os
os.environ["gh_secret"] = "test"

import lambda_function
import json
import asyncio
import sys
import io
import unittest
import contextlib
from pathlib import Path
import tempfile
from typing import List


class TestWebhook(unittest.TestCase):
    @staticmethod
    def init_tests():
        tests = [
            ["create.json"],
            ["issues.json"],
            ["pull_request.json"],
            ["push.json"],
            ["create.json", "issues.json", "pull_request.json", "push.json", "check_run.json", "check_suite.json", "workflow_job.json"],
            ["push.json", "push.json", "issues.json", "issues.json"],
            ["push.json", "push.json", "pull_request.json", "create.json"],
        ]

        for names in tests:
            name = "_".join([x.replace(".json", "") for x in names])
            def test_impl(self):
                self._test_webhooks(names)
            setattr(TestWebhook, "test_" + name, test_impl)

    def _test_webhooks(self, hook_filenames: List[str]):
        samples_path = Path(__file__).resolve().parent / "samples"
        with tempfile.NamedTemporaryFile() as f:
            def load_hook(name: str):
                name = samples_path / name
                with open(name) as f:
                    data = json.load(f)

                return name.name.replace(".json", ""), data

            hook_data = [load_hook(f) for f in hook_filenames]
            def sqlite():
                print("fetching db")
                return f"sqlite:///{f.name}"
            lambda_function.connection_string = sqlite

            err = io.StringIO()
            out = io.StringIO()
            for type, data in hook_data:
                with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
                    asyncio.run(lambda_function.handle_webhook(data, type=type))
            err = err.getvalue()
            out = out.getvalue()
            # print(err)
            # print(out)


if __name__ == "__main__":
    TestWebhook.init_tests()
    unittest.main()
