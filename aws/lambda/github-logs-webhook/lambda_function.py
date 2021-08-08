import textwrap
import hashlib
import aiohttp
import hmac
import asyncio
from urllib.parse import unquote
import json
import zipfile
import io
import os
import json
from pathlib import Path
import requests
import datetime
from elasticsearch_dsl import Document, Date, Integer, Keyword, Text, connections


import re


from typing import Dict, Any, List


GITHUB_OAUTH = os.environ["gh_pat"]
WEBHOOK_SECRET = os.environ["gh_secret"]
ELASTICSEARCH_URL = os.environ["es_url"]

# 7-bit C1 ANSI sequences
ANSI_ESCAPE_RE = re.compile(r'''
    \x1B  # ESC
    (?:   # 7-bit C1 Fe (except CSI)
        [@-Z\\-_]
    |     # or [ for CSI, followed by a control sequence
        \[
        [0-?]*  # Parameter bytes
        [ -/]*  # Intermediate bytes
        [@-~]   # Final byte
    )
''', re.VERBOSE)

DONT_CARES_START = [
    "Removing ",
    "Entering ",
    "remote: Counting objects ",
    "Counting objects",
    "Compressing objects",
    "Synchronizing submodule url",
    "Processing ",
    "Entering ",
    "geninfo: WARNING: could not open /var/",
    "http.https://github.com/.extraheader",
    "(the message is displayed only once per source file)",
    "geninfo: WARNING: some exclusion markers may be ignored",
    "deleted: ",
    "adding '",
    "copying ",
    "creating ",
    "copying ",
    "  adding: ",
    " extracting: ",
    "  inflating: ",
    "   creating: ",
]

DONT_CARES_ANYWHERE = [
    ": Pulling fs layer",
    ": Waiting",
    ": Verifying Checksum",
    ": Download complete",
    ": Pull complete",
    "source file is newer than notes file",
    "source file is newer than notes file",
]

UNINTERSTING_JOBS = [
    "_Archive artifacts into zip.txt",
    "_Checkout PyTorch.txt",
    "_Chown workspace.txt",
    "_Post Checkout PyTorch.txt",
]


def headers():
    return {"Authorization": f"token {GITHUB_OAUTH}"}


async def graphql(query: str) -> Dict[str, Any]:
    url = "https://api.github.com/graphql"
    data = {
        "query": query,
        "variables": {},
    }
    async with aiohttp.ClientSession() as session:
        r = await session.post(url, data=json.dumps(data), headers=headers())
        return await r.json()


def keep_line(line):
    for dc in DONT_CARES_START:
        if "Z " + dc in line:
            return False

    for dc in DONT_CARES_ANYWHERE:
        if dc in line:
            return False
    return True


def clean_log(content: str) -> str:
    """
    Remove uninteresting lines from a log
    """
    output = ""
    for line in content.split("\n"):
        if keep_line(line):
            output += line

    return ANSI_ESCAPE_RE.sub('', output)


async def get_check_run(check_run_id: str) -> Dict[str, Any]:
    query = textwrap.dedent(
        f"""
        {{
            node(id:"{check_run_id}") {{
                ... on CheckRun {{
                    name
                    url
                    conclusion
                    checkSuite {{
                        databaseId
                        commit {{
                            oid
                            messageHeadline
                            associatedPullRequests(first:1) {{
                                nodes {{
                                    number
                                    title
                                }}
                            }}
                        }}
                        workflowRun {{
                            databaseId
                            workflow {{
                                name
                            }}
                        }}
                    }}
                }}
            }}
        }}
    """
    )
    response = await graphql(query)
    return response["data"]["node"]


class Log(Document):
    hash = Keyword()
    workflow = Keyword()
    job = Keyword()
    commit_subject = Keyword()
    text = Text(analyzer="standard", term_vector="with_positions_offsets")
    pr_number = Integer()
    pr_title = Keyword()
    conclusion = Keyword()
    date = Date()

    class Index:
        name = "github-logs"
        settings = {
            "number_of_shards": 2,
        }


async def get_document(check_run_node_id: str) -> Log:
    """
    For a given check run's node ID (a unique ID GitHub assigns every object),
    return back a list of logs + extra metadata
    """
    info = {
        "hash": "",
        "commit_subject": "",
        "pr_title": "",
        "pr_number": 0,
        "date": datetime.datetime.now(),
    }

    # Get the checkSuite from the check's ID
    print("Fetching suite with check run node ID", check_run_node_id)
    run = await get_check_run(check_run_node_id)
    if run is None:
        print("Couldn't find check run")
        return []
    suite = run["checkSuite"]
    run_id = run["url"].split("/")[-1]
    log_url = (
        f"https://api.github.com/repos/pytorch/pytorch/actions/jobs/{run_id}/logs"
    )

    # Gather extra labels
    info["workflow"] = suite["workflowRun"]["workflow"]["name"]
    info["job"] = run["name"]
    info["conclusion"] = run["conclusion"]
    info["hash"] = suite["commit"]["oid"]
    info["commit_subject"] = suite["commit"]["messageHeadline"]

    # Find the PR the commit is attached to
    prs = suite["commit"]["associatedPullRequests"]["nodes"]
    if len(prs) > 0:
        info["pr_title"] = prs[0]["title"]
        info["pr_number"] = int(prs[0]["number"])

    # Download the logs as plaintext
    print("Fetching logs from", log_url)
    r = requests.get(log_url, headers=headers())
    info["text"] = clean_log(r.content.decode("utf-8"))

    # Check that we set all the keys we need
    if list(sorted(info.keys())) != list(sorted([x[0] for x in Log._ObjectBase__list_fields()])):
        raise RuntimeError("Missing keys for Log")


    return Log(**info)


async def main(event):
    connections.create_connection(hosts=[ELASTICSEARCH_URL])
    Log.init()
    action = event.get("action", "")
    if action != "completed":
        return {"statusCode": 200, "body": f"action not completed: {action}"}

    node_id = event.get("check_run", {}).get("node_id", None)
    if node_id is None:
        return {"statusCode": 200, "body": "no node ID"}

    document = await get_document(node_id)
    print(f"Saving document")
    document.save()

    return {"statusCode": 200, "body": "wrote successfully"}


def check_hash(payload, expected):
    signature = hmac.new(
        WEBHOOK_SECRET.encode("utf-8"), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


def lambda_handler(event, context):
    expected = event["headers"].get("X-Hub-Signature-256", "").split("=")[1]
    payload = event["body"].encode("utf-8")

    if check_hash(payload, expected):
        body = unquote(event["body"])
        body = body[len("payload="):]
        result = asyncio.run(main(json.loads(body)))
    else:
        result = {"statusCode": 403, "body": "Forbidden"}

    print("Result:", result)
    return result


# intput = {
#     "action": "completed",
#     "check_run": {
#         "node_id": "MDg6Q2hlY2tSdW4zMTY2Njc3MTkz",
#     }
# }

# asyncio.run(main(intput))