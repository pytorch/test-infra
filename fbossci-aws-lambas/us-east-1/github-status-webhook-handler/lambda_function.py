# Copyright (c) 2019-present, Facebook, Inc.

import json
from typing import Any, Dict, List
from urllib.request import Request, urlopen

import boto3  # type: ignore
import botocore # type: ignore

s3 = boto3.resource('s3')

bucket_name = 'ossci-job-status'


def s3_get_json(bucket, path, empty_obj):
    try:
        return json.loads(s3.Object(bucket, path).get()['Body'].read().decode('utf-8'))
    except botocore.exceptions.ClientError as e:
        return empty_obj


def json_dumps(obj):
    return json.dumps(obj, sort_keys=True, indent=4, separators=(',', ': '))


def get_branch_name(ref: str) -> str:
    if isinstance(ref, str) and ref.startswith('refs/heads/'):
        return ref[len('refs/heads/'):]
    return ''


def is_branch_important(branch: str) -> bool:
    return branch in ['master', 'nightly', 'viable/strict'] or branch.startswith('release/')


def handle_commits(commits, ref) -> None:
    branch_name = get_branch_name(ref)
    if not is_branch_important(branch_name):
        print(f"Discarding unimportant push event to {branch_name}")
        return
    print(f"Handling {branch_name} push event")
    status_index = s3_get_json(bucket_name, f'{branch_name}/index.json', [])
    status_index.extend(commits)
    status_index = status_index[-100:]  # only keep most recent 100
    s3.Object(bucket_name, f'{branch_name}/index.json').put(Body=json_dumps(status_index))
    print(f"Updated commit index for {branch_name}")


# these next two functions are from here:
# https://gist.github.com/malfet/d34d3ef57c535696384246bbc79775c5#file-gh-get-milestone-issues-py-L159-L175

def fetch_json(url: str, params: Dict[str, Any] = {}) -> List[Dict[str, Any]]:
    headers = {'Accept': 'application/vnd.github.v3+json'}
    if len(params) >0:
        url += '?' + '&'.join(f"{name}={val}" for name, val in params.items())
    with urlopen(Request(url, headers=headers)) as data:
        return json.load(data)


def fetch_multipage_json(url: str, params: Dict[str, Any] = dict()) -> List[Dict[str, Any]]:
    assert "page" not in params
    page_idx, rc, prev_len, params = 1, [], -1, params.copy()
    while len(rc) > prev_len:
        prev_len = len(rc)
        params["page"] = page_idx
        page_idx += 1
        rc += fetch_json(url, params)
    return rc


def get_workflow_name(job_id):
    url_prefix = 'https://api.github.com/repos/pytorch/pytorch/actions/'
    run_id = json.loads(fetch_multipage_json(f'{url_prefix}jobs/{job_id}'))['run_id']
    return json.loads(fetch_multipage_json(f'{url_prefix}runs/{run_id}'))['name']


# as of 2021-04-29, this lambda is triggered by the following GitHub
# webhook events on the pytorch/pytorch repo, and by nothing else:
# - check_run
# - push
# - status
#
# see this page for information on what the payloads look like:
# https://docs.github.com/en/developers/webhooks-and-events/webhook-events-and-payloads
def lambda_handler(event, context):
    body = json.loads(event["body"])

    # push
    if 'commits' in body:
        handle_commits(body['commits'], body['ref'])
        return

    # check_run
    if "check_run" in body:
        commitId = body["check_run"]["head_sha"]
        build_url = body["check_run"]["details_url"]
        workflow_name = get_workflow_name(body["check_run"]["id"])
        if workflow_name:
            job_name = f'{workflow_name} / {body["check_run"]["name"]}'
        else:
            job_name = body["check_run"]["name"]
        status = body["check_run"]["conclusion"]
        committer = body["sender"]["login"]
        # For some reason actions aren't facebook-github-bot..
        is_master = body["check_run"]["check_suite"]["head_branch"] == "master"

    # status
    else:
        commitId = body["sha"]
        build_url = body["target_url"]
        job_name = body["context"]
        status = body["state"]
        # Detect CircleCI cancelled jobs
        description = body.get("description")
        if status == 'error' and description == "Your CircleCI tests were canceled":
            status = 'cancelled'
        try:
            committer = body["commit"]["committer"]["login"]
        except TypeError:
            print(json.dumps(body))
            committer = "(unknown)"
        # master commits are always made by facebook-github-bot
        is_master = committer == "facebook-github-bot"

    print("commitId: ", commitId)
    print("build_url: ", build_url)
    print("job_name: ", job_name)
    print("status: ", status)
    print("committer: ", committer)
    commit_source = ''
    if is_master:
        print("Status update is from master commit.")
        commit_source = 'master'
    else:
        print("Status update is from PR commit.")
        commit_source = 'pr'
    status_file_name = commitId+'.json'
    job_statuses = s3_get_json(bucket_name, f'{commit_source}/{status_file_name}', {})
    combined_job_statuses = s3_get_json(bucket_name, f'combined/{status_file_name}', {})
    job_statuses[job_name] = {'status': status, 'build_url': build_url}
    combined_job_statuses[job_name] = {'status': status, 'build_url': build_url}
    s3.Object(bucket_name, f'{commit_source}/{status_file_name}').put(Body=json_dumps(job_statuses))
    s3.Object(bucket_name, f'combined/{status_file_name}').put(Body=json_dumps(combined_job_statuses))
    print("Status update is saved to ossci-job-status bucket.")
    return {"statusCode": 200, "body": "update processed"}
