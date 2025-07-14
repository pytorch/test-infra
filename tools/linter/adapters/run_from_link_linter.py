import argparse
from pathlib import Path
import subprocess
import urllib.request

REPO_ROOT = Path(__file__).absolute().parents[3]

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Use a formatter in a different repository.",
    )
    parser.add_argument(
        "--run-init",
        action="store_true",
    )
    parser.add_argument(
        "--init-name",
    )
    parser.add_argument(
        "--init-link",
    )
    parser.add_argument(
        "--lint-name",
        required=True,
    )
    parser.add_argument(
        "--lint-link",
        required=True,
    )
    parser.add_argument('args_for_file', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    # Skip the first -- if present
    if args.args_for_file and args.args_for_file[0] == '--':
        args.args_for_file = args.args_for_file[1:]
    return args


def download_file(url: str, location: Path) -> bytes:
    response = urllib.request.urlopen(url)
    content = response.read()
    location.write_bytes(content)
    return content


def main() -> None:
    args = parse_args()

    location = REPO_ROOT / ".lintbin" / "from_link" / "adapters"

    if args.run_init:
        location.mkdir(parents=True, exist_ok=True)
        # Save the content to a file named after the name argument
        download_file(args.lint_link, location / args.lint_name)
        download_file(args.init_link, location / args.init_name)
        subprocess.run(["python3", location / args.init_name] + args.args_for_file, check=True)
    else:
        subprocess.run(
            ["python3", location / args.lint_name] + args.args_for_file,
            check=True,
        )


if __name__ == "__main__":
    main()
