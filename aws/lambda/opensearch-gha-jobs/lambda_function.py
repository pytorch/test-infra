import json
import re
from collections import defaultdict
from enum import Enum
from typing import Any, Dict, Optional, Union
from warnings import warn

import boto3
from opensearchpy import AWSV4SignerAuth, OpenSearch, RequestsHttpConnection


OPENSEARCH_ENDPOINT = (
    "search-gha-jobs-po2dvxh7kcayevbmm6ih2vr4ka.us-east-1.es.amazonaws.com"
)
OPENSEARCH_REGION = "us-east-1"
DYNAMODB_TABLE_REGEX = re.compile(
    "arn:aws:dynamodb:.*?:.*?:table/(?P<table>[0-9a-zA-Z_-]+)/.+"
)


class EventType(Enum):
    INSERT = "INSERT"
    REMOVE = "REMOVE"
    MODIFY = "MODIFY"


def lambda_handler(event: Any, context: Any) -> None:
    credentials = boto3.Session().get_credentials()
    aws_auth = AWSV4SignerAuth(credentials, OPENSEARCH_REGION, "es")
    opensearch_client = OpenSearch(
        hosts=[{"host": OPENSEARCH_ENDPOINT, "port": 443}],
        http_auth=aws_auth,
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection,
    )

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
                upsert_document(opensearch_client, record)
            elif event_name == EventType.REMOVE.value:
                remove_document(opensearch_client, record)
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


def upsert_document(client: OpenSearch, record: Any) -> None:
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
    if not client.indices.exists(index):
        # https://www.elastic.co/guide/en/elasticsearch/reference/current/coerce.html
        client.indices.create(index, body={"settings": {"index.mapping.coerce": True}})

    body = unmarshal({"M": record.get("dynamodb", {}).get("NewImage", {})})
    if not body:
        return

    id = extract_dynamodb_key(record)
    if not id:
        return

    print(f"UPSERTING {id} INTO {index}")
    client.index(index=index, body=body, id=id, refresh=True)


def remove_document(client: OpenSearch, record: Any) -> None:
    """
    Remove a document. This is here for completeness as we don't remove records from DynamoDB
    """
    index = extract_dynamodb_table(record)
    if not index:
        return

    id = extract_dynamodb_key(record)
    if not id:
        return

    print(f"DELETING {id} FROM {index}")
    client.delete(index=index, id=id, refresh=True)
