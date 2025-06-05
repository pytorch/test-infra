import os
import json
import boto3
from botocore.exceptions import ClientError
from typing import Dict, Any

# Configure AWS S3 client
s3_client = boto3.client("s3")


def authenticate(username: str, password: str) -> bool:
    """
    Authenticate request using environment variable credentials.

    Args:
        username (str): Username provided in the request
        password (str): Password provided in the request

    Returns:
        bool: True if authentication is successful, False otherwise
    """
    return username == os.environ.get("AUTH_USERNAME") and password == os.environ.get(
        "AUTH_PASSWORD"
    )


def check_path_exists(bucket: str, path: str) -> bool:
    """
    Check if a specific path exists in the S3 bucket.

    Args:
        bucket (str): The name of the S3 bucket
        path (str): The path to check within the bucket

    Returns:
        bool: True if the path exists, False otherwise
    """
    try:
        s3_client.head_object(Bucket=bucket, Key=path)
        return True
    except ClientError as e:
        # If the error code is 404, the path doesn't exist
        if e.response["Error"]["Code"] == "404":
            return False
        # For other errors, raise the exception
        raise


def upload_to_s3(bucket: str, path: str, content: str) -> Dict[str, Any]:
    """
    Upload content to a specific path in the S3 bucket.

    Args:
        bucket (str): The name of the S3 bucket
        path (str): The path within the bucket where content will be stored
        content (str): The content to upload

    Returns:
        Dict[str, Any]: Response from S3 upload
    """
    try:
        response = s3_client.put_object(
            Bucket=bucket, Key=path, Body=content, ContentType="application/json"
        )
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "message": f"File uploaded successfully to {bucket}/{path}",
                    "etag": response.get("ETag", ""),
                }
            ),
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"message": f"Error uploading file: {str(e)}"}),
        }


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Main Lambda handler function.

    Args:
        event (Dict[str, Any]): Contains input data for the Lambda function
            Required fields:
            - bucket_name: The name of the S3 bucket
            - path: The path within the bucket where content will be stored
            - content: The content to upload
            - username: Username for authentication
            - password: Password for authentication
        context (Any): Provides runtime information about the Lambda function

    Returns:
        Dict[str, Any]: Response containing status and result information
    """
    # Extract authentication parameters
    try:
        username = event["username"]
        password = event["password"]
    except KeyError:
        return {
            "statusCode": 401,
            "body": json.dumps({"message": "Authentication credentials are required"}),
        }

    # Validate authentication
    if not authenticate(username, password):
        return {
            "statusCode": 403,
            "body": json.dumps({"message": "Invalid authentication credentials"}),
        }

    # Extract input parameters from the event
    try:
        bucket_name = event["bucket_name"]
        path = event["path"]
        content = event["content"]
    except KeyError as e:
        return {
            "statusCode": 400,
            "body": json.dumps({"message": f"Missing required parameter: {str(e)}"}),
        }

    # Check if the path already exists in the bucket
    if check_path_exists(bucket_name, path):
        return {
            "statusCode": 409,  # Conflict status code
            "body": json.dumps(
                {"message": f"Path {path} already exists in bucket {bucket_name}"}
            ),
        }

    # Upload the content to S3
    return upload_to_s3(bucket_name, path, content)
