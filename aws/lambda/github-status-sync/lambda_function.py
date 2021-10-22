import asyncio
import aiohttp  # type: ignore
import math
import os
import datetime
import re
import boto3  # type: ignore
import json
import io
import gzip
import os
from cryptography.hazmat.backends import default_backend
import jwt
import requests
import time
from typing import *


BUCKET = os.getenv("bucket", "ossci-job-status")
APP_ID = int(os.environ["app_id"])

# The private key needs to maintain its newlines, get it via
# $ cat key.pem | tr '\n' '|' | pbcopy
PRIVATE_KEY = os.environ["private_key"].replace("|", "\n")


def app_headers() -> Dict[str, str]:
    cert_bytes = PRIVATE_KEY.encode()
    private_key = default_backend().load_pem_private_key(cert_bytes, None)  # type: ignore

    time_since_epoch_in_seconds = int(time.time())

    payload = {
        # issued at time
        "iat": time_since_epoch_in_seconds,
        # JWT expiration time (10 minute maximum)
        "exp": time_since_epoch_in_seconds + (10 * 60),
        # GitHub App's identifier
        "iss": APP_ID,
    }

    actual_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    headers = {
        "Authorization": f"Bearer {actual_jwt}",
        "Accept": "application/vnd.github.machine-man-preview+json",
    }
    return headers


def jprint(obj: Any) -> None:
    print(json.dumps(obj, indent=2))


def installation_id(user: str) -> int:
    r_bytes = requests.get(
        "https://api.github.com/app/installations", headers=app_headers()
    )
    r = json.loads(r_bytes.content.decode())
    for item in r:
        if item["account"]["login"] == user:
            return int(item["id"])

    raise RuntimeError(f"User {user} not found in {r}")


def user_token(user: str) -> str:
    """
    Authorize this request with the GitHub app set by the 'app_id' and
    'private_key' environment variables.
    1. Get the installation ID for the user that has installed the app
    2. Request a new token for that user
    3. Return it so it can be used in future API requests
    """
    # Hardcode the installation to PyTorch so we can always get a valid ID key
    id = installation_id("pytorch")
    url = f"https://api.github.com/app/installations/{id}/access_tokens"
    r_bytes = requests.post(url, headers=app_headers())
    r = json.loads(r_bytes.content.decode())
    token = str(r["token"])
    return token


if "AWS_KEY_ID" in os.environ and "AWS_SECRET_KEY" in os.environ:
    # Use keys for local development
    session = boto3.Session(
        aws_access_key_id=os.environ.get("AWS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_KEY"),
    )
else:
    # In the Lambda, use permissions on the Lambda's role
    session = boto3.Session()
s3 = session.resource("s3")


def compress_query(query: str) -> str:
    query = query.replace("\n", "")
    query = re.sub("\s+", " ", query)
    return query


def head_commit_query(user: str, repo: str, branches: List[str]) -> str:
    """
    Fetch the head commit for a list of branches
    """

    def branch_part(branch: str, num: int) -> str:
        return f"""
        r{num}: repository(name: "{repo}", owner: "{user}") {{
            ref(qualifiedName:"refs/heads/{branch}") {{
            name
            target {{
                ... on Commit {{
                    oid
                }}        
            }}
        }}
        }}
        """

    parts = [branch_part(branch, i) for i, branch in enumerate(branches)]
    return "{" + "\n".join(parts) + "}"


def extract_gha(suites: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    jobs = []
    for suite in suites:
        suite = suite["node"]
        if suite["workflowRun"] is None:
            # If no jobs were triggered this will be empty
            continue
        workflow = suite["workflowRun"]["workflow"]["name"]
        for run in suite["checkRuns"]["nodes"]:
            conclusion = run["conclusion"]
            if conclusion is None:
                if run["status"].lower() == "queued":
                    conclusion = "queued"
                elif run["status"].lower() == "in_progress":
                    conclusion = "pending"
                else:
                    raise RuntimeError(f"unexpected run {run}")
            jobs.append(
                {
                    "name": f"{workflow} / {run['name']}",
                    "status": conclusion.lower(),
                    "url": run["detailsUrl"],
                }
            )

    return jobs


def extract_status(contexts: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    jobs = []
    for context in contexts:
        jobs.append(
            {
                "name": context["context"],
                "status": context["state"].lower(),
                "url": context["targetUrl"],
            }
        )

    return jobs


def extract_jobs(raw_commits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    commits = []

    for raw_commit in raw_commits:
        if raw_commit["status"] is None:
            # Will be none if no non-GHA jobs were triggered
            status = []
        else:
            status = extract_status(raw_commit["status"]["contexts"])
        gha = extract_gha(raw_commit["checkSuites"]["edges"])
        jobs = status + gha

        if raw_commit["author"]["user"] is None:
            author = raw_commit["author"]["name"]
        else:
            author = raw_commit["author"]["user"]["login"]
        commits.append(
            {
                "sha": raw_commit["oid"],
                "headline": raw_commit["messageHeadline"],
                "body": raw_commit["messageBody"],
                "author": author,
                "date": raw_commit["authoredDate"],
                "jobs": jobs,
            }
        )
    return commits


class BranchHandler:
    def __init__(
        self,
        gql: Any,
        user: str,
        repo: str,
        name: str,
        head: str,
        history_size: int,
        fetch_size: int,
    ):
        self.gql = gql
        self.user = user
        self.repo = repo
        self.name = name
        self.head = head
        self.fetch_size = fetch_size
        self.history_size = history_size

    def write_to_s3(self, data: Any) -> None:
        content = json.dumps(data, default=str)
        buf = io.BytesIO()
        gzipfile = gzip.GzipFile(fileobj=buf, mode="w")
        gzipfile.write(content.encode())
        gzipfile.close()
        bucket = s3.Bucket(BUCKET)
        prefix = f"v5/{self.user}/{self.repo}/{self.name.replace('/', '_')}.json"
        bucket.put_object(
            Key=prefix,
            Body=buf.getvalue(),
            ContentType="application/json",
            ContentEncoding="gzip",
            Expires="0",
        )
        print(f"Wrote {len(data)} commits from {self.name} to {prefix}")

    def query(self, offset: int) -> str:
        after = ""
        # The cursor for fetches are formatted like after: "<sha> <offset>", but
        # the first commit isn't included, so shift all the offsets and don't
        # use an "after" for the first batch
        if offset > 0:
            after = f', after: "{self.head} {offset - 1}"'

        return f"""
        {{
            repository(name: "{self.repo}", owner: "{self.user}") {{
                ref(qualifiedName:"refs/heads/{self.name}") {{
                name
                target {{
                    ... on Commit {{
                    history(first:{self.fetch_size}{after}) {{
                        nodes {{
                        oid
                        messageBody
                        messageHeadline
                        author {{
                            name
                            user {{
                                login
                            }}
                        }}
                        authoredDate
                        checkSuites(first:100) {{
                            edges {{
                            node {{
                                checkRuns(first:100) {{
                                    nodes {{
                                        name
                                        status
                                        conclusion
                                        detailsUrl
                                    }}
                                }}
                                workflowRun {{
                                    workflow {{
                                        name
                                    }}
                                }}
                            }}
                            }}
                        }}
                        status {{
                            contexts {{
                            context
                            state
                            targetUrl
                            }}
                        }}
                        }}
                    }}
                    }}
                }}
                }}
            }}
        }}
        """

    def check_response(self, gql_response: Any) -> None:
        # Just check that this path in the dict exists
        gql_response["data"]["repository"]["ref"]["target"]["history"]["nodes"]

    async def run(self) -> None:
        """
        Fetch history for the branch (in batches) and merge them all together
        """
        # GitHub's API errors out if you try to fetch too much data at once, so
        # split up the 100 commits into batches of 'self.fetch_size'
        fetches = math.ceil(self.history_size / self.fetch_size)

        async def fetch(i: int) -> Any:
            try:
                return await self.gql.query(
                    self.query(offset=self.fetch_size * i), verify=self.check_response
                )
            except Exception as e:
                print(
                    f"Error: {e}\nFailed to fetch {self.user}/{self.repo}/{self.name} on batch {i} / {fetches}"
                )
                return None

        coros = [fetch(i) for i in range(fetches)]
        result = await asyncio.gather(*coros)
        raw_commits = []

        print(f"Parsing results {self.name}")
        # Merge all the batches
        for r in result:
            if r is None:
                continue
            try:
                commits_batch = r["data"]["repository"]["ref"]["target"]["history"][
                    "nodes"
                ]
                raw_commits += commits_batch
            except Exception as e:
                # Errors here are expected if the branch has less than HISTORY_SIZE
                # commits (GitHub will just time out). There's no easy way to find
                # this number ahead of time and avoid errors, but if we had that
                # then we could delete this try-catch.
                print(f"Error: Didn't find history in commit batch: {e}\n{r}")

        # Pull out the data and format it
        commits = extract_jobs(raw_commits)

        print(f"Writing results for {self.name} to S3")

        # Store gzip'ed data to S3
        self.write_to_s3(commits)


class GraphQL:
    def __init__(self, session: aiohttp.ClientSession) -> None:
        self.session = session

    def log_rate_limit(self, headers: Any) -> None:
        remaining = headers.get("X-RateLimit-Remaining")
        used = headers.get("X-RateLimit-Used")
        total = headers.get("X-RateLimit-Limit")
        reset_timestamp = int(headers.get("X-RateLimit-Reset", 0))  # type: ignore
        reset = datetime.datetime.fromtimestamp(reset_timestamp).strftime(
            "%a, %d %b %Y %H:%M:%S"
        )

        print(
            f"[rate limit] Used {used}, {remaining} / {total} remaining, reset at {reset}"
        )

    async def query(
        self,
        query: str,
        verify: Optional[Callable[[Any], None]] = None,
        retries: int = 5,
    ) -> Any:
        """
        Run an authenticated GraphQL query
        """
        # Remove unnecessary white space
        query = compress_query(query)
        if retries <= 0:
            raise RuntimeError(f"Query {query[:100]} failed, no retries left")

        url = "https://api.github.com/graphql"
        try:
            async with self.session.post(url, json={"query": query}) as resp:
                self.log_rate_limit(resp.headers)
                r = await resp.json()
            if "data" not in r:
                raise RuntimeError(r)
            if verify is not None:
                verify(r)
            return r
        except Exception as e:
            print(
                f"Retrying query {query[:100]}, remaining attempts: {retries - 1}\n{e}"
            )
            return await self.query(query, verify=verify, retries=retries - 1)


async def main(
    user: str, repo: str, branches: List[str], history_size: int, fetch_size: int
) -> None:
    """
    Grab a list of all the head commits for each branch, then fetch all the jobs
    for the last 'history_size' commits on that branch
    """
    async with aiohttp.ClientSession(
        headers={
            "Authorization": "token {}".format(user_token(user)),
            "Accept": "application/vnd.github.machine-man-preview+json",
        }
    ) as aiosession:
        gql = GraphQL(aiosession)
        print(f"Querying branches: {branches}")
        heads = await gql.query(head_commit_query(user, repo, branches))
        handlers = []

        for head in heads["data"].values():
            sha = head["ref"]["target"]["oid"]
            branch = head["ref"]["name"]
            handlers.append(
                BranchHandler(gql, user, repo, branch, sha, history_size, fetch_size)
            )

        await asyncio.gather(*[h.run() for h in handlers])


def lambda_handler(event: Any, context: Any) -> None:
    """
    'event' here is the payload configured from EventBridge (or set manually
    via environment variables)
    """
    data: Dict[str, Any] = {
        "branches": None,
        "user": None,
        "repo": None,
        "history_size": None,
        "fetch_size": None,
    }

    for key in data.keys():
        if key in os.environ:
            data[key] = os.environ[key]
        else:
            data[key] = event[key]

    if any(x is None for x in data.values()):
        raise RuntimeError(
            "Data missing from configuration, it must be set as an environment "
            f"variable or as the input JSON payload in the Lambda event:\n{data}"
        )

    data["history_size"] = int(data["history_size"])
    data["fetch_size"] = int(data["fetch_size"])
    data["branches"] = data["branches"].split(",")

    # return
    asyncio.run(main(**data))


if os.getenv("DEBUG", "0") == "1":
    # For local development
    lambda_handler(
        {
            "branches": "release/1.10",
            "user": "pytorch",
            "repo": "pytorch",
            "history_size": 100,
            "fetch_size": 10,
        },
        None,
    )

