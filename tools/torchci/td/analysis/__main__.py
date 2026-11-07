"""TD before/after analysis.

    python -m torchci.td.analysis <step> --cache DIR --pytorch REPO

Steps run in order: fetch, labels, rankings, llm, features, train, evaluate, report (llm runs in
the venv of td/llm's requirements). Each reads the
manifests of the steps before it. ClickHouse credentials come from the environment
(CLICKHOUSE_ENDPOINT or CLICKHOUSE_HOST, CLICKHOUSE_USERNAME, CLICKHOUSE_PASSWORD).
"""

import argparse
import logging
import os
import secrets
from pathlib import Path


STEPS = (
    "fetch",
    "labels",
    "rankings",
    "llm",
    "features",
    "train",
    "evaluate",
    "report",
)


def salt(cache: Path) -> str:
    path = cache / "author.salt"
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(16))
    return path.read_text().strip()


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m torchci.td.analysis")
    parser.add_argument("step", choices=STEPS)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument(
        "--pytorch", type=Path, required=True, help="a pytorch clone, read only"
    )
    parser.add_argument("--out", type=Path, help="report: the HTML file to write")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    for name in (
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "HUD_INTERNAL_BOT_TOKEN",
        "PR_NUMBER",
        "GITHUB_REF",
    ):
        os.environ.pop(name, None)
    os.environ.setdefault("CLICKHOUSE_ENDPOINT", os.environ.get("CLICKHOUSE_HOST", ""))
    # scikit-learn's OpenMP pool would otherwise take every core of a shared host.
    from torchci.td.analysis.config import N_JOBS

    os.environ.setdefault("OMP_NUM_THREADS", str(N_JOBS))
    args.cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    cache, repo = args.cache.resolve(), args.pytorch.resolve()
    if args.step == "fetch":
        from torchci.td.analysis import fetch

        fetch.run(cache, repo, salt(cache))
    elif args.step == "rankings":
        from torchci.td.analysis import rankings

        rankings.run(cache)
    elif args.step == "labels":
        from torchci.td.analysis import labels

        labels.run(cache)
    elif args.step == "features":
        from torchci.td.analysis import features

        features.run(cache, repo)
    elif args.step == "llm":
        from torchci.td.analysis import llm_scores

        llm_scores.run(cache, repo)
    elif args.step == "train":
        from torchci.td.analysis import models

        models.run(cache)
    elif args.step == "evaluate":
        from torchci.td.analysis import evaluate

        evaluate.run(cache)
    else:
        from torchci.td.analysis import dashboard

        dashboard.run(cache, args.out or cache / "td_before_after.html")


if __name__ == "__main__":
    main()
