#!/usr/bin/env python3
import io
import json
import unittest
import urllib.error
from contextlib import redirect_stdout
from datetime import datetime, timezone
from email.message import Message
from typing import Any
from unittest import mock

import pr_notifications_slack as pns


NOW = datetime(2026, 10, 5, 13, 0, tzinfo=timezone.utc)


def pr(
    number: int, since: str | None, title: str = "", open_source: bool = True
) -> dict[str, Any]:
    return {
        "title": title or f"PR {number}",
        "url": f"https://github.com/pytorch/pytorch/pull/{number}",
        "open_source": open_source,
        "stage_since": since,
    }


MANIFEST: dict[str, Any] = {
    "generated_at": "2026-10-05T12:00:00.000Z",
    "prs": {
        "2": pr(2, "2026-09-30T00:00:00Z", title="Fix <script> & co"),
        "3": pr(3, None, open_source=False),
        "4": pr(4, "2026-10-01T00:00:00Z"),
    },
    "reviewers": {
        "alice": {"final_review": [{"pr": 3}, {"pr": 4}]},
        "bob": {"final_review": [{"pr": 4}]},
        "carol": {"final_review": []},
    },
    "failed_prs": [],
}


class RenderDigestTest(unittest.TestCase):
    def test_escapes_titles(self) -> None:
        manifest = json.loads(json.dumps(MANIFEST))
        manifest["reviewers"]["bob"]["final_review"] = [{"pr": 2}]
        self.assertIn(
            "#2 Fix &lt;script&gt; &amp; co>", pns.render_digest(manifest, "bob") or ""
        )

    def test_old_manifest_prs_count_as_oss(self) -> None:
        manifest = json.loads(json.dumps(MANIFEST))
        del manifest["prs"]["4"]["open_source"]
        digest = pns.render_digest(manifest, "bob") or ""
        self.assertIn("OSS PRs (1)", digest)
        self.assertNotIn("Maintainer PRs", digest)

    def test_nothing_waiting(self) -> None:
        self.assertIsNone(pns.render_digest(MANIFEST, "carol"))
        self.assertIsNone(pns.render_digest(MANIFEST, "nobody"))


class FetchManifestTest(unittest.TestCase):
    def _fetch(self, generated_at: str, live: bool = True) -> dict[str, Any]:
        manifest = {**MANIFEST, "generated_at": generated_at}
        body = io.BytesIO(json.dumps(manifest).encode())
        with mock.patch("urllib.request.urlopen", return_value=body) as urlopen:
            fetched = pns.fetch_manifest("2026-10-05", NOW, live)
        self.assertIn("manifest-2026-10-05.json", urlopen.call_args.args[0])
        return fetched

    def test_fresh(self) -> None:
        self.assertEqual(self._fetch("2026-10-05T12:00:00.000Z"), MANIFEST)

    def test_stale_only_fails_live(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "stale"):
            self._fetch("2026-10-04T12:00:00.000Z")
        self._fetch("2026-10-04T12:00:00.000Z", live=False)


class SlackClientTest(unittest.TestCase):
    def _respond(self, *bodies: Any) -> mock._patch:
        responses = [
            b if isinstance(b, Exception) else io.BytesIO(json.dumps(b).encode())
            for b in bodies
        ]
        return mock.patch("urllib.request.urlopen", side_effect=responses)

    def test_error_raises(self) -> None:
        with self._respond({"ok": False, "error": "channel_not_found"}):
            with self.assertRaisesRegex(RuntimeError, "channel_not_found"):
                pns.SlackClient("t").call("conversations.members", {})

    def test_retries_rate_limit(self) -> None:
        headers = Message()
        headers["Retry-After"] = "0"
        limited = urllib.error.HTTPError("", 429, "", headers, None)
        with self._respond(limited, {"ok": True}) as urlopen:
            body = pns.SlackClient("t").call("chat.postMessage", {})
        self.assertEqual(body, {"ok": True})
        self.assertEqual(urlopen.call_count, 2)

    def test_channel_members_pages(self) -> None:
        with self._respond(
            {"ok": True, "members": ["U1"], "response_metadata": {"next_cursor": "c"}},
            {"ok": True, "members": ["U2"], "response_metadata": {"next_cursor": ""}},
        ) as urlopen:
            self.assertEqual(pns.SlackClient("t").channel_members("C"), ["U1", "U2"])
        self.assertIn(b"cursor=c", urlopen.call_args_list[1].args[0].data)


class SendDigestsTest(unittest.TestCase):
    def _send(
        self, live: bool, send_error: Exception | None = None
    ) -> tuple[list[str], mock.Mock, str]:
        slack = mock.Mock()
        # UBOT is a bot in the channel, UDAVE is mapped but not in the channel,
        # and UBOB registered before logins were lowercased
        slack.channel_members.return_value = ["UALICE", "UBOB", "UCAROL", "UBOT"]
        slack.send_dm.side_effect = send_error
        users = {"UALICE": "alice", "UBOB": "Bob", "UCAROL": "carol", "UDAVE": "alice"}
        out = io.StringIO()
        with redirect_stdout(out):
            failures = pns.send_digests(slack, users, MANIFEST, live)
        return failures, slack, out.getvalue()

    def test_only_channel_members_are_messaged(self) -> None:
        failures, slack, out = self._send(live=True)
        self.assertEqual(failures, [])
        slack.channel_members.assert_called_once_with(pns.CHANNEL_ID)
        sent_to = [c.args[0] for c in slack.send_dm.call_args_list]
        self.assertEqual(sent_to, ["UALICE", "UBOB"])
        self.assertIn("sent=2 failed=0 nothing_waiting=1 unmapped=1", out)

    def test_dry_run_sends_nothing(self) -> None:
        _, slack, out = self._send(live=False)
        slack.send_dm.assert_not_called()
        self.assertIn("would send to UALICE (alice)", out)

    def test_dry_run_without_token_previews_registered_members(self) -> None:
        users = {"UALICE": "alice", "UBOB": "bob"}
        out = io.StringIO()
        with redirect_stdout(out):
            pns.send_digests(pns.SlackClient(""), users, MANIFEST, False)
        self.assertIn("would send to UALICE (alice)", out.getvalue())
        self.assertIn("would send to UBOB (bob)", out.getvalue())

    def test_failures_are_returned(self) -> None:
        failures, _, out = self._send(live=True, send_error=RuntimeError("boom"))
        self.assertEqual(failures, ["alice: boom", "bob: boom"])
        self.assertIn("failed alice: boom\n", out)


if __name__ == "__main__":
    unittest.main()
