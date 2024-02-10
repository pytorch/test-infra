"""
NB: This file requires a running MySQL database. On an Ubuntu machine, this can
be done with these steps: https://www.digitalocean.com/community/tutorials/how-to-install-mariadb-on-ubuntu-20-04

Once done, set the db_host, db_password and db_user env variables accordingly.
"""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path

import lambda_function

os.environ["gh_secret"] = "test"


class TestWebhook(unittest.TestCase):
    def test_real_webhooks(self):
        samples_path = Path(__file__).resolve().parent / "hooks"
        with tempfile.NamedTemporaryFile() as f:  # noqa: F841

            def load_hook(name: str):
                name = samples_path / name
                with open(name) as f:
                    data = json.load(f)

                type_name = name.name.replace(".json", "").split("-")[0]
                return type_name, data

            glob_path = os.getenv("TEST", "*.json")

            n = len(list(samples_path.glob(glob_path)))
            for i, name in enumerate(samples_path.glob(glob_path)):
                type, data = load_hook(name)
                type = type.split("-")[0]
                if i % 20 == 0:
                    print(f"{i} / {n}")
                try:
                    asyncio.run(lambda_function.handle_webhook(data, type=type))
                except Exception as e:
                    print(f"Failed on {name.name}")
                    raise e


if __name__ == "__main__":
    unittest.main()
