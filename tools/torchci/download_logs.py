import argparse
import glob
import multiprocessing as mp
import os
import zipfile
from pathlib import Path

import requests
from torchci.clickhouse import query_clickhouse


REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def get_s3():
    import boto3

    return boto3.resource("s3")


def unzip(from_file, to_folder):
    with zipfile.ZipFile(from_file, "r") as zip_ref:
        zip_ref.extractall(to_folder)


def download_log(id):
    "Given an id for a job, returns the log as a string"
    url = f"https://ossci-raw-job-status.s3.amazonaws.com/log/{id}"
    data = requests.get(url)
    if data.status_code != 200:
        return None
    return data.text


def download_log_to_file(id, file, name):
    t = download_log(id)
    if t is None:
        print(f"Failed to download log for {name} {id}")
        return
    with open(file, "w") as f:
        f.write(t)


def download_logs_to_dir(commit):
    "Given a commit sha, downloads all test logs for that commit to logs/<commit> folder"
    res = query_clickhouse(
        "select id, name from default.workflow_job final where head_sha = {commit: String} and name like '% / test%'",
        {"commit": commit},
    )

    folder = REPO_ROOT / "_logs" / "ci_logs" / commit
    os.makedirs(folder, exist_ok=True)

    pool = mp.Pool(10)
    for i in res:
        pool.apply_async(
            download_log_to_file,
            (i["id"], f"{folder}/{i['name'].replace('/', '_')}", i["name"]),
        )
    pool.close()
    pool.join()
    return folder


def download_artifacts_from_sha(commit, repo):
    s3 = get_s3()
    bucket = s3.Bucket("gha-artifacts")
    folder = REPO_ROOT / "_logs" / "artifacts" / commit
    workflow_ids = query_clickhouse(
        "select id from default.workflow_run final where head_sha = {commit: String}",
        {"commit": commit},
    )

    zipped_path = folder / "zipped"
    os.makedirs(zipped_path, exist_ok=True)

    for row in workflow_ids:
        workflow_id = row["id"]
        for obj in bucket.objects.filter(Prefix=f"pytorch/{repo}/{workflow_id}"):
            if "test-reports" not in obj.key:
                continue
            s3.Object(bucket.name, obj.key).download_file(
                str(zipped_path / obj.key.replace("/", "_"))
            )

    unzipped_path = REPO_ROOT / "_logs" / "artifacts" / commit / "unzipped"
    os.makedirs(unzipped_path, exist_ok=True)

    for file in glob.glob(str(zipped_path) + "/**/*.zip", recursive=True):
        unzip(file, unzipped_path / Path(file).stem)


def get_parser():
    parser = argparse.ArgumentParser(
        description="Download TEST logs for a particular commit"
    )
    parser.add_argument("commit", type=str)
    parser.add_argument("--artifacts", action="store_true")
    parser.add_argument("--repo", type=str, default="pytorch")
    return parser


if __name__ == "__main__":
    args = get_parser().parse_args()
    if args.artifacts:
        download_artifacts_from_sha(args.commit, args.repo)
        print(f"Saved to {REPO_ROOT / '_logs' / 'artifacts' / args.commit}")
    else:
        download_logs_to_dir(args.commit)
        print(f"Saved to {REPO_ROOT / '_logs' / 'ci_logs' / args.commit}")
