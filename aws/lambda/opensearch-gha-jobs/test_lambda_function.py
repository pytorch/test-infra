import json
from unittest import TestCase
from unittest.mock import Mock

from lambda_function import (
    extract_dynamodb_key,
    extract_dynamodb_table,
    remove_document,
    to_number,
    unmarshal,
    upsert_document,
)


def test_extract_dynamodb_table():
    cases = [
        {
            "arn": "",
            "expected": None,
            "description": "Invalid input - empty input",
        },
        {
            "arn": "FOOBAR",
            "expected": None,
            "description": "Invalid input - not in ARN format",
        },
        {
            "arn": "arn:aws:dynamodb:us-east-1:12345:table/torchci-workflow-job/stream/2022-01-14T01:31:51.775",
            "expected": "torchci-workflow-job",
            "description": "An event coming from DynamoDB",
        },
    ]

    for case in cases:
        arn = case["arn"]
        expected = case["expected"]
        TestCase().assertEqual(expected, extract_dynamodb_table({"eventSourceARN": arn}))


def test_extract_dynamodb_key():
    cases = [
        {
            "input": {},
            "expected": None,
            "description": "Invalid input - empty input",
        },
        {
            "input": {"FOO": "BAR"},
            "expected": None,
            "description": "Invalid input - not a valid record",
        },
        {
            "input": {
                "dynamodb": {},
            },
            "expected": None,
            "description": "Invalid input - no key",
        },
        {
            "input": {
                "dynamodb": {"Keys": {}},
            },
            "expected": None,
            "description": "Invalid input - empty key",
        },
        {
            "input": {
                "dynamodb": {"Keys": {"dynamoKey": {"S": "pytorch/pytorch/123"}}},
            },
            "expected": "pytorch/pytorch/123",
            "description": "Valid record with a dynamo key",
        },
        {
            "input": {
                "dynamodb": {
                    "Keys": {
                        "dynamoKey": {"S": "pytorch/pytorch/123"},
                        "dummyKey": {"S": "dummy"},
                    }
                },
            },
            "expected": "pytorch/pytorch/123|dummy",
            "description": "Valid record with multiple keys",
        },
    ]

    for case in cases:
        input = case["input"]
        expected = case["expected"]
        TestCase().assertEqual(expected, extract_dynamodb_key(input))


def test_to_number():
    v = to_number("3")
    TestCase().assertEqual(3, v)
    TestCase().assertTrue(isinstance(v, int))

    v = to_number("3.0")
    TestCase().assertEqual(3.0, v)
    TestCase().assertTrue(isinstance(v, float))


def test_unmarshal():
    cases = [
        {
            "input": {
                "runner_id": {"N": "5075952"},
                "dynamoKey": {"S": "pytorch/pytorch/15806102004"},
                "head_branch": {"S": "export-D48055141"},
                "test": {"BOOL": True},
                "runner_group_name": {"BS": [{"S": "Default"}]},
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
                "node_id": {"NS": ["1", "2", "3"]},
                "status": {"S": "queued"},
            },
            "expected": {
                "runner_id": 5075952,
                "dynamoKey": "pytorch/pytorch/15806102004",
                "head_branch": "export-D48055141",
                "test": True,
                "runner_group_name": ["Default"],
                "runner_name": "i-0b85c433d29e0c108",
                "created_at": "2023-08-11T02:55:33Z",
                "steps": [],
                "check_run_url": "https://api.github.com/repos/pytorch/pytorch/check-runs/15806102004",
                "head_sha": "7b34438ac2f380f68436ae2f0287054065c9837e",
                "url": "https://api.github.com/repos/pytorch/pytorch/actions/jobs/15806102004",
                "labels": ["linux.4xlarge.nvidia.gpu"],
                "conclusion": None,
                "completed_at": None,
                "run_url": "https://api.github.com/repos/pytorch/pytorch/actions/runs/5828283457",
                "html_url": "https://github.com/pytorch/pytorch/actions/runs/5828283457/job/15806102004",
                "name": "linux-bionic-cuda12.1-py3.10-gcc9 / test (default, 5, 5, linux.4xlarge.nvidia.gpu)",
                "run_attempt": 1,
                "started_at": "2023-08-11T02:55:33Z",
                "id": 15806102004,
                "runner_group_id": 1,
                "node_id": [1, 2, 3],
                "status": "queued",
            },
        }
    ]

    for case in cases:
        input = case["input"]
        expected = case["expected"]
        assert expected == unmarshal({"M": input})


def test_remove_document():
    cases = [
        {
            "input": {},
            "removed": False,
            "description": "Invalid input - empty record",
        },
        {
            "input": {
                "eventName": "REMOVE",
            },
            "removed": False,
            "description": "Invalid input - no table name",
        },
        {
            "input": {
                "eventName": "REMOVE",
                "eventSourceARN": "arn:aws:dynamodb:us-east-1:123:table/torchci-workflow-job/stream/456",
            },
            "removed": False,
            "description": "Invalid input - no ID",
        },
        {
            "input": {
                "eventName": "REMOVE",
                "eventSourceARN": "arn:aws:dynamodb:us-east-1:123:table/torchci-workflow-job/stream/456",
                "dynamodb": {"Keys": {"dynamoKey": {"S": "pytorch/pytorch/123"}}},
            },
            "removed": True,
            "description": "Remove one record",
        },
    ]

    for case in cases:
        mock_client = Mock()
        mock_client.delete.return_value = "OK"

        input = case["input"]
        remove_document(mock_client, input)

        if case["removed"]:
            mock_client.delete.assert_called_once()
        else:
            mock_client.delete.assert_not_called()


def test_upsert_document():
    cases = [
        {
            "input": {},
            "upserted": False,
            "description": "Invalid input - empty record",
        },
        {
            "input": {
                "eventName": "INSERT",
            },
            "upserted": False,
            "description": "Invalid input - no table name",
        },
        {
            "input": {
                "eventName": "INSERT",
                "eventSourceARN": "arn:aws:dynamodb:us-east-1:123:table/torchci-workflow-job/stream/456",
            },
            "upserted": False,
            "description": "Invalid input - no ID",
        },
        {
            "input": {
                "eventName": "INSERT",
                "eventSourceARN": "arn:aws:dynamodb:us-east-1:123:table/torchci-workflow-job/stream/456",
                "dynamodb": {"Keys": {"dynamoKey": {"S": "pytorch/pytorch/123"}}},
            },
            "upserted": False,
            "description": "Invalid input - No document body",
        },
        {
            "input": {
                "eventName": "INSERT",
                "eventSourceARN": "arn:aws:dynamodb:us-east-1:123:table/torchci-workflow-job/stream/456",
                "dynamodb": {
                    "Keys": {"dynamoKey": {"S": "pytorch/pytorch/123"}},
                    "NewImage": {
                        "workflow_name": {"S": "pull"},
                    },
                },
            },
            "upserted": True,
            "description": "Insert one document",
        },
        {
            "input": {
                "eventName": "MODIFY",
                "eventSourceARN": "arn:aws:dynamodb:us-east-1:123:table/torchci-workflow-job/stream/456",
                "dynamodb": {
                    "Keys": {"dynamoKey": {"S": "pytorch/pytorch/123"}},
                    "NewImage": {
                        "workflow_name": {"S": "pull"},
                        "steps": {
                            "L": [
                                {
                                    "M": {
                                        "conclusion": {"NULL": True},
                                        "number": {"N": "1"},
                                        "completed_at": {"NULL": True},
                                        "name": {"S": "Set up job"},
                                        "started_at": {"S": "..."},
                                        "status": {"S": "in_progress"},
                                    }
                                }
                            ]
                        },
                    },
                    "OldImage": {
                        "workflow_name": {"S": "pull"},
                        "steps": {"L": []},
                    },
                },
            },
            "upserted": True,
            "description": "Modify one document",
        },
    ]

    for case in cases:
        mock_client = Mock()
        mock_client.indices.exists.return_value = True
        mock_client.index.return_value = "OK"

        input = case["input"]
        upsert_document(mock_client, input)

        if case["upserted"]:
            mock_client.index.assert_called_once()
        else:
            mock_client.index.assert_not_called()
