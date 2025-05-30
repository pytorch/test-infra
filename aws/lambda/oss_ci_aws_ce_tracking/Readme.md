# AWS Cost Explorer Data Processing
This Python script is designed to fetch and process AWS Cost Explorer data, specifically focusing on EC2 usage with Daily granularity.

This Lambda function runs daily and retrieves AWS Cost Explorer data for the date two days prior due to the delay in AWS Cost Explorer data availability.

## Usage
### Local Execution
To run the script locally, use the following command:

```bash
python lambda_function.py --clickhouse-endpoint <endpoint> --clickhouse-username <username> --clickhouse-password <password> [--not-dry-run] [--start-time <start_time>] [--end-time <end_time>]
```
*   `--clickhouse-endpoint`: The ClickHouse endpoint URL.
*   `--clickhouse-username`: The ClickHouse username.
*   `--clickhouse-password`: The ClickHouse password.
*   `--not-dry-run`: Optional. If set, the script will write results to the database.
*   `--start-time`: Optional. Start time in UTC ISO8601 format (e.g., 2025-05-28T00:00:00Z). Otherwise, the script will use the current time minus 2 day.
*   `--end-time`: Optional. End time in UTC ISO8601 format (e.g., 2025-05-29T00:00:00Z). Otherwise, the script will use the current time minus 1 day.
