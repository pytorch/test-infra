#!/usr/bin/env python3
# Update pending GH Runs/CircleCI jobs in HUD
# Copyright (c) 2021-present, Facebook, Inc.
import boto3
import botocore
import json
import os
import re

from typing import Any, Dict, List, Optional, Union
from urllib.request import urlopen, Request
from urllib.error import HTTPError
from datetime import datetime, timedelta

s3 = boto3.resource('s3')
bucket_name = 'ossci-job-status'


def s3_get_json(bucket, path, empty_obj):
    try:
        return json.loads(s3.Object(bucket, path).get()['Body'].read().decode('utf-8'))
    except botocore.exceptions.ClientError:
        return empty_obj


def json_dumps(obj):
    return json.dumps(obj, sort_keys=True, indent=4, separators=(',', ': '))


def gh_fetch_json(url: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    headers = {'Accept': 'application/vnd.github.v3+json'}
    token = os.environ.get("GITHUB_TOKEN")
    if token is not None and url.startswith('https://api.github.com/'):
        headers['Authorization'] = f'token {token}'
    if params is not None and len(params) > 0:
        url += '?' + '&'.join(f"{name}={val}" for name, val in params.items())
    try:
        with urlopen(Request(url, headers=headers)) as data:
            return json.load(data)
    except HTTPError as err:
        if err.code == 403 and all(key in err.headers for key in ['X-RateLimit-Limit', 'X-RateLimit-Used']):
            print(f"Rate limit exceeded: {err.headers['X-RateLimit-Used']}/{err.headers['X-RateLimit-Limit']}")
        raise


def get_circleci_token() -> str:
    token_file_path = os.path.join(os.getenv('HOME'), '.circleci_token')
    token = os.getenv('CIRCLECI_TOKEN')
    if token is not None:
        return token
    if not os.path.exists(token_file_path):
        return None
    with open(token_file_path) as f:
        return f.read().strip()


def circleci_fetch_json(url: str) -> Union[Dict[str, Any], List[Dict[str, Any]]]:
    token = get_circleci_token()
    headers = {'Accept': 'application/json'}
    if token is not None:
        headers['Circle-Token'] = token
    with urlopen(Request(url, headers=headers)) as data:
        return json.load(data)


def circleci_get_job_status(org: str, project: str, job_id: int) -> Dict[str, Any]:
    rc = circleci_fetch_json(f"https://circleci.com/api/v2/project/gh/{org}/{project}/job/{job_id}")
    assert isinstance(rc, dict)
    return rc


def gh_fetch_multipage_json(url: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    if params is None:
        params = {}
    assert "page" not in params
    page_idx, rc, prev_len, params = 1, [], -1, params.copy()
    while len(rc) > prev_len:
        prev_len = len(rc)
        params["page"] = page_idx
        page_idx += 1
        page_json = gh_fetch_json(url, params)
        rc += page_json
    return rc


def gh_get_ref_statuses(org: str, project: str, ref: str) -> Dict[str, Any]:
    url = f'https://api.github.com/repos/{org}/{project}/commits/{ref}/status'
    params = {"page": 1, "per_page": 100}
    nrc = rc = gh_fetch_json(url, params)
    while "statuses" in nrc and len(nrc["statuses"]) == 100:
        params["page"] += 1
        nrc = gh_fetch_json(url, params)
        if "statuses" in nrc:
            rc["statuses"] += nrc["statuses"]
    return rc

def gh_get_runs_status(org: str, project: str, run_id: str) -> List[Dict[str, Any]]:
    url = f'https://api.github.com/repos/{org}/{project}/check-runs/{run_id}'
    return gh_fetch_json(url)


def map_circle_status(status: str) -> str:
    if status == "running":
        return "pending"
    if status == "infrastructure_fail":
        return "failure"
    return status


def map_ghrun_status(status: str) -> str:
    if status == "completed":
        return "success"
    return status


def update_pending(branch: str = "master") -> None:
    commit_index = s3_get_json(bucket_name, f'{branch}/index.json', [])
    for idx, item in enumerate(commit_index):
        commit_id = item['id']
        title = item['message'].split("\n")[0]
        timestamp = datetime.fromisoformat(item['timestamp']).replace(tzinfo=None)
        if datetime.utcnow() - timestamp < timedelta(hours=5):
            print(f"[{idx}/{len(commit_index)}] {title} ( {commit_id} ) is skipped as it was merged less than 5 hours ago")
            continue
        has_pending, has_updates = False, False
        job_statuses = s3_get_json(bucket_name, f'{branch}/{commit_id}.json', {})
        for (name, value) in job_statuses.items():
            status = value['status']
            build_url = value['build_url']
            if status not in ['success', 'skipped', 'error', 'failure']:
                circle_match = re.match("https://circleci.com/gh/pytorch/pytorch/(\\d+)\\?", build_url)
                ghrun_match = re.match("https://github.com/pytorch/pytorch/runs/(\\d+)", build_url)
                if circle_match is not None:
                    job_id = int(circle_match.group(1))
                    job_status = circleci_get_job_status("pytorch", "pytorch", job_id)
                    circle_status = map_circle_status(job_status['status'])
                    if status != circle_status:
                        job_statuses[name]['status'] = circle_status
                        has_updates = True
                        continue
                if ghrun_match is not None:
                    run_id = int(ghrun_match.group(1))
                    check_status = gh_get_runs_status("pytorch", "pytorch", run_id)
                    ghrun_status = map_ghrun_status(check_status['status'])
                    if status != ghrun_status:
                        job_statuses[name]['status'] = ghrun_status
                        has_updates = True
                        continue
                has_pending = True
        if has_pending:
            print(f"[{idx}/{len(commit_index)}] {title} ( {commit_id} ) has pending statuses")
        if has_updates:
            print(f"[{idx}/{len(commit_index)}] {title} ( {commit_id} ) has updates")
            s3.Object(bucket_name, f'{branch}/{commit_id}.json').put(Body=json_dumps(job_statuses))


if __name__ == '__main__':
    update_pending()
