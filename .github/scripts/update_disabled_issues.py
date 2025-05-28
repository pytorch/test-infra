#!/usr/bin/env python3
"""
Query for the DISABLED and UNSTABLE issues and check:
  * if they are still flaky for disabled tests
  * if they are to disable workflow jobs
  * if they are to mark workflow jobs as unstable
"""

import json
import os
from typing import Any, Dict
from urllib.request import Request, urlopen


HUD_URL = "https://hud.pytorch.org"


def dump_json(data: Dict[str, Any], filename: str):
    with open(filename, mode="w") as file:
        json.dump(data, file, sort_keys=True, indent=2)


def main() -> None:
    with urlopen(
        Request(
            f"{HUD_URL}/api/flaky-tests/getJSON",
            headers={"Authorization": os.environ["FLAKY_TEST_BOT_KEY"]},
        )
    ) as result:
        if result.status != 200:
            raise RuntimeError(f"Failed to fetch data: {result.status} {result.reason}")

        json_data = json.loads(result.read().decode("utf-8"))

    dump_json(json_data["disabledTests"], "disabled-tests-condensed.json")
    dump_json(json_data["disabledJobs"], "disabled-jobs.json")
    dump_json(json_data["unstableJobs"], "unstable-jobs.json")


if __name__ == "__main__":
    main()
