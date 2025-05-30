# AWS Cost Explorer Data Processing
This Python script is designed to fetch and process AWS Cost Explorer data, specifically focusing on EC2 usage with Daily granularity. The processed data is then prepared for insertion into a ClickHouse database.

## Features

- Fetches data from AWS Cost Explorer for EC2 usage.
- Processes and flattens the data for database insertion.
- Supports both local and AWS Lambda execution environments.
- Provides a dry-run mode for local testing.

## Requirements

- Python 3.x
- AWS SDK for Python (Boto3)
- ClickHouse Connect
- argparse
- Logging

## Environment Variables

The script requires the following environment variables to be set:

- `CLICKHOUSE_ENDPOINT`: The endpoint for the ClickHouse database.
- `CLICKHOUSE_USERNAME`: The username for ClickHouse authentication.
- `CLICKHOUSE_PASSWORD`: The password for ClickHouse authentication.

## Usage

### Local Execution

To run the script locally, use the following command:

```bash
python lambda_function.py --clickhouse-endpoint <endpoint> --clickhouse-username <username> --clickhouse-password <password> [--not-dry-run] [--start-time <start_time>] [--end-time <end_time>]
