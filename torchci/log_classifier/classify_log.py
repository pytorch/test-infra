"""
classify_log.py

This is intended to be run from a lambda, but can be run manually as well.
"""

import gzip
import json
import logging
import re
from itertools import cycle
from multiprocessing import Pipe, Process
from pathlib import Path
from urllib.request import urlopen

logger = logging.getLogger()
logger.setLevel(logging.INFO)


import boto3  # type: ignore

s3 = boto3.resource("s3")
BUCKET_NAME = "ossci-raw-job-status"
WRITE_TO_S3 = True
# https://stackoverflow.com/questions/14693701/how-can-i-remove-the-ansi-escape-sequences-from-a-string-in-python
ESCAPE_CODE_REGEX = re.compile(
    br"(?:\x1B[@-Z\\-_]|[\x80-\x9A\x9C-\x9F]|(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~])"
)


ignore = (
    re.compile(rb"=================== sccache compilation log ==================="),
    re.compile(rb"=========== If your build fails, please take a look at the log above for possible reasons ==========="),
)


class Rule:
    def __init__(self, name, pattern, priority):
        self.name = name
        if isinstance(pattern, str):
            pattern = pattern.encode()

        self.pattern = re.compile(pattern)
        self.priority = priority

    def match(self, line):
        return self.pattern.search(line)


class RuleMatch:
    def __init__(self, rule, line_num):
        self.rule: Rule = rule
        self.line_num: int = line_num


class RuleEngine:
    DUMMY_RULE = Rule("dummy", "", -1)

    def __init__(self, rules):
        # Sort rules so that the highest priority is first
        self.rules = sorted(rules, key=lambda rule: rule.priority, reverse=True)
        self._best_match = RuleMatch(self.DUMMY_RULE, "")

    def run(self, lines):
        """Find the highest-priority matching rule from this log.

        This uses multiple processes to match lines in parallel. Certain logs
        (long logs with long lines, e.g. windows logs) cause a non-parallel
        implementation to timeout on lambda.
        """
        # Split the work into buckets so we can parallelize.
        num_buckets = 6  # hard-coded because AWS Lambda supports max 6 vcpus.
        buckets = [[] for _ in range(num_buckets)]
        lines_with_num = list(enumerate(lines))
        for elem, bucket in zip(lines_with_num, cycle(buckets)):
            bucket.append(elem)

        # create a list to keep all processes
        processes = []

        # create a list to keep connections
        parent_connections = []

        # create a process per bucket
        for bucket in buckets:
            # create a pipe for communication
            # we are doing this manually because AWS lambda doesn't have shm
            # (and thus can't use most higher-order multiprocessing primitives)
            parent_conn, child_conn = Pipe()
            parent_connections.append(parent_conn)

            # send the work over
            process = Process(
                target=self.process_bucket,
                args=(
                    bucket,
                    child_conn,
                ),
            )
            processes.append(process)

        for process in processes:
            process.start()
        for process in processes:
            process.join()

        # get the best match from all the processes
        for parent_conn in parent_connections:
            match = parent_conn.recv()
            if match == None:
                continue
            if match.rule.priority > self._best_match.rule.priority:
                self._best_match = match

    def process_bucket(self, bucket, conn):
        for num, line in bucket:
            self.process_line(num, line)
        conn.send(self.best_match())
        conn.close()

    def process_line(self, line_num, line):
        for rule in self.rules:
            match = rule.match(line)
            if match is not None:
                if rule.priority > self._best_match.rule.priority:
                    self._best_match = RuleMatch(rule, line_num)

        # optimization: remove rules we know can't beat the current one
        new_rules = []
        for rule in self.rules:
            if rule.priority > self._best_match.rule.priority:
                new_rules.append(rule)
        self.rules = new_rules

    def best_match(self):
        if self._best_match.rule is self.DUMMY_RULE:
            return None
        return self._best_match


def get_rules_from_gh():
    with urlopen("https://www.torch-ci.com/api/classifier/rules") as data:
        rules = json.load(data)
        rules = [Rule(**r) for r in rules]
    return rules


def get_rules_from_local():
    with open(Path(__file__).parent / "rules.json") as data:
        rules = json.load(data)
        rules = [Rule(**r) for r in rules]
    return rules


def match_to_json(id, rule_match, lines):
    context_start = max(0, rule_match.line_num - 25)
    context_end = rule_match.line_num + 25
    context = lines[context_start:context_end]
    context = [line.rstrip() for line in context]
    context = b"\n".join(context)

    # perform matching to get capture groups
    line = lines[rule_match.line_num]
    match = rule_match.rule.match(line)
    capture_groups = match.groups(default="<no capture>")
    if len(capture_groups) == 0:
        captures = match.group(0)
    else:
        captures = b", ".join(match.groups(default="<no capture>"))

    return json.dumps(
        {
            "job_id": int(id),
            "rule": rule_match.rule.name,
            # decode with replace to avoid raising errors on non-utf8 characters
            "line": line.decode(errors="replace").strip(),
            "line_num": rule_match.line_num + 1,  # +1 because lines are 1 indexed to users
            "context": context.decode(errors="replace"),
            "captures": captures.decode(errors="replace").strip(),
        },
        indent=4,
    )


def classify(rules, id):
    logger.info(f"classifying {id}")
    logger.info("fetching from s3")
    log_obj = s3.Object(BUCKET_NAME, f"log/{id}")
    log_obj.load()

    log = log_obj.get()

    # logs are stored gzip-compressed
    logger.info("decompressing")
    log = gzip.decompress(log["Body"].read())
    lines = log.split(b"\n")

    # GHA adds a timestamp to the front of every log. Strip it before matching.
    logger.info("stripping timestamps")
    lines = [line.partition(b" ")[2] for line in lines]

    # Color, etc. in terminal output should be removed
    logger.info("stripping escape codes")
    lines = [ESCAPE_CODE_REGEX.sub(b"", line) for line in lines]

    logger.info("stripping ignore rules")
    ignore_start, ignore_stop = ignore
    is_ignoring = False
    for idx, line in enumerate(lines):
        match = ignore_start.search(line)
        if match:
            is_ignoring = True
        match = ignore_stop.search(line)
        if match:
            is_ignoring = False

        if is_ignoring:
            lines[idx] = b""

    if is_ignoring:
        logger.warn("still ignoring at the end of the log, probably you got the stop condition wrong")

    logger.info("running engine")
    engine = RuleEngine(rules)
    engine.run(lines)
    match = engine.best_match()
    if not match:
        logger.info("no match found")
        return "no match found"

    json = match_to_json(id, match, lines)
    if WRITE_TO_S3:
        logger.info("writing to s3")
        s3.Object(BUCKET_NAME, f"classification/{id}").put(
            Body=json, ContentType="application/json"
        )
    else:
        logger.info("writing to stdout")
        print(json)
    logger.info("done")
    return json


def handle_s3_trigger(rules, event):
    log_key = event["Records"][0]["s3"]["object"]["key"]
    # chop off the leading "logs/"
    id = log_key.partition("/")[2]
    return classify(rules, id)


def handle_http_trigger(rules, event):
    id = event["rawQueryString"]
    return classify(rules, id)


def lambda_handler(event, context):
    rules = get_rules_from_gh()
    if "Records" in event:
        body = handle_s3_trigger(rules, event)
    else:
        body = handle_http_trigger(rules, event)
    return {"statusCode": 200, "body": body}


if __name__ == "__main__":
    import argparse
    import sys

    logging.basicConfig(
        format="<%(levelname)s> [%(asctime)s] %(message)s",
        level=logging.INFO,
        stream=sys.stderr,
    )

    parser = argparse.ArgumentParser(
        description="""\
            Download logs from s3 and classify them. Optionally, write the
            classification back to s3.
        """
    )
    parser.add_argument(
        "ids",
        nargs="+",
        help="GitHub actions job ids to classify",
    )
    parser.add_argument(
        "--update-s3",
        action="store_true",
        help="If set, write the resulting classification to s3.",
    )
    args = parser.parse_args()
    WRITE_TO_S3 = args.update_s3

    rules = get_rules_from_local()
    for id in args.ids:
        classify(rules, id)
