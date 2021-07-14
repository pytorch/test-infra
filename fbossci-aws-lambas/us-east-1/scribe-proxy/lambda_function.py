# Copyright (c) 2019-present, Facebook, Inc.

import json
import os
from urllib.request import Request, urlopen


# This lambda function proxy the event to scribe with access_token attached
# Usage example from the invocation with IAM role permission:
#
# ```
# import boto3
# data = {
#     'access_token': '', # optional field, will be overwritten by the lambda function
#     'logs': json.dumps(
#         [
#             {
#                 "category": "perfpipe_pytorch_test_times",
#                 "message": "message",
#                 "line_escape": False,
#             }
#         ]
#     )
# }
# client = boto3.client('lambda')
# res = client.invoke(FunctionName='gh-ci-scribe-proxy', Payload=json.dumps(data).encode())
# if res['FunctionError']:
#     raise Exception(res['Payload'].read().decode())
# ```
def lambda_handler(event, context):
    req = Request('https://graph.facebook.com/scribe_logs', method='POST')
    req.add_header('Content-Type', 'application/json')
    event['access_token'] = os.environ.get('SCRIBE_GRAPHQL_ACCESS_TOKEN')
    return urlopen(req, data=json.dumps(event).encode()).read()
