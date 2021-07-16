# Copyright (c) 2019-present, Facebook, Inc.

import base64
import bz2
import json
import os
from typing import Any, Dict
from urllib.request import Request, urlopen

ALLOWED_EVENT_KEYS = set([
    'logs',
    'base64_bz2_logs',
])


def assert_valid(event: Dict[str, Any]) -> None:
    if not (ALLOWED_EVENT_KEYS.intersection(event.keys())):
        raise Exception(f'invalid event:{event}')


# This lambda function proxy the event to scribe with access_token attached.
# By default the event expects the following fields:
# . - `logs`:            which is a plain text passthrough
#   - `base64_bz2_logs`: which is a base64 bz2 compressed text
#
# It will try to use `logs` first if it exists, otherwise fallback to use the other formats
# Usage example from the invocation with IAM role permission:
#
# ```
# import boto3
# logs = json.dumps(
#     [
#         {
#             "category": "perfpipe_pytorch_test_times",
#             "message": "message",
#             "line_escape": False,
#         }
#     ]
# )
# event = {"base64_bz2_logs": base64.b64encode(bz2.compress(logs.encode())).decode()}
# client = boto3.client('lambda')
# res = client.invoke(FunctionName='gh-ci-scribe-proxy', Payload=json.dumps(event).encode())
# if res['FunctionError']:
#     raise Exception(res['Payload'].read().decode())
# ```
#
def lambda_handler(event, context):
    assert_valid(event)
    req = Request('https://graph.facebook.com/scribe_logs', method='POST')
    req.add_header('Content-Type', 'application/json')
    data = {'access_token': os.environ.get('SCRIBE_GRAPHQL_ACCESS_TOKEN')}
    if event.get('logs', '') != '':
        data['logs'] = event.get('logs')
    elif event.get('base64_bz2_logs', '') != '':
        data['logs'] = bz2.decompress(
            base64.b64decode(event['base64_bz2_logs'])).decode()
    return urlopen(req, data=json.dumps(data).encode()).read()
