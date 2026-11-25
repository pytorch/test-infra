import argparse
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, TextIO

import boto3  # type: ignore[import-untyped]
import dateparser  # type: ignore[import-untyped]
from botocore.exceptions import (  # type: ignore[import-untyped]
    ClientError,
    NoCredentialsError,
)
from tqdm import tqdm  # type: ignore[import-untyped]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download the latest log stream from CloudWatch"
    )
    parser.add_argument(
        "function_name",
        help="Function/service name to download logs for",
        type=str,
    )
    parser.add_argument(
        "--log-group",
        help="Log group name. If short name (no '/'), will prefix with '/aws/lambda/'. "
        "If full path (starts with '/'), will use as-is. "
        "Default: /aws/lambda/{function_name}",
        type=str,
        default="",
    )
    parser.add_argument(
        "--output-file",
        help="Output file path. If not specified, logs will be printed to stdout",
        type=str,
        default="",
    )
    parser.add_argument(
        "--lines",
        help="Number of recent log lines to fetch (default: 1000)",
        type=int,
        default=1000,
    )
    parser.add_argument(
        "--start-time",
        help="Start time for log retrieval (e.g., '1 day ago', '2024-01-01T00:00:00')",
        type=str,
        default="1 day ago",
    )
    parser.add_argument(
        "--end-time",
        help="End time for log retrieval (e.g., 'now', '2024-01-01T23:59:59')",
        type=str,
        default="now",
    )
    parser.add_argument(
        "--dry-run",
        help="Show what would be downloaded without actually downloading",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--tail",
        help="Continuously poll for new logs and stream them in real-time",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--poll-interval",
        help="Interval in seconds between polling for new logs when using --tail (default: 5)",
        type=int,
        default=5,
    )
    options = parser.parse_args()
    return options


def get_log_group_name(function_name: str, log_group_arg: str) -> str:
    """
    Determine the log group name based on function name and log_group argument.

    If log_group_arg is empty, use /aws/lambda/{function_name}
    If log_group_arg starts with '/', use as-is
    Otherwise, prefix with /aws/lambda/
    """
    if not log_group_arg:
        return f"/aws/lambda/{function_name}"

    if log_group_arg.startswith("/"):
        return log_group_arg

    return f"/aws/lambda/{log_group_arg}"


def parse_timestamp(timestamp_str: str) -> int:
    """Parse timestamp string (ISO format or relative) to Unix timestamp in milliseconds."""
    # Note: 'UTC' is needed to make sure we get timezone-aware datetime objects.
    # 'PREFER_DATES_FROM': 'past' helps with relative dates like "1 day ago".
    settings = {"PREFER_DATES_FROM": "past", "TIMEZONE": "UTC"}
    dt = dateparser.parse(timestamp_str, settings=settings)
    if dt is None:
        raise ValueError(
            f"Invalid timestamp format: {timestamp_str}. "
            f"Use ISO format like '2024-01-01T00:00:00' or relative like '1 day ago'"
        )
    return int(dt.timestamp() * 1000)


def get_latest_log_streams(
    logs_client, log_group_name: str, limit: int = 5
) -> List[dict]:
    """Get the latest log streams from the log group."""
    try:
        response = logs_client.describe_log_streams(
            logGroupName=log_group_name,
            orderBy="LastEventTime",
            descending=True,
            limit=limit,
        )
        return response.get("logStreams", [])
    except ClientError as e:
        if e.response["Error"]["Code"] == "ResourceNotFoundException":
            raise ValueError(f"Log group '{log_group_name}' not found")
        raise


def download_log_events(
    logs_client,
    log_group_name: str,
    log_stream_name: str,
    start_time: Optional[int] = None,
    end_time: Optional[int] = None,
    lines_limit: Optional[int] = None,
    next_token: Optional[str] = None,
) -> tuple[List[dict], Optional[str]]:
    """Download log events from a specific log stream."""
    events = []

    kwargs = {
        "logGroupName": log_group_name,
        "logStreamName": log_stream_name,
        "startFromHead": False,  # Get most recent logs first
    }

    if start_time:
        kwargs["startTime"] = start_time
    if end_time:
        kwargs["endTime"] = end_time
    if next_token:
        kwargs["nextToken"] = next_token

    try:
        response = logs_client.get_log_events(**kwargs)
        events = response.get("events", [])
        next_token = response.get("nextForwardToken")

        # Sort by timestamp (most recent first)
        events.sort(key=lambda x: x["timestamp"], reverse=True)

        if lines_limit:
            events = events[:lines_limit]

    except ClientError as e:
        print(f"Error downloading log events: {e}")

    return events, next_token


def format_log_events(events: List[dict], log_stream_name: str) -> str:
    """Format log events into a readable string."""
    if not events:
        return f"No log events found in stream: {log_stream_name}\n"

    lines = [f"=== Log Stream: {log_stream_name} ===\n"]

    for event in reversed(events):  # Show chronologically (oldest first)
        timestamp = datetime.fromtimestamp(event["timestamp"] / 1000, tz=timezone.utc)
        formatted_time = timestamp.strftime("%Y-%m-%d %H:%M:%S UTC")
        message = event["message"].rstrip("\n")
        lines.append(f"[{formatted_time}] {message}\n")

    lines.append("\n")
    return "".join(lines)


def stream_logs(
    logs_client,
    log_group_name: str,
    start_time: Optional[int] = None,
    poll_interval: int = 5,
) -> None:
    """Stream logs in real-time."""
    print(f"Streaming logs from {log_group_name}... (Press Ctrl+C to stop)")

    # Keep track of the last seen event timestamp for each stream
    stream_tokens: Dict[str, str] = {}

    try:
        while True:
            # Get latest log streams
            log_streams = get_latest_log_streams(logs_client, log_group_name)

            for stream in log_streams:
                stream_name = stream["logStreamName"]
                next_token = stream_tokens.get(stream_name)

                events, new_token = download_log_events(
                    logs_client,
                    log_group_name,
                    stream_name,
                    start_time,
                    None,  # No end time for streaming
                    None,  # No line limit for streaming
                    next_token,
                )

                if new_token:
                    stream_tokens[stream_name] = new_token

                if events:
                    formatted_logs = format_log_events(events, stream_name)
                    print(formatted_logs, end="", flush=True)

            time.sleep(poll_interval)

    except KeyboardInterrupt:
        print("\nStopping log stream...")


def write_logs(f: TextIO, header: List[str], all_logs: List[str]) -> None:
    """Write logs to a file-like object."""
    f.writelines(header)
    for log_content in all_logs:
        f.write(log_content)


def main() -> None:
    options = parse_args()

    # Determine log group name
    log_group_name = get_log_group_name(options.function_name, options.log_group)

    # Parse time arguments if provided
    start_time = None
    end_time = None
    if options.start_time:
        start_time = parse_timestamp(options.start_time)
    if options.end_time:
        end_time = parse_timestamp(options.end_time)

    if options.dry_run:
        print(f"DRY RUN: Would download logs from {log_group_name}")
        if options.output_file:
            print(f"Output would be written to: {options.output_file}")
        return

    try:
        # Initialize CloudWatch Logs client
        logs_client = boto3.client("logs")

        if options.tail:
            stream_logs(logs_client, log_group_name, start_time, options.poll_interval)
            return

        # Get latest log streams
        log_streams = get_latest_log_streams(logs_client, log_group_name)

        if not log_streams:
            print(f"No log streams found in {log_group_name}")
            sys.exit(1)

        all_logs = []

        # Download logs from each stream
        for stream in tqdm(log_streams, desc="Downloading logs"):
            stream_name = stream["logStreamName"]

            events, _ = download_log_events(
                logs_client,
                log_group_name,
                stream_name,
                start_time,
                end_time,
                options.lines // len(log_streams)
                if len(log_streams) > 1
                else options.lines,
            )

            if events:
                formatted_logs = format_log_events(events, stream_name)
                all_logs.append(formatted_logs)

        if not all_logs:
            print("No log events found matching the criteria")
            sys.exit(1)

        # Prepare header
        header = [
            f"CloudWatch Logs for {options.function_name}\n",
            f"Log Group: {log_group_name}\n",
            f"Downloaded: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}\n",
            "=" * 80 + "\n\n",
        ]

        if options.output_file:
            # Write to output file
            with open(options.output_file, "w", encoding="utf-8") as f:
                write_logs(f, header, all_logs)
            print(f"Downloaded logs to: {options.output_file}")
        else:
            # Write to stdout
            write_logs(sys.stdout, header, all_logs)

    except NoCredentialsError:
        print(
            "Error: AWS credentials not found. Please configure your AWS credentials."
        )
        sys.exit(1)
    except (ValueError, ClientError, Exception) as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
