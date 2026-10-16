#!/usr/bin/env python3

"""
Daily PyTorch PR review digest for the PyTorch Slack workspace.

Reads the day's manifest of PRs waiting on each reviewer, written to S3 by the
pr-notifications-manifest workflow, and DMs it to each member of the opt-in
#auto-pr-triage-notifications channel. Channel admins decide who is in the
channel, and members register their GitHub login by posting `github: <login>`
there. Only channel members are ever messaged.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo


MANIFEST_URL_TEMPLATE = (
    "https://ossci-raw-job-status.s3.amazonaws.com/"
    "review-logs/pr-notifications/manifest-{date}.json"
)
CHANNEL_ID = "C0C8N0L7U5Q"
# Slack member ID -> GitHub login, saved by the HUD's
# /api/pr_notifications/slack_events when a member posts `github: <login>` in
# the channel. Entries of people who left the channel are ignored, so removing
# someone from the channel is enough to stop their digest.
SLACK_USERS_URL = (
    "https://ossci-raw-job-status.s3.amazonaws.com/"
    "review-logs/pr-notifications/slack-users.json"
)
# The manifest is written two hours before the send, so an older one means
# today's write failed.
MAX_MANIFEST_AGE = timedelta(hours=6)
PRE_REVIEW_OVERDUE = timedelta(days=2)
NEW_YORK = ZoneInfo("America/New_York")
PRE_REVIEW_QUEUE_URL = (
    "https://github.com/pytorch/pytorch/pulls?q=is%3Apr%20is%3Aopen%20-is%3Adraft"
    "%20review-requested%3A%40me%20label%3Atriaged%20-label%3A%22in%20progress%22"
    "%20-label%3A%22ready%20for%20review%22"
    "%20-label%3A%22missing%20actionable%20issue%22"
)
FINAL_REVIEW_QUEUE_URL = (
    "https://github.com/pytorch/pytorch/pulls?q=is%3Apr%20is%3Aopen"
    "%20review-requested%3A%40me%20label%3A%22ready%20for%20review%22"
    "%20-label%3A%22missing%20actionable%20issue%22"
)
MAX_RATE_LIMIT_ATTEMPTS = 3


def fetch_manifest(date: str, now: datetime, live: bool) -> dict[str, Any]:
    """Download the manifest of `date`. A missing one raises, and so does a stale
    one when sending live, so a broken generator fails the run instead of silently
    sending nothing."""
    url = MANIFEST_URL_TEMPLATE.format(date=date)
    with urllib.request.urlopen(url, timeout=60) as response:
        manifest = json.load(response)
    generated_at = datetime.fromisoformat(manifest["generated_at"])
    if live and now - generated_at > MAX_MANIFEST_AGE:
        raise RuntimeError(f"Manifest is stale, generated at {generated_at}")
    return manifest


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _format_pr(manifest: dict[str, Any], entry: dict[str, Any]) -> str:
    pr = manifest["prs"][str(entry["pr"])]
    return f"• <{pr['url']}|#{entry['pr']} {_escape(pr['title'])}>"


def render_digest(manifest: dict[str, Any], login: str, now: datetime) -> str | None:
    """The Slack mrkdwn digest for `login`, or None if nothing waits on them."""
    stages = manifest["reviewers"].get(login)
    if stages is None:
        return None

    # PRs whose label time is unknown sort last and are never overdue
    never = datetime.max.replace(tzinfo=timezone.utc)

    def waiting_since(entry: dict[str, Any]) -> datetime:
        since = manifest["prs"][str(entry["pr"])]["stage_since"]
        return datetime.fromisoformat(since) if since else never

    pre_review = sorted(stages["pre_review"], key=waiting_since)
    final_review = sorted(stages["final_review"], key=waiting_since)
    if not pre_review and not final_review:
        return None
    overdue = [e for e in pre_review if waiting_since(e) < now - PRE_REVIEW_OVERDUE]
    days = PRE_REVIEW_OVERDUE.days

    lines = ["*Daily digest: PyTorch PRs waiting on your review*"]
    if pre_review:
        header = f"*Pre-review ({len(pre_review)})*"
        accept = "To accept, :+1: the PR description or comment `@pytorchbot pre-review accept`."  # noqa: B950
        lines += ["", f"{header} (<{PRE_REVIEW_QUEUE_URL}|full queue>)", accept, ""]
        for title, entries in [
            # Slack mrkdwn needs > escaped
            (f"Waiting &gt;{days} days", overdue),
            (f"Waiting ≤{days} days", [e for e in pre_review if e not in overdue]),
        ]:
            if entries:
                lines.append(f"{title} ({len(entries)})")
                lines.extend(_format_pr(manifest, e) for e in entries)
    if final_review:
        header = f"*Final review ({len(final_review)})*"
        lines += ["", f"{header} (<{FINAL_REVIEW_QUEUE_URL}|full queue>)"]
        prs = manifest["prs"]
        # Manifests from before open_source was added hold only OSS PRs
        oss = [e for e in final_review if prs[str(e["pr"])].get("open_source", True)]
        for title, entries in [
            ("OSS PRs", oss),
            ("Maintainer PRs", [e for e in final_review if e not in oss]),
        ]:
            if entries:
                lines.append(f"{title} ({len(entries)})")
                lines.extend(_format_pr(manifest, e) for e in entries)
    return "\n".join(lines)


class SlackClient:
    def __init__(self, token: str) -> None:
        self.token = token

    def call(self, method: str, params: dict[str, str]) -> dict[str, Any]:
        """Calls a Slack Web API method. Slack reports most errors as ok=false
        with HTTP 200, and rate limits as HTTP 429 with Retry-After."""
        request = urllib.request.Request(
            f"https://slack.com/api/{method}",
            data=urllib.parse.urlencode(params).encode(),
            headers={"Authorization": f"Bearer {self.token}"},
        )
        for attempt in range(1, MAX_RATE_LIMIT_ATTEMPTS + 1):
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    body = json.load(response)
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == MAX_RATE_LIMIT_ATTEMPTS:
                    raise
                time.sleep(int(e.headers.get("Retry-After", "1")))
        if not body.get("ok"):
            raise RuntimeError(f"{method}: {body.get('error')}")
        return body

    def channel_members(self, channel: str) -> list[str]:
        members: list[str] = []
        params = {"channel": channel, "limit": "200"}
        while True:
            body = self.call("conversations.members", params)
            members += body["members"]
            params["cursor"] = body.get("response_metadata", {}).get("next_cursor", "")
            if not params["cursor"]:
                return members

    def send_dm(self, user_id: str, text: str) -> None:
        # Posting to a user ID lands in that user's DM with the app
        params = {"channel": user_id, "text": text, "unfurl_links": "false"}
        self.call("chat.postMessage", params)


def send_digests(
    slack: SlackClient,
    users: dict[str, str],
    manifest: dict[str, Any],
    live: bool,
    now: datetime,
) -> list[str]:
    """Send (or with live=False, print) the digest for every channel member,
    and return "<login>: <error>" for each send that failed."""
    sent, nothing, unmapped, failures = 0, 0, [], []
    # Pull request dry runs get no token, so they preview every registered member
    members = slack.channel_members(CHANNEL_ID) if slack.token else list(users)
    for member in members:
        login = users.get(member)
        if login is None:
            # Bots and members who haven't registered yet
            unmapped.append(member)
            continue
        # Registrations saved before logins were lowercased keep their case,
        # but the manifest's reviewer keys are lowercase
        login = login.lower()
        text = render_digest(manifest, login, now)
        if text is None:
            nothing += 1
            continue
        if not live:
            print(f"=== DRY RUN - would send to {member} ({login}) ===\n{text}\n")
            continue
        try:
            slack.send_dm(member, text)
        except Exception as e:
            failures.append(f"{login}: {e}")
            print(f"failed {login}: {e}")
            continue
        sent += 1
        print(f"sent {login}")
    print(
        f"sent={sent} failed={len(failures)} nothing_waiting={nothing} "
        f"unmapped={len(unmapped)} manifest_failed_prs={len(manifest['failed_prs'])}"
    )
    if unmapped:
        print(f"Channel members who haven't registered: {', '.join(unmapped)}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="send DMs, not a dry run")
    parser.add_argument("--date", help="manifest date as YYYY-MM-DD, default today")
    args = parser.parse_args()
    token = os.environ.get("PYTORCH_SLACK_BOT_TOKEN", "")
    if args.live and not token:
        parser.error("--live needs PYTORCH_SLACK_BOT_TOKEN")

    now = datetime.now(timezone.utc)
    # Nobody should get a digest on a weekend
    if args.live and now.astimezone(NEW_YORK).weekday() >= 5:
        print("Weekend in New York, not sending")
        return 0
    try:
        with urllib.request.urlopen(SLACK_USERS_URL, timeout=60) as response:
            users = json.load(response)
    except urllib.error.HTTPError as e:
        # The first registration creates it
        if e.code != 404:
            raise
        users = {}
    manifest = fetch_manifest(args.date or now.strftime("%Y-%m-%d"), now, args.live)
    failures = send_digests(SlackClient(token), users, manifest, args.live, now)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
