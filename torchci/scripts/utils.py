import datetime
from hashlib import sha256
import json
import os
import pathlib
import subprocess
from typing import List, Union


FILE_CACHE_LIFESPAN_SECONDS = 60 * 60 * 24  # 1 day
REPO_ROOT = pathlib.Path(__file__).parent.parent.parent
CACHE_FOLDER = REPO_ROOT / "_logs" / ".torchci_python_utils_cache"


def js_beautify(obj):
    # Like json.dumps with indent=2, but only at the first level.  Nice for
    # dictionaries of str -> really long list
    import jsbeautifier

    opts = jsbeautifier.default_options()
    opts.indent_size = 2
    return jsbeautifier.beautify(json.dumps(obj), opts)


def run_command(command: Union[str, List[str]]) -> str:
    # Runs command in pytorch folder.  Assumes test-infra and pytorch are in the
    # same folder.
    if isinstance(command, str):
        command = command.split(" ")
    cwd = REPO_ROOT / ".." / "pytorch"
    return (
        subprocess.check_output(
            command,
            cwd=cwd,
        )
        .decode("utf-8")
        .strip()
    )


def cache_json(func):
    # Requires that both input and output be json serializable.
    # Decorator for caching function results into a file so it can be reused betwen runs.
    os.makedirs(CACHE_FOLDER, exist_ok=True)

    def wrapper(*args, **kwargs):
        os.makedirs(CACHE_FOLDER, exist_ok=True)
        args_key = sha256(json.dumps(args).encode("utf-8")).hexdigest()
        kwargs_key = sha256(
            json.dumps(kwargs, sort_keys=True).encode("utf-8")
        ).hexdigest()
        file_name = f"{func.__name__} args={args_key} kwargs={kwargs_key}.json"

        if os.path.exists(CACHE_FOLDER / file_name):
            now = datetime.datetime.now()
            mtime = datetime.datetime.fromtimestamp(
                (CACHE_FOLDER / file_name).stat().st_mtime
            )
            diff = now - mtime
            if diff.total_seconds() < FILE_CACHE_LIFESPAN_SECONDS:
                return json.load(open(CACHE_FOLDER / file_name))

        res = func(*args, **kwargs)
        with open(CACHE_FOLDER / file_name, "w") as f:
            f.write(json.dumps(res))
        return res

    return wrapper
