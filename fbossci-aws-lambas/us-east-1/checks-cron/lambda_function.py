"""
This pings repos/pytorch/pytorch/actions/runs and gathers the most recent jobs
until it sees that everything is complete. It then stores the current count of
all types of jobs ('in_progress' and 'queued' are the relevant parts).
"""
import aiohttp
import asyncio
import datetime
import json
import os
import collections
import aiobotocore
import collections
import json


config = {"quiet": False, "github_oauth": os.environ["gh_pat"]}


async def github(method, path, payload=None, note="", **kwargs):
    if payload is None:
        payload = {}
    headers = {
        "Content-Type": "application/json",
        "Host": "api.github.com",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if config["github_oauth"] is not None:
        headers["Authorization"] = "token " + config["github_oauth"]
    url = "https://api.github.com/" + path
    print(method, url, f"({note})")
    async with aiohttp.ClientSession() as session:
        r = await session.get(url, headers=headers, **kwargs)
        return await r.json()


async def fetch_workflow_page(num):
    return await github(
        "get",
        "repos/pytorch/pytorch/actions/runs",
        params={"per_page": 100, "page": num},
    )


def page_in_progress(new_statuses):
    return "queued" in new_statuses or "in_progress" in new_statuses


async def get_page_batch(start: int, batch_size: int):
    coros = []
    for i in range(start, start + batch_size):
        coros.append(
            github(
                "get",
                "repos/pytorch/pytorch/actions/runs",
                params={"per_page": 100, "page": i},
                note=f"fetching page {i}",
            )
        )

    return await asyncio.gather(*coros)


def should_check_github(stats):
    if len(stats) == 0:
        return True

    delta = datetime.datetime.now() - datetime.datetime.fromtimestamp(stats[-1]["last_updated"])
    return delta > datetime.timedelta(minutes=5)



async def get_gha_statuses(max_pages=30, batch_size=10):
    all_statuses = collections.defaultdict(lambda: 0)

    max_pages_past = 10
    pages_past = max_pages_past

    i = 1
    should_quit = False
    while not should_quit and i < max_pages:
        batch = await get_page_batch(i, batch_size)
        i += batch_size
        for page in batch:
            new_statuses = collections.defaultdict(lambda: 0)
            for run in page["workflow_runs"]:
                all_statuses[run["status"]] += 1
                new_statuses[run["status"]] += 1

            if not page_in_progress(new_statuses):
                pages_past -= 1
            else:
                pages_past = max_pages_past

            if pages_past == 0:
                should_quit = True
            print(new_statuses)

    return {"last_updated": datetime.datetime.now().timestamp(), **all_statuses}


MAX_LEN = 1000

async def main():
    bucket_name = "ossci-checks-status"
    session = aiobotocore.get_session()
    async with session.create_client(
        "s3",
        region_name="us-east-1",
        aws_secret_access_key=os.environ["aws_secret"],
        aws_access_key_id=os.environ["aws_key"],
    ) as client:
        content = await client.get_object(
            Bucket=bucket_name, Key="status.json"
        )
        content = await content["Body"].read()
        all_stats = json.loads(content.decode())

        if not should_check_github(all_stats):
            print("Ran too early, not doing anything")
            return

        if len(all_stats) >= MAX_LEN:
            # Chop off old data
            all_stats = all_stats[:MAX_LEN]

        all_stats.insert(0, await get_gha_statuses())
        print("writing", all_stats)
        await client.put_object(
            Bucket=bucket_name, Key="status.json", Body=json.dumps(all_stats)
        )


def lambda_handler(event, context):
    print("handling lambda")
    loop = asyncio.get_event_loop()
    loop.run_until_complete(main())
    return {"statusCode": 200, "body": "update processed"}
