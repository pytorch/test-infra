"""
This script checks if a file on s3 doesn't exist or matches the local file.  If
this script returns a non zero exit code, it means that the file you are trying
to upload will overwrite an existing file on s3.  If the s3 path is used in
lintrunner on pytorch/pytorch, this will break `lintrunner init`.  If this
returns with exit code 0, then it is safe to upload to s3 for usage with
lintrunner in pytorch/pytorch.  If you upload a new file, remember to add the
s3 path and hash to the lintrunner s3 init config:
https://github.com/pytorch/pytorch/blob/915625307eeda338fef00c984e223c5774c00a2b/tools/linter/adapters/s3_init_config.json#L1
"""

import argparse
import hashlib
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def download_s3_file(s3_key):
    url = f"https://oss-clang-format.s3.us-east-2.amazonaws.com/{s3_key}"
    req = Request(url)
    try:
        with urlopen(req) as response:
            # File exists, return the contents
            return response.read()
    except HTTPError as e:
        if "The specified key does not exist" in e.read().decode():
            # Acceptable error, file can be uploaded safely without overwriting
            print(f"Cannot find the file on s3")
            return
        raise


def hash_file(file):
    with open(file, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def check_s3_file(s3_key, local_file):
    s3_file = download_s3_file(s3_key)
    local_hash = hash_file(local_file)
    if not s3_file:
        print(f"Hash of local file: {local_hash}")
        return
    s3_hash = hashlib.sha256(s3_file).hexdigest()
    if local_hash != s3_hash:
        raise RuntimeError(f"Hash mismatch for {local_file}: {local_hash} != {s3_hash}")
    print(f"Hashes for local file and remote file match: {local_hash}")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--s3-key", required=True)
    parser.add_argument("--local-file", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    check_s3_file(args.s3_key, args.local_file)
