"""
download_jenkins.py

- Pull the latest jenkins builds from the pytorch-master trigger
- Extract some basic information from jenkins's pretty miserable JSON
- Optionally, write the build infos to s3.

This is intended to be run from a lambda periodically, but can be run manually as well.
"""

import json
import logging
from urllib.request import Request, urlopen

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)


BUCKET_NAME = "ossci-raw-job-status"

XPATH = """\
builds[
   url,
   number,
   duration,
   timestamp,
   result,
   actions[parameters[name,value],
   causes[shortDescription]],
   changeSet[items[commitId,comment,msg]],
   subBuilds[
     result,
     jobName,
     url,
     duration,
     build[
       number,
       timestamp,
       subBuilds[
         result,
         jobName,
         url,
         duration,
         build[
           timestamp,
           number,
           subBuilds[result,jobName,url,duration]
         ]
       ]
     ]
   ]
]
""".replace(
    " ", ""
).replace(
    "\n", ""
)


def get_latest_jenkins_jobs():
    url = f"https://ci.pytorch.org/jenkins/job/pytorch-master/api/json?tree={XPATH}"
    with urlopen(Request(url)) as data:
        obj = json.load(data)
    return obj


def process_builds(obj):
    builds = obj["builds"]
    flattened_builds = []

    def handle_sub_build(sub_build, sha):
        if (
            "build" in sub_build
            and sub_build["build"]["_class"]
            == "com.tikal.jenkins.plugins.multijob.MultiJobBuild"
        ):
            for sub_sub_build in sub_build["build"]["subBuilds"]:
                handle_sub_build(sub_sub_build, sha)
            return

        flattened_builds.append(
            {
                "job_name": sub_build["jobName"],
                "status": sub_build["result"],
                "html_url": f"https://ci.pytorch.org/jenkins/{sub_build['url']}console",
                "sha": sha,
                "timestamp": sub_build["build"]["timestamp"],
                # build numbers are only unique within a job, so jobname + build number is unique
                "id": f'{sub_build["jobName"]}-{sub_build["build"]["number"]}',
            }
        )

    def handle_top_build(top_build):
        if len(top_build["changeSet"]["items"]) != 1:
            return
        sha = top_build["changeSet"]["items"][0]["commitId"]
        for sub_build in top_build["subBuilds"]:
            handle_sub_build(sub_build, sha)

    for build in builds:
        handle_top_build(build)

    return flattened_builds


def write_s3(flattened_builds):
    s3 = boto3.resource("s3")

    for build in flattened_builds:
        logger.info(f"uploading {build['id']}")
        s3.Object(BUCKET_NAME, f"jenkins_job/{build['id']}").put(
            Body=json.dumps(build, indent=4), ContentType="application/json"
        )


def lambda_handler(event, context):
    obj = get_latest_jenkins_jobs()
    builds = process_builds(obj)
    write_s3(builds)
    return {"statusCode": 200}


if __name__ == "__main__":
    import argparse
    import sys

    logging.basicConfig(
        format="<%(levelname)s> [%(asctime)s] %(message)s",
        level=logging.INFO,
        stream=sys.stderr,
    )

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--update-s3",
        action="store_true",
        help="If set, write the resulting classification to s3.",
    )
    args = parser.parse_args()

    obj = get_latest_jenkins_jobs()
    builds = process_builds(obj)
    logger.info(f"found {len(builds)} builds")

    if args.update_s3:
        write_s3(builds)
    else:
        for build in builds:
            logger.info(json.dumps(build, indent=4))
