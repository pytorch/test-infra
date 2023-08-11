import json
import os
import re
from collections import defaultdict
from enum import Enum
from typing import Any, Dict, Optional, Union
from warnings import warn

import boto3
from opensearchpy import AWSV4SignerAuth, OpenSearch, RequestsHttpConnection


OPENSEARCH_ENDPOINT = (
    "search-gha-jobs-dev-4gx5sc6csvu5ui6mfhokz5h5pu.us-east-1.es.amazonaws.com"
)
OPENSEARCH_REGION = "us-east-1"
DYNAMODB_TABLE_REGEX = re.compile(
    "arn:aws:dynamodb:.*?:.*?:table/(?P<table>[0-9a-zA-Z_-]+)/.+"
)

CREDENTIALS = boto3.Session().get_credentials()
AWS_AUTH = AWSV4SignerAuth(CREDENTIALS, OPENSEARCH_REGION, "es")
OPENSEARCH_CLIENT = OpenSearch(
    hosts=[{"host": OPENSEARCH_ENDPOINT, "port": 443}],
    http_auth=AWS_AUTH,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection,
)


class EventType(Enum):
    INSERT = "INSERT"
    REMOVE = "REMOVE"
    MODIFY = "MODIFY"


def lambda_handler(event: Any, context: Any) -> None:
    counts = defaultdict(int)
    # The input of this lambda is a stream of DynamoDB event that we want to
    # indexed on OpenSearch
    for record in event["Records"]:
        event_name = record.get("eventName", "")
        try:
            if (
                event_name == EventType.INSERT.value
                or event_name == EventType.MODIFY.value
            ):
                upsert_document(record)
            elif event_name == EventType.REMOVE.value:
                remove_document(record)
            else:
                warn(f"Unrecognized event type {event_name} in {json.dumps(record)}")

            counts[event_name] += 1
        except Exception as error:
            warn(f"Failed to process {json.dumps(record)}: {error}")

    print(f"Finish processing {json.dumps(counts)}")


def extract_dynamodb_table(record: Any) -> Optional[str]:
    """
    Extract the DynamoDB table name from the source ARN. This will be used later as
    the index name
    """
    s = record.get("eventSourceARN", "")
    m = DYNAMODB_TABLE_REGEX.match(s)
    if not m:
        warn(f"Invalid value {s}, expecting a DynamoDB table")
        return

    return m.group("table").lower()


def extract_dynamodb_key(record: Any) -> Optional[str]:
    keys = unmarshal({"M": record.get("dynamodb", {}).get("Keys", {})})
    if not keys:
        return
    return "|".join(keys.values())


def to_number(s: str) -> Union[int, float]:
    try:
        return int(s)
    except ValueError:
        return float(s)


def unmarshal(doc: Dict[Any, Any]) -> Any:
    """
    Convert the DynamoDB stream record into a regular JSON document. This is done recursively.
    At the top level, it will be a dictionary of type M (Map). Here is the list of DynamoDB
    attributes to handle:

    https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_streams_AttributeValue.html
    """
    for k, v in list(doc.items()):
        if k == "NULL":
            return

        if k == "S" or k == "BOOL":
            return v

        if k == "N":
            return to_number(v)

        if k == "M":
            return {sk: unmarshal(sv) for sk, sv in v.items()}

        if k == "BS" or k == "L":
            return [unmarshal(item) for item in v]

        if k == "SS":
            return v.copy()

        if k == "NS":
            return [to_number(item) for item in v]

    return {}


def upsert_document(record: Any) -> None:
    """
    Insert a new doc or modify an existing document. The latter happens when the workflow job is
    updated (new step, finishing). A record from torchci-workflow-job looks as follows
        {
            "eventID": "...",
            "eventName": "MODIFY",
            "eventVersion": "1.1",
            "eventSource": "aws:dynamodb",
            "awsRegion": "us-east-1",
            "dynamodb": {
                "ApproximateCreationDateTime": 1691722869,
                "Keys": {
                    "dynamoKey": {
                        "S": "pytorch/pytorch/15806159447"
                    }
                },
                "NewImage": {
                    "workflow_name": {
                        "S": "pull"
                    },
                    "steps": {
                        "L": [
                            {
                                "M": {
                                    "conclusion": {
                                        "NULL": true
                                    },
                                    "number": {
                                        "N": "1"
                                    },
                                    "completed_at": {
                                        "NULL": true
                                    },
                                    "name": {
                                        "S": "Set up job"
                                    },
                                    "started_at": {
                                        "S": "..."
                                    },
                                    "status": {
                                        "S": "in_progress"
                                    }
                                }
                            }
                         ]
                    },
                    ... all other fields ...
                },
                "OldImage": {
                    "workflow_name": {
                        "S": "pull"
                    },
                    "steps": {
                        "L": []
                    },
                    ... all other fields ...
                },
                "SequenceNumber": "...",
                "SizeBytes": 1763,
                "StreamViewType": "NEW_AND_OLD_IMAGES"
            },
            "eventSourceARN": "arn:aws:dynamodb:us-east-1:...:table/torchci-workflow-job/stream/..."
        }
    """
    index = extract_dynamodb_table(record)
    if not index:
        return

    # Create index using the table name if it's not there yet
    if not OPENSEARCH_CLIENT.indices.exists(index):
        # https://www.elastic.co/guide/en/elasticsearch/reference/current/coerce.html
        OPENSEARCH_CLIENT.indices.create(
            index, body={"settings": {"index.mapping.coerce": true}}
        )

    body = unmarshal({"M": record["dynamodb"]["NewImage"]})
    id = extract_dynamodb_key(record)

    print(f"UPSERTING {id} INTO {index}")
    print(body)
    OPENSEARCH_CLIENT.index(index=index, body=body, id=id, refresh=True)


def remove_document(record: Any) -> None:
    """
    Remove a document. This is here for completeness as we don't remove records from DynamoDB
    """
    index = extract_dynamodb_table(record)
    if not index:
        return

    id = extract_dynamodb_key(record)

    print(f"DELETING {id} FROM {index}")
    OPENSEARCH_CLIENT.delete(index=index, id=id, refresh=True)


if os.getenv("DEBUG", "0") == "1":
    mock_body = {
        "Records": [
            {
                "eventID": "5a42b3df2897fc0ca272d50a62873b3f",
                "eventName": "INSERT",
                "eventVersion": "1.1",
                "eventSource": "aws:dynamodb",
                "awsRegion": "us-east-1",
                "dynamodb": {
                    "ApproximateCreationDateTime": 1691722535,
                    "Keys": {"dynamoKey": {"S": "pytorch/pytorch/15806102004"}},
                    "NewImage": {
                        "runner_id": {"N": "5075952"},
                        "run_id": {"N": "5828283457"},
                        "dynamoKey": {"S": "pytorch/pytorch/15806102004"},
                        "head_branch": {"S": "export-D48055141"},
                        "workflow_name": {"S": "pull"},
                        "runner_group_name": {"S": "Default"},
                        "runner_name": {"S": "i-0b85c433d29e0c108"},
                        "created_at": {"S": "2023-08-11T02:55:33Z"},
                        "steps": {"L": []},
                        "check_run_url": {
                            "S": "https://api.github.com/repos/pytorch/pytorch/check-runs/15806102004"
                        },
                        "head_sha": {"S": "7b34438ac2f380f68436ae2f0287054065c9837e"},
                        "url": {
                            "S": "https://api.github.com/repos/pytorch/pytorch/actions/jobs/15806102004"
                        },
                        "labels": {"L": [{"S": "linux.4xlarge.nvidia.gpu"}]},
                        "conclusion": {"NULL": True},
                        "completed_at": {"NULL": True},
                        "run_url": {
                            "S": "https://api.github.com/repos/pytorch/pytorch/actions/runs/5828283457"
                        },
                        "html_url": {
                            "S": "https://github.com/pytorch/pytorch/actions/runs/5828283457/job/15806102004"
                        },
                        "name": {
                            "S": "linux-bionic-cuda12.1-py3.10-gcc9 / test (default, 5, 5, linux.4xlarge.nvidia.gpu)"
                        },
                        "run_attempt": {"N": "1"},
                        "started_at": {"S": "2023-08-11T02:55:33Z"},
                        "id": {"N": "15806102004"},
                        "runner_group_id": {"N": "1"},
                        "node_id": {"S": "CR_kwDOA-j9z88AAAADrh359A"},
                        "status": {"S": "queued"},
                    },
                    "SequenceNumber": "3631763800000000043419320452",
                    "SizeBytes": 848,
                    "StreamViewType": "NEW_AND_OLD_IMAGES",
                },
                "eventSourceARN": "arn:aws:dynamodb:us-east-1:308535385114:table/torchci-workflow-job/stream/2022-01-14T01:31:51.775",
            },
            {
                "eventID": "8b2be2f54bf7099dc36e5ed0ba34688b",
                "eventName": "MODIFY",
                "eventVersion": "1.1",
                "eventSource": "aws:dynamodb",
                "awsRegion": "us-east-1",
                "dynamodb": {
                    "ApproximateCreationDateTime": 1691722869,
                    "Keys": {
                        "dynamoKey": {
                            "S": "pytorch/pytorch/15806159447"
                        }
                    },
                    "NewImage": {
                        "runner_id": {
                            "N": "5077686"
                        },
                        "run_id": {
                            "N": "5828325322"
                        },
                        "dynamoKey": {
                            "S": "pytorch/pytorch/15806159447"
                        },
                        "head_branch": {
                            "S": "gh/CaoE/32/head"
                        },
                        "workflow_name": {
                            "S": "pull"
                        },
                        "runner_group_name": {
                            "S": "Default"
                        },
                        "runner_name": {
                            "S": "i-00977fadb0de374e8"
                        },
                        "created_at": {
                            "S": "2023-08-11T03:01:03Z"
                        },
                        "steps": {
                            "L": [
                                {
                                    "M": {
                                        "conclusion": {
                                            "NULL": True
                                        },
                                        "number": {
                                            "N": "1"
                                        },
                                        "completed_at": {
                                            "NULL": True
                                        },
                                        "name": {
                                            "S": "Set up job"
                                        },
                                        "started_at": {
                                            "S": "2023-08-11T03:01:07.000Z"
                                        },
                                        "status": {
                                            "S": "in_progress"
                                        }
                                    }
                                }
                            ]
                        },
                        "check_run_url": {
                            "S": "https://api.github.com/repos/pytorch/pytorch/check-runs/15806159447"
                        },
                        "head_sha": {
                            "S": "ae83b0ae35ad61571ac4c805d62268f46c950bb7"
                        },
                        "url": {
                            "S": "https://api.github.com/repos/pytorch/pytorch/actions/jobs/15806159447"
                        },
                        "labels": {
                            "L": [
                                {
                                    "S": "linux.g5.4xlarge.nvidia.gpu"
                                }
                            ]
                        },
                        "conclusion": {
                            "NULL": True
                        },
                        "completed_at": {
                            "NULL": True
                        },
                        "run_url": {
                            "S": "https://api.github.com/repos/pytorch/pytorch/actions/runs/5828325322"
                        },
                        "html_url": {
                            "S": "https://github.com/pytorch/pytorch/actions/runs/5828325322/job/15806159447"
                        },
                        "name": {
                            "S": "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 2, 5, linux.g5.4xlarge.nvidia.gpu)"
                        },
                        "run_attempt": {
                            "N": "1"
                        },
                        "started_at": {
                            "S": "2023-08-11T03:01:07Z"
                        },
                        "id": {
                            "N": "15806159447"
                        },
                        "runner_group_id": {
                            "N": "1"
                        },
                        "node_id": {
                            "S": "CR_kwDOA-j9z88AAAADrh7aVw"
                        },
                        "status": {
                            "S": "in_progress"
                        }
                    },
                    "OldImage": {
                        "runner_id": {
                            "NULL": True
                        },
                        "run_id": {
                            "N": "5828325322"
                        },
                        "dynamoKey": {
                            "S": "pytorch/pytorch/15806159447"
                        },
                        "head_branch": {
                            "S": "gh/CaoE/32/head"
                        },
                        "workflow_name": {
                            "S": "pull"
                        },
                        "runner_group_name": {
                            "NULL": True
                        },
                        "runner_name": {
                            "NULL": True
                        },
                        "created_at": {
                            "S": "2023-08-11T03:01:03Z"
                        },
                        "steps": {
                            "L": []
                        },
                        "check_run_url": {
                            "S": "https://api.github.com/repos/pytorch/pytorch/check-runs/15806159447"
                        },
                        "head_sha": {
                            "S": "ae83b0ae35ad61571ac4c805d62268f46c950bb7"
                        },
                        "url": {
                            "S": "https://api.github.com/repos/pytorch/pytorch/actions/jobs/15806159447"
                        },
                        "labels": {
                            "L": [
                                {
                                    "S": "linux.g5.4xlarge.nvidia.gpu"
                                }
                            ]
                        },
                        "conclusion": {
                            "NULL": True
                        },
                        "completed_at": {
                            "NULL": True
                        },
                        "run_url": {
                            "S": "https://api.github.com/repos/pytorch/pytorch/actions/runs/5828325322"
                        },
                        "html_url": {
                            "S": "https://github.com/pytorch/pytorch/actions/runs/5828325322/job/15806159447"
                        },
                        "name": {
                            "S": "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 2, 5, linux.g5.4xlarge.nvidia.gpu)"
                        },
                        "run_attempt": {
                            "N": "1"
                        },
                        "started_at": {
                            "S": "2023-08-11T03:01:02Z"
                        },
                        "id": {
                            "N": "15806159447"
                        },
                        "runner_group_id": {
                            "NULL": True
                        },
                        "node_id": {
                            "S": "CR_kwDOA-j9z88AAAADrh7aVw"
                        },
                        "status": {
                            "S": "queued"
                        }
                    },
                    "SequenceNumber": "3632472300000000014833154899",
                    "SizeBytes": 1763,
                    "StreamViewType": "NEW_AND_OLD_IMAGES"
                },
                "eventSourceARN": "arn:aws:dynamodb:us-east-1:308535385114:table/torchci-workflow-job/stream/2022-01-14T01:31:51.775"
            }
        ]
    }

    lambda_handler(mock_body, None)
