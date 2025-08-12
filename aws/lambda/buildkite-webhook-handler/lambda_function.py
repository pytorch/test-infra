import json
from typing import Any, Dict

import boto3
from botocore.exceptions import ClientError


dynamodb = boto3.resource("dynamodb")
agent_events_table = dynamodb.Table("vllm-buildkite-agent-events")
build_events_table = dynamodb.Table("vllm-buildkite-build-events")
job_events_table = dynamodb.Table("vllm-buildkite-job-events")


def save_agent_event(event_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Save agent events to DynamoDB table.

    Args:
        event_data: The agent event payload from Buildkite

    Returns:
        Dict[str, Any]: Response containing status and result information
    """
    try:
        agent = event_data.get("agent", {})
        agent_id = agent.get("id", "")

        if not agent_id:
            return {
                "statusCode": 400,
                "body": json.dumps({"message": "Missing agent ID"}),
            }

        dynamo_key = agent_id
        item = {"dynamoKey": dynamo_key, **event_data}

        agent_events_table.put_item(Item=item)

        return {
            "statusCode": 200,
            "body": json.dumps(
                {"message": f"Agent event saved successfully with key: {dynamo_key}"}
            ),
        }

    except ClientError as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"message": f"DynamoDB error: {str(e)}"}),
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"message": f"Error saving agent event: {str(e)}"}),
        }


def save_build_event(event_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Save build event to DynamoDB table.

    Args:
        event_data: The build event payload from Buildkite

    Returns:
        Dict[str, Any]: Response containing status and result information
    """
    try:
        build = event_data.get("build", {})
        repo_name = event_data.get("pipeline", {}).get("repository", "").split("/")[-1]
        build_number = build.get("number", "")

        if not repo_name or not build_number:
            return {
                "statusCode": 400,
                "body": json.dumps(
                    {"message": "Missing repository name or build number"}
                ),
            }

        dynamo_key = f"{repo_name}/{build_number}"

        item = {"dynamoKey": dynamo_key, **event_data}

        build_events_table.put_item(Item=item)

        return {
            "statusCode": 200,
            "body": json.dumps(
                {"message": f"Build event saved successfully with key: {dynamo_key}"}
            ),
        }

    except ClientError as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"message": f"DynamoDB error: {str(e)}"}),
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"message": f"Error saving build event: {str(e)}"}),
        }


def save_job_event(event_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Save job event to DynamoDB table.

    Args:
        event_data: The job event payload from Buildkite

    Returns:
        Dict[str, Any]: Response containing status and result information
    """
    try:
        job = event_data.get("job", {})
        repo_name = event_data.get("pipeline", {}).get("repository", "").split("/")[-1]
        job_id = job.get("id", "")

        if not repo_name or not job_id:
            return {
                "statusCode": 400,
                "body": json.dumps({"message": "Missing repository name or job ID"}),
            }

        dynamo_key = f"{repo_name}/{job_id}"

        item = {"dynamoKey": dynamo_key, **event_data}

        job_events_table.put_item(Item=item)

        return {
            "statusCode": 200,
            "body": json.dumps(
                {"message": f"Job event saved successfully with key: {dynamo_key}"}
            ),
        }

    except ClientError as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"message": f"DynamoDB error: {str(e)}"}),
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"message": f"Error saving job event: {str(e)}"}),
        }


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Main Lambda handler function for Buildkite webhook events.

    Args:
        event: Contains the webhook payload from Buildkite
        context: Provides runtime information about the Lambda function

    Returns:
        Dict[str, Any]: Response containing status and result information
    """
    try:
        if event.get("body"):
            body = json.loads(event["body"])
        else:
            body = event

        event_type = body.get("event")

        if not event_type:
            return {
                "statusCode": 400,
                "body": json.dumps(
                    {"message": "Missing event type in webhook payload"}
                ),
            }

        if event_type.startswith("agent."):
            return save_agent_event(body)
        elif event_type.startswith("build."):
            return save_build_event(body)
        elif event_type.startswith("job."):
            return save_job_event(body)
        else:
            return {
                "statusCode": 400,
                "body": json.dumps(
                    {"message": f"Unsupported event type: {event_type}"}
                ),
            }

    except json.JSONDecodeError as e:
        return {
            "statusCode": 400,
            "body": json.dumps({"message": f"Invalid JSON payload: {str(e)}"}),
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"message": f"Unexpected error: {str(e)}"}),
        }
