import multiprocessing as mp
import os
import requests
from torchci.rockset_utils import query_rockset
from pathlib import Path
import argparse

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

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
    res = query_rockset(
        f"select id, name from workflow_job where head_sha = '{commit}' and name like '% / test%'"
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

def get_parser():
    parser = argparse.ArgumentParser(description="Download TEST logs for a particular commit")
    parser.add_argument("commit", type=str)
    return parser

if __name__ == "__main__":
    args = get_parser().parse_args()
    download_logs_to_dir(args.commit)
    print(f"Saved to {REPO_ROOT / '_logs' / 'ci_logs' / args.commit}")
