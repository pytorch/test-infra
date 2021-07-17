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


from typing import Dict, Any, List


GITHUB_OAUTH = os.environ["gh_pat"]
WEBHOOK_SECRET = os.environ["gh_secret"]
ELASTICSEARCH_URL = os.environ["es_url"]


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

    return output


async def get_suite(check_run_id: str) -> Dict[str, Any]:
    query = textwrap.dedent(
        f"""
        {{
            node(id:"{check_run_id}") {{
                ... on CheckRun {{
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
                        }}
                    }}
                }}
            }}
        }}
    """
    )
    response = await graphql(query)
    return response["data"]["node"]["checkSuite"]


def find_folders(zip: zipfile.ZipFile) -> List[zipfile.ZipInfo]:
    folders = []
    for file in zip.filelist:
        if file.filename.endswith("/") and file.filename.count("/") == 1:
            folders.append(file)
    return folders


def find_files_in_folder(zip: zipfile.ZipFile, folder: str) -> List[zipfile.ZipInfo]:
    files = []
    for file in zip.filelist:
        if file.filename.startswith(folder) and file.filename != folder:
            files.append(file)

    return files


def keep(path: Path) -> bool:
    for ignore in UNINTERSTING_JOBS:
        if str(path).endswith(ignore):
            return False
    return True


def get_relevant_contents(zip_bytes_io) -> List[Dict[str, str]]:
    try:
        zip_file = zipfile.ZipFile(zip_bytes_io)
    except zipfile.BadZipFile:
        return None
    documents = []

    for folder in find_folders(zip_file):
        files = find_files_in_folder(zip_file, folder.filename)
        for file in files:
            path = Path(file.filename)
            content = zip_file.read(file).decode("utf-8")
            if keep(path):
                documents.append({"path": str(path), "text": clean_log(content)})

    return documents


class Log(Document):
    hash = Keyword()
    path = Text(analyzer="standard")
    commit_subject = Text(analyzer="standard")
    text = Text(analyzer="standard", term_vector="with_positions_offsets")
    pr_number = Integer()
    date = Date()
    pr_title = Text(analyzer="standard")

    class Index:
        name = "gha-logs"
        settings = {
            "number_of_shards": 2,
        }


async def get_documents(check_run_node_id: str) -> List[Log]:
    """
    For a given check run's node ID (a unique ID GitHub assigns every object),
    return back a list of logs + extra metadata
    """
    extra_info = {
        "hash": "",
        "commit_subject": "",
        "pr_title": "",
        "pr_number": 0,
        "date": datetime.datetime.now(),
    }
    if os.getenv("DEBUG", "0") == "0":
        # Get the checkSuite from the check's ID
        print("Fetching suite with check run node ID", check_run_node_id)
        suite = await get_suite(check_run_node_id)
        suite_id = suite["databaseId"]
        log_url = (
            f"https://api.github.com/repos/pytorch/pytorch/actions/runs/{suite_id}/logs"
        )

        # Gather extra labels
        extra_info["hash"] = suite["commit"]["oid"]
        extra_info["commit_subject"] = suite["commit"]["messageHeadline"]

        prs = suite["commit"]["associatedPullRequests"]["nodes"]
        if len(prs) > 0:
            extra_info["pr_title"] = prs[0]["title"]
            extra_info["pr_number"] = int(prs[0]["number"])

        # Get the log contents per file (with filtering for uninteresting jobs
        # and inter-log filtering for uninteresting lines, mostly just to save
        # space)
        print("Fetching logs from", log_url)
        r = requests.get(log_url, headers=headers())
        documents = get_relevant_contents(io.BytesIO(r.content))
        if documents is None:
            print("not a zip:", r.content)
    else:
        # Debug mode, use an on-disk zip file
        with open("log/out.zip", "rb") as f:
            documents = get_relevant_contents(f)

    if documents is None:
        return None

    print("Appending documents")
    es_documents = []
    for document in documents:
        document.update(extra_info)
        es_documents.append(Log(**document))

    if len(documents) > 0:
        keys = list(documents[0].keys())
        print("Log document keys", keys)

    return es_documents


async def main(event):
    connections.create_connection(hosts=[ELASTICSEARCH_URL])
    Log.init()
    action = event.get("action", "")
    if action != "completed":
        return {"statusCode": 200, "body": f"action not completed: {action}"}

    node_id = event.get("check_run", {}).get("node_id", None)
    if node_id is None:
        return {"statusCode": 200, "body": "no node ID"}

    documents = await get_documents(node_id)
    if documents is None:
        return {"statusCode": 200, "body": "file not a zip"}
    print(f"Saving {len(documents)} documents")
    for document in documents:
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

