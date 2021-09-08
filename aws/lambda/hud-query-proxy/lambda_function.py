"""
Query the database backing metrics.pytorch.org for recent commits and statuses,
then push these to S3 at ossci-job-status/single/{branch}.tar.gz

This fetches the 100 most recent commits for the branch (GitHub doesn't send
push events for stacks of commits so we'd need to recover those manually), then
gets their GitHub Actions job statuses and status events (CircleCI, CodeCov,
Jenkins, etc.)

Use environment variables 'num_commits' and 'branches' to configure the lambda
"""
import os
import re
import sys
import gzip
import json
import io
import boto3

from typing import *

import asyncio
import aiomysql


def eprint(*args):
    print(*args, file=sys.stderr)


async def run_query(query: str, params: List[str] = None) -> Dict[str, Any]:
    eprint(f"Executing '{query}' with params: {params}")

    my_con = await aiomysql.connect(
        host=os.environ["db_host"],
        port=3306,
        user=os.environ["db_user"],
        password=os.environ["db_password"],
        db="pytorch",
        loop=asyncio.get_event_loop(),
    )
    async with my_con.cursor(aiomysql.DictCursor) as cur:
        await cur.execute(query, params)
        return await cur.fetchall()


PR_RE = re.compile(r"(.*)\(#([0-9]+)\)$")
NUM_COMMITS = int(os.getenv("num_commits", 100))
BRANCHES = os.getenv("branches", "master,release/1.9,nightly").split(",")


async def get_commits(branch):
    results = await run_query(
        f"""
        select head_commit_timestamp,
            head_commit_id,
            head_commit_author_username,
            head_commit_message
        from push_event
        where ref = %s
        order by head_commit_timestamp desc
        limit %s;
        """,
        (branch, NUM_COMMITS),
    )
    for row in results:
        message = row["head_commit_message"]
        title = message.split("\n")[0].strip()
        del row["head_commit_message"]
        match = PR_RE.search(title)
        if match:
            groups = match.groups()
            if len(groups) == 2:
                title = groups[0].strip()
                pr = groups[1]
            else:
                pr = "<unknown>"
        else:
            pr = "<unknown>"

        row["head_commit_title"] = title
        row["pr"] = pr
        row["jobs"] = []

    return results


async def gha_jobs_for_shas(shas: List[str]):
    placeholders = ["%s"] * len(shas)
    query = f"""
        select workflow_run.name as "workflow",
            workflow_job.name,
            workflow_job.head_sha,
            workflow_job.status,
            workflow_job.started_at,
            workflow_job.id,
            workflow_job.conclusion
        from workflow_job
            inner join workflow_run on workflow_job.run_id = workflow_run.id
        where workflow_job.head_sha in ({', '.join(placeholders)});
    """
    return await run_query(query, shas)


async def circleci_jobs_for_shas(shas: List[str]):
    placeholders = ["%s"] * len(shas)
    query = f"""
        select context,
            sha,
            updated_at,
            target_url,
            state
        from status_event
        where sha in ({', '.join(placeholders)});
    """
    return await run_query(query, shas)


def deduplicate_jobs(commit: Dict[str, str]):
    deduplicated_jobs = {}
    for job in commit["jobs"]:
        old_entry = deduplicated_jobs.get(job["name"])
        if old_entry is not None:
            if job["time"] > old_entry["time"]:
                deduplicated_jobs[job["name"]] = job
        else:
            deduplicated_jobs[job["name"]] = job

    commit["jobs"] = deduplicated_jobs


def compact_data(commits: List[Dict[str, str]]) -> str:
    # There could be re-runs, get rid of them and only keep the latest one
    for commit in commits.values():
        deduplicate_jobs(commit)

    job_names = set()
    for commit in commits.values():
        for job in commit["jobs"].values():
            job_names.add(job["name"])

    for commit in commits.values():
        full_status = {}
        for name in job_names:
            job = commit["jobs"].get(name)
            if job is None:
                full_status[name] = None
            else:
                full_status[name] = [job["status"], job["url"]]
        commit["jobs"] = full_status


async def main(branch):
    commits = await get_commits(f"refs/heads/{branch}")
    commits = {commit["head_commit_id"]: commit for commit in commits}
    shas = list(commits.keys())

    async def add_gha():
        gha = await gha_jobs_for_shas(shas)
        for job in gha:
            status = "<unknown>"
            if job["status"] != "completed":
                status = "pending"
            else:
                status = job["conclusion"]
            commits[job["head_sha"]]["jobs"].append(
                {
                    "name": f"{job['workflow']} / {job['name']}",
                    "time": job["started_at"],
                    "url": f"https://github.com/pytorch/pytorch/runs/{job['id']}?check_suite_focus=true",
                    "status": status,
                }
            )

    async def add_circleci():
        circleci = await circleci_jobs_for_shas(shas)
        for job in circleci:
            commits[job["sha"]]["jobs"].append(
                {
                    "name": job["context"],
                    "time": job["updated_at"],
                    "url": job["target_url"],
                    "status": job["state"],
                }
            )

    await asyncio.gather(add_gha(), add_circleci())

    compact_data(commits)

    return [commit for commit in commits.values()]


def update_branch(branch):
    data = asyncio.get_event_loop().run_until_complete(main(branch))

    # Default response is huge due to large job names, use gzip to make them
    # small
    content = json.dumps(data, default=str)
    buf = io.BytesIO()
    gzipfile = gzip.GzipFile(fileobj=buf, mode="w")
    gzipfile.write(content.encode())
    gzipfile.close()

    session = boto3.Session(
        aws_access_key_id=os.environ["aws_key_id"],
        aws_secret_access_key=os.environ["aws_access_key"],
    )
    s3 = session.resource("s3")

    bucket = s3.Bucket("ossci-job-status")
    bucket.put_object(
        Key=f"single/{branch.replace('/', '_')}.json.gz",
        Body=buf.getvalue(),
        ContentType="application/json",
        ContentEncoding="gzip",
    )
    return "ok"


def lambda_handler(events, context):
    exception = None
    results = {}
    for branch in BRANCHES:
        branch = branch.strip()
        results[branch] = "failed"
        try:
            results[branch] = update_branch(branch)
        except Exception as e:
            exception = e

    if exception is not None:
        raise exception
    return json.dumps(results, indent=2)


print(json.dumps(lambda_handler(None, None), indent=2, default=str))
