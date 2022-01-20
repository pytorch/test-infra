import argparse
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
    # Import here to avoid requiring these dependencies in lambda
    from rockset import Client, Q, F, ParamDict
    from concurrent.futures import ThreadPoolExecutor, wait

    # query rockset for failed GHA job ids
    client = Client(
        api_key=ROCKSET_API_KEY,
        api_server="https://api.rs2.usw2.rockset.com",
    )
    qlambda = client.QueryLambda.retrieve(
        "unclassified", version="d39e66c0ed0aa238", workspace="commons"
    )

    params = ParamDict()
    results = qlambda.execute(parameters=params).results
    # q = (
    #     Q("GitHub-Actions.workflow_job")
    #     .where(F["conclusion"] == "failure")
    #     .highest(n, F["_event_time"])
    #     .select(F["id"])
    # )
    # results = client.sql(q)
    ids = [result["id"] for result in results]
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
        Backfill classifications for failing jobs. This is useful when we add a
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
        help="Classify the `n` most recent failed jobs",
    )
    args = parser.parse_args()

    do_backfill(args.n)
