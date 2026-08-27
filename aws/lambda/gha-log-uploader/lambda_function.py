# Copyright (c) 2019-present, Facebook, Inc.

"""Download a completed GitHub Actions job log, archive it to S3, and classify it.

Invoked asynchronously (``InvocationType: "Event"``) by the PyTorch bot's
``workflow_job`` handler in torchci, and by torchci's backfill route. There is no
API Gateway integration and no Lambda function URL: the only way in is
``lambda:InvokeFunction``, which is IAM-authenticated.

Classification is kicked off through log_classifier's function URL, with a
bounded wait for the reply so a hung classifier cannot burn this function's whole
timeout. Switching to an async ``lambda:InvokeFunction`` needs log_classifier to
accept a plain payload first; see the README.
"""

import base64
import contextlib
import gzip
import os
import random
import time
from urllib.request import urlopen

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
LOG_CLASSIFIER_URL = (
    "https://vwg52br27lx5oymv4ouejwf4re0akoeg.lambda-url.us-east-1.on.aws"
)
# How long to wait for the classifier's reply before giving up on it. Classifying
# a big log can take minutes, and waiting that out is pointless: nothing here
# reads the result, and disconnecting does not cancel the classifier.
CLASSIFIER_TIMEOUT = 30

GITHUB_API_URL = "https://api.github.com"
# Installation tokens last an hour. Refresh early so a warm invocation never
# signs a request with a token that expires mid-flight.
TOKEN_EXPIRY_MARGIN = 300
# How long to remember that a repo has no app installation, so repos outside
# the installation don't trigger a lookup for every job.
NO_INSTALLATION_TTL = 900
# Used when a credential is rejected without telling us when it recovers.
DEFAULT_COOL_OFF = 60
# Statuses meaning "this credential can't do it, try the next one": rate limited
# (403 or 429) or rejected outright (401).
FALLBACK_STATUSES = (401, 403, 429)

# Keyed by "owner/repo", not owner: get_repo_installation() resolves per repo,
# so a "Selected repositories" install can cover one repo of an owner and not
# its sibling. Sharing an owner's entry would hand a repo a token minted for a
# different one, or let one repo's "not installed" result mask another's.
# full_name -> (installation token or None, epoch seconds the entry goes stale)
_token_cache = {}


class RetryableDownloadError(Exception):
    """A download failure worth another attempt.

    Raised rather than returned so the async invocation fails: Lambda retries it
    twice and then hands it to the dead-letter queue, which is the only place a
    permanently lost log gets reported.
    """


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

    Returns (None, expiry) when the app isn't installed on that repo, so the
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
    """Cached installation token for full_name, or None if unavailable."""
    if not GITHUB_APP_ID or not GITHUB_APP_PRIVATE_KEY:
        return None

    cached = _token_cache.get(full_name)
    if cached and time.time() < cached[1]:
        return cached[0]

    try:
        token, expires_at = fetch_installation_token(full_name)
    except Exception as err:
        # Deliberately broad: a bad app id, an unparseable private key or a
        # GitHub blip must degrade to the PAT pool rather than raise. Not cached
        # either, so the next invocation retries.
        print(f"ERROR minting installation token for {full_name}: {err}")
        return None

    _token_cache[full_name] = (token, expires_at)
    return token


def fetch_log(full_name, job_id, token):
    url = f"{GITHUB_API_URL}/repos/{full_name}/actions/jobs/{job_id}/logs"
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": "token " + token,
    }
    return requests.get(url, headers=headers, timeout=30)


def log_object_path(full_name, job_id):
    """S3 key for a job's log.

    pytorch/pytorch is unprefixed for historical reasons and must stay that way:
    default.workflow_job's `log_url` ALIAS in ClickHouse derives the URL from
    this exact scheme.
    """
    if full_name == "pytorch/pytorch":
        return f"log/{job_id}"
    return f"log/{full_name}/{job_id}"


def classify_log(full_name, job_id):
    """Kick off classification for a log we just stored.

    The function URL only supports the RequestResponse invocation type, so there
    is no way to ask for fire-and-forget -- but giving up on the reply is close
    enough, because a client disconnect does not cancel the classifier. It runs
    to completion either way; we just stop waiting.

    That bound matters. `urlopen` with no `timeout` has none at all, so a
    connection that is accepted and never answered raises nothing and instead
    burns the whole function timeout. Callers invoke this asynchronously, which
    means Lambda would count that as a failure and replay the entire invocation
    twice more, re-downloading the same multi-megabyte log each time. This is an
    observed tail rather than a theoretical one: the predecessor made the same
    call unbounded and regularly hit its 900s ceiling.

    Returns True when the classifier answered. False means we stopped waiting or
    the call failed, and only the second of those actually skips classification.
    """
    try:
        urlopen(
            f"{LOG_CLASSIFIER_URL}/?job_id={job_id}&repo={full_name}",
            timeout=CLASSIFIER_TIMEOUT,
        )
        return True
    except Exception as err:
        # Best effort, deliberately. Raising would make Lambda retry the whole
        # function and re-download a multi-megabyte log from GitHub, when the log
        # itself is already safe in S3.
        print(f"ERROR calling the classifier for {full_name} job {job_id}: {err}")
        return False


def is_retryable(status_code):
    """Whether GitHub answering with this is worth another attempt.

    Server errors and rate limits go away on their own; 404 (the log has aged
    out, which GitHub does after a couple of months) and the auth failures do
    not, and replaying those only re-runs a download that will fail identically.
    """
    return status_code >= 500 or status_code == 429


def download_log(full_name, conclusion, job_id):
    """Fetch a job log from GitHub and archive it. Returns True when stored.

    Returns False for failures that a retry cannot fix, and raises
    RetryableDownloadError for the ones it can. Because callers invoke this
    function asynchronously, raising is what puts a job in front of Lambda's
    retries and, if they all fail, on the dead-letter queue -- returning False
    records the invocation as a success and the lost log goes unreported.
    """
    response = None

    app_token = installation_token(full_name)
    if app_token:
        response = fetch_log(full_name, job_id, app_token)
        if response.status_code in FALLBACK_STATUSES:
            # Stop using the app until its window resets, otherwise every job
            # for the rest of the hour pays for a doomed request first.
            _token_cache[full_name] = (None, cool_off_until(response))
            print(
                f"App auth returned {response.status_code} for {full_name} "
                f"job {job_id}, falling back to a PAT"
            )
            response = None

    if response is None:
        if not GITHUB_TOKENS:
            # A misconfiguration, so retrying will not fix it -- but it costs
            # every repo every log, and the DLQ is where that has to show up.
            raise RetryableDownloadError(
                f"no usable credential for {full_name} job {job_id}"
            )
        response = fetch_log(full_name, job_id, random.choice(GITHUB_TOKENS.split(",")))

    if not response.ok:
        # Bail out rather than archive the API error body as if it were the log
        if is_retryable(response.status_code):
            raise RetryableDownloadError(
                f"{response.status_code} downloading log for {full_name} job {job_id}"
            )
        print(
            f"ERROR {response.status_code} downloading log for {full_name} job {job_id}"
        )
        return False

    # Note: brotli would compress better, but is annoying to add as a dep
    # If space becomes a problem it's roughly ~2x better in TEXT_MODE
    s3.Object(BUCKET_NAME, log_object_path(full_name, job_id)).put(
        Body=gzip.compress(response.content),
        ContentType="text/plain",
        ContentEncoding="gzip",
        Metadata={"conclusion": conclusion or ""},
    )
    return True


def parse_event(event):
    """Validate the invoke payload, returning (full_name, conclusion, job_id).

    Raises ValueError on anything malformed. The caller is an async invoke, so a
    raised error is retried twice by Lambda and then lands in the DLQ, which is
    what we want for a payload we can't interpret.
    """
    if not isinstance(event, dict):
        raise ValueError(f"expected a JSON object, got {type(event).__name__}")

    full_name = event.get("repo")
    if not full_name or "/" not in full_name:
        raise ValueError(f"missing or malformed 'repo': {full_name!r}")

    try:
        job_id = int(event["job_id"])
    except (KeyError, TypeError, ValueError):
        raise ValueError(f"missing or non-numeric 'job_id': {event.get('job_id')!r}")

    return full_name, event.get("conclusion"), job_id


def lambda_handler(event, context):
    full_name, conclusion, job_id = parse_event(event)

    try:
        stored = download_log(full_name, conclusion, job_id)
    except requests.RequestException as err:
        # A GitHub blip is worth a Lambda retry, so let it propagate.
        print(f"ERROR downloading log for {full_name} job {job_id}: {err}")
        raise

    classified = classify_log(full_name, job_id) if stored else False

    return {
        "repo": full_name,
        "job_id": job_id,
        "stored": stored,
        "classified": classified,
    }
