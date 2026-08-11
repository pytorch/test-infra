# Copyright (c) 2019-present, Facebook, Inc.

import base64
import contextlib
import gzip
import json
import os
import random
import time
from urllib.error import HTTPError
from urllib.request import urlopen
from uuid import uuid4

import boto3
import requests
from github import Auth, GithubIntegration
from github.GithubException import UnknownObjectException


s3 = boto3.resource("s3")
GITHUB_TOKENS = os.environ.get("GITHUB_TOKENS")
GITHUB_APP_ID = os.environ.get("GITHUB_APP_ID")
# Base64-encoded PEM, the same encoding torchci uses for its app key
GITHUB_APP_PRIVATE_KEY = os.environ.get("GITHUB_APP_PRIVATE_KEY")
BUCKET_NAME = "ossci-raw-job-status"

GITHUB_API_URL = "https://api.github.com"
# Installation tokens last an hour. Refresh early so a warm invocation never
# signs a request with a token that expires mid-flight.
TOKEN_EXPIRY_MARGIN = 300
# How long to remember that an owner has no app installation, so repos outside
# the installation don't trigger a lookup for every job.
NO_INSTALLATION_TTL = 900
# Used when a credential is rejected without telling us when it recovers.
DEFAULT_COOL_OFF = 60
# Statuses meaning "this credential can't do it, try the next one": rate limited
# (403 or 429) or rejected outright (401).
FALLBACK_STATUSES = (401, 403, 429)

# owner -> (installation token or None, epoch seconds the entry goes stale)
_token_cache = {}


def json_dumps(obj):
    return json.dumps(obj, sort_keys=True, indent=4, separators=(",", ": "))


def app_private_key():
    key = GITHUB_APP_PRIVATE_KEY
    if "PRIVATE KEY" not in key:
        key = base64.b64decode(key).decode("utf-8")
    return key


def cool_off_until(response):
    reset = response.headers.get("x-ratelimit-reset")
    if reset:
        with contextlib.suppress(ValueError):
            return float(reset)
    return time.time() + DEFAULT_COOL_OFF


def fetch_installation_token(full_name):
    """Mint an installation token for the app installation covering full_name.

    Returns (None, expiry) when the app isn't installed on that owner, so the
    caller falls back to a PAT instead of retrying the lookup for every job.
    """
    owner, repo = full_name.split("/", 1)
    integration = GithubIntegration(
        auth=Auth.AppAuth(int(GITHUB_APP_ID), app_private_key())
    )

    try:
        installation = integration.get_repo_installation(owner, repo)
    except UnknownObjectException:
        return None, time.time() + NO_INSTALLATION_TTL

    token = integration.get_access_token(installation.id)
    return token.token, token.expires_at.timestamp() - TOKEN_EXPIRY_MARGIN


def installation_token(full_name):
    """Cached installation token for full_name's owner, or None if unavailable."""
    if not GITHUB_APP_ID or not GITHUB_APP_PRIVATE_KEY:
        return None

    owner = full_name.split("/")[0]
    cached = _token_cache.get(owner)
    if cached and time.time() < cached[1]:
        return cached[0]

    try:
        token, expires_at = fetch_installation_token(full_name)
    except Exception as err:
        # Deliberately broad: a bad app id, an unparseable private key or a
        # GitHub blip must degrade to the PAT pool, never fail the webhook and
        # lose the payload archiving that happens after the log download.
        # Not cached either, so the next invocation retries.
        print(f"ERROR minting installation token for {owner}: {err}")
        return None

    _token_cache[owner] = (token, expires_at)
    return token


def fetch_log(full_name, job_id, token):
    url = f"{GITHUB_API_URL}/repos/{full_name}/actions/jobs/{job_id}/logs"
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": "token " + token,
    }
    return requests.get(url, headers=headers, timeout=30)


def download_log(full_name, conclusion, job_id):
    response = None

    app_token = installation_token(full_name)
    if app_token:
        response = fetch_log(full_name, job_id, app_token)
        if response.status_code in FALLBACK_STATUSES:
            # Stop using the app until its window resets, otherwise every job
            # for the rest of the hour pays for a doomed request first.
            owner = full_name.split("/")[0]
            _token_cache[owner] = (None, cool_off_until(response))
            print(
                f"App auth returned {response.status_code} for {full_name} "
                f"job {job_id}, falling back to a PAT"
            )
            response = None

    if response is None:
        if not GITHUB_TOKENS:
            print(f"ERROR no usable credential for {full_name} job {job_id}")
            return
        response = fetch_log(full_name, job_id, random.choice(GITHUB_TOKENS.split(",")))

    if not response.ok:
        # Bail out rather than archive the API error body as if it were the log
        print(
            f"ERROR {response.status_code} downloading log for {full_name} job {job_id}"
        )
        return

    log_data = response.content

    object_path = f"log/{job_id}"
    if full_name != "pytorch/pytorch":
        object_path = f"log/{full_name}/{job_id}"
    # Note: brotli would compress better, but is annoying to add as a dep
    # If space becomes a problem it's roughly ~2x better in TEXT_MODE
    s3.Object(BUCKET_NAME, object_path).put(
        Body=gzip.compress(log_data),
        ContentType="text/plain",
        ContentEncoding="gzip",
        Metadata={"conclusion": conclusion},
    )

    # Fire off to the `log_classifier` lambda
    urlopen(
        f"https://vwg52br27lx5oymv4ouejwf4re0akoeg.lambda-url.us-east-1.on.aws/?job_id={job_id}&repo={full_name}"
    )


# See this page for webhook info:
# https://docs.github.com/en/developers/webhooks-and-events/webhook-events-and-payloads
def lambda_handler(event, context):
    event_type = event["headers"]["X-GitHub-Event"]
    body = json.loads(event["body"])
    action = body.get("action", "")

    if event_type == "workflow_job" and (action == "completed" or action == "backfill"):
        try:
            full_name = body["repository"]["full_name"]
            conclusion = body[event_type]["conclusion"]
            job_id = body[event_type]["id"]
            download_log(full_name, conclusion, job_id)
        except (HTTPError, requests.RequestException) as err:
            # Just eat the error as logs are optional.
            print("ERROR", err)
            pass

        if action == "backfill":
            return {
                "statusCode": 200,
                "body": f"Backfill {event_type} processed: {body}",
            }

    if event_type == "workflow_job" or event_type == "workflow_run":
        obj = body[event_type]
        repo = body["repository"]["full_name"]

        # Here we intentionally don't generate a uuid so that webhook payloads
        # that map to a single payload overwrite each other, which gives us the
        # behavior that the object always represents the latest state of a job.
        #
        # However, this means that there is the chance that job ids from
        # different repos could collide. To prevent this, prefix the objects
        # generated by non-pytorch repos (we could prefix pytorch objects as
        # well, but too lazy to do the data migration).
        if repo == "pytorch/pytorch":
            repo_prefix = ""
        else:
            repo_prefix = repo + "/"
        s3.Object(BUCKET_NAME, f"{event_type}/{repo_prefix}{obj['id']}").put(
            Body=json_dumps(obj), ContentType="application/json"
        )

        # For testing, dump the whole thing
        obj = body
        s3.Object(BUCKET_NAME, f"full_{event_type}/{uuid4()}").put(
            Body=json_dumps(obj), ContentType="application/json"
        )

        return {"statusCode": 200, "body": f"{event_type} processed: {obj}"}

    s3.Object(BUCKET_NAME, f"{event_type}/{uuid4()}").put(
        Body=json_dumps(body), ContentType="application/json"
    )

    return {"statusCode": 200, "body": f"{event_type} processed: {body}"}
