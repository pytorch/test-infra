#!/usr/bin/env python3
"""Call the HUD API to detect and disable flaky tests.

This script is invoked by the 'Disable Flaky Tests' workflow. It POSTs to the
/api/flaky-tests/disable endpoint and validates that the request was actually
processed (as opposed to being silently swallowed by Vercel's bot protection).
"""

import os
import sys
import urllib.error
import urllib.request


HUD_URL = "https://www.torch-ci.com/api/flaky-tests/disable"


def main() -> None:
    auth_token = os.environ.get("FLAKY_TEST_BOT_KEY", "")
    hud_bot_token = os.environ.get("X_HUD_BOT_TOKEN", "")

    if not auth_token:
        print("::error::FLAKY_TEST_BOT_KEY is not set")
        sys.exit(1)

    headers = {
        "Authorization": auth_token,
    }
    if hud_bot_token:
        headers["x-hud-internal-bot"] = hud_bot_token

    req = urllib.request.Request(HUD_URL, method="POST", headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        status = e.code
    except urllib.error.URLError as e:
        print(f"::error::Connection failed: {e.reason}")
        sys.exit(1)

    if status != 200:
        print(f"::error::Request failed with HTTP {status}")
        print(body[:2000])
        sys.exit(1)

    if "Vercel Security Checkpoint" in body:
        print("::error::Request was blocked by Vercel bot protection")
        sys.exit(1)

    print(f"Successfully called {HUD_URL} (HTTP {status})")


if __name__ == "__main__":
    main()
