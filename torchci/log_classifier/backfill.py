import argparse
import json
import logging
import os
import sys
from urllib.request import urlopen

logger = logging.getLogger()
logger.setLevel(logging.INFO)

LAMBDA_URL = os.environ.get("LAMBDA_URL")
if LAMBDA_URL is None:
    raise RuntimeError("LAMBDA_URL not set, see --help")

ROCKSET_API_KEY = os.environ.get("ROCKSET_API_KEY")
if ROCKSET_API_KEY is None:
    raise RuntimeError("ROCKSET_API_KEY not set, see --help")


def send_lambda_request(id):
    logger.info(f"sending lambda request for id {id}")
    url = LAMBDA_URL + f"?{id}"
    with urlopen(url) as res:
        logger.info(f"lambda response for id {id}: {res.status}")


def do_backfill(n):
    if args.ids:
        ids = args.ids
    else:
        # Import here to avoid requiring these dependencies in lambda
        import json
        from rockset import Client, ParamDict

        # query rockset for unclassified failed GHA job ids
        client = Client(
            api_key=ROCKSET_API_KEY,
            api_server="https://api.rs2.usw2.rockset.com",
        )
        with open("rockset/prodVersions.json", "r") as f:
            rocksetVersions = json.load(f)
        qlambda = client.QueryLambda.retrieve(
            "unclassified", version=rocksetVersions["commons"]["unclassified"], workspace="commons"
        )

        params = ParamDict({
            n: n
        })
        results = qlambda.execute(parameters=params).results
        ids = [result["id"] for result in results]
    # Import here to avoid requiring these dependencies in lambda
    from concurrent.futures import ThreadPoolExecutor, wait
    with ThreadPoolExecutor() as executor:
        futures = []
        for id in ids:
            futures.append(executor.submit(send_lambda_request, id))
        wait(futures)

    logger.info("done!")


if __name__ == "__main__":
    logging.basicConfig(
        format="<%(levelname)s> [%(asctime)s] %(message)s",
        level=logging.INFO,
        stream=sys.stderr,
    )

    parser = argparse.ArgumentParser(
        description="""\
        Backfill classifications for FAILED jobs. This is useful when we add a
        new rule and want old jobs to use it.

        You need to set ROCKSET_API_KEY to a valid Rockset API key and
        LAMBDA_URL to the API Gateway URL for the ossci-log-analyzer lambda.

        This uses the lambda to backfill, NOT your local repo.
        """
    )
    parser.add_argument(
        "--n",
        type=int,
        default=1000,
        help="Classify the `n` most recent failed jobs from the past day",
    )
    parser.add_argument(
        "ids",
        nargs="+",
        help="GitHub actions job ids to classify",
    )
    args = parser.parse_args()

    do_backfill(args.n)
