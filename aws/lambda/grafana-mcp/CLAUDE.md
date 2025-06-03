# Claude HUD Interface Instructions

## Overview

You have a set of MCP tools at your disposal, clickhouse_mcp to list tables and generate queries / test queries, and grafana_mcp to actually create a dashboard that's publicly accessible.

## Before creating a dashboard

- use Clickhouse mcp tools to research the schema of the data source
- IMPORTANT: always test the query using Clickhouse mcp
- make sure that the query returns the expected results in the recent (or requested) time range

## notes

- current folder is a temporary directory, nothing interesting here
- for best results, use concise, clear queries
- use ONLY macros like `$__timeFilter(date_time_column_or_expression)` to filter by time range, avoid hardcoding time ranges in the query



# TorchCI ClickHouse Schema & Query Guide

This guide provides an overview of the TorchCI ClickHouse database schema for generating dashboards and answering CI-related questions. It focuses on the main tables, their relationships, and efficient query patterns.

## Key Tables and Schema

### Workflow Jobs (`workflow_job`)

Central table for CI job execution data with automatic access to workflow context via dictionaries:

```sql
-- Key fields
id                   -- Unique job ID
name                 -- Job name from workflow YAML
run_id               -- Reference to workflow_run.id
head_sha             -- Commit SHA that matches workflow_run.head_commit.id
labels               -- Array(String) with job labels
status, conclusion   -- Current status and final result
started_at, completed_at -- Execution timestamps

-- Linked workflow data (via dictionaries)
workflow_name         -- Name of the workflow
repository_full_name  -- Repository in owner/repo format
workflow_event        -- Event type (push, pull_request, etc)
workflow_created_at   -- When the workflow was created
```

Access workflow data directly from job records without joining:

```sql
SELECT 
  j.name, 
  j.conclusion, 
  j.workflow_name,    -- From workflow automatically
  j.workflow_event,   -- From workflow via dictionary
  j.repository_full_name
FROM default.workflow_job AS j
WHERE j.workflow_event = 'push'
```

### Workflow Runs (`workflow_run`)

Stores metadata for each CI pipeline execution:

```sql
-- Key fields
id                -- Unique workflow run ID
name              -- Workflow name
event             -- Trigger event (push, pull_request, schedule, etc)
head_sha          -- Commit being tested
head_branch       -- Branch name
head_commit       -- Tuple with commit details including id, message, author
pull_requests     -- Array with PR details when triggered by PR
repository        -- Tuple with repository details
status, conclusion -- Overall run status and result
created_at, updated_at -- Workflow timestamps
```

### Pull Requests (`pull_request`)

```sql
number            -- PR number
title, body       -- PR text content
state             -- open/closed/merged
labels            -- Array of label tuples with name, color, etc
head              -- Tuple with source branch details including sha
base              -- Tuple with target branch details
created_at, merged_at, closed_at -- Lifecycle timestamps
```

### Issues (`issues`)

```sql
number            -- Issue number
title, body       -- Issue text content
state             -- open/closed
labels            -- Array of label tuples with name, color, etc
user              -- Author details
created_at, updated_at, closed_at -- Lifecycle timestamps
```

### Additional Tables

- `push`: Contains push events and commit details including timestamps
- `job_annotation`: Contains annotations for workflow jobs

## Materialized Views

TorchCI maintains materialized views for common access patterns:

```sql
-- Optimize PR workflow lookups
materialized_views.workflow_run_by_pr_num (id, pr_number)

-- Optimize commit lookups
materialized_views.push_by_sha (id, timestamp)
```

Example usage:
```sql
-- Look up all workflow runs for a specific PR
SELECT * FROM workflow_run
WHERE id IN (
  SELECT id FROM materialized_views.workflow_run_by_pr_num
  WHERE pr_number = 154040  -- Much faster than filtering workflow_run directly
)
```

## Common Query Patterns

### Working with Array Fields

Two approaches for filtering arrays:

1. **ArrayExists** (preferred for simple filtering):

```sql
-- Find issues with specific label
SELECT issue.number, issue.title
FROM default.issues AS issue FINAL
WHERE arrayExists(x -> x.'name' = 'skipped', issue.labels)
```

2. **ARRAY JOIN** (for when you need to expand arrays):

```sql
-- Expand label arrays to count issues per label
SELECT 
  label.name AS label_name,
  count() AS issue_count
FROM default.issues AS iss FINAL
ARRAY JOIN iss.labels AS label
GROUP BY label_name
```

### Time-Series Aggregation

```sql
SELECT 
  toStartOfDay(j.completed_at) AS day,
  j.conclusion,
  count() AS job_count
FROM default.workflow_job AS j
WHERE j.completed_at >= (now() - INTERVAL 30 DAY)
GROUP BY day, j.conclusion
ORDER BY day
```

### Window Functions for Pattern Detection

ClickHouse supports powerful window functions for analyzing time-series patterns:

```sql
-- Example: Detect green/red/green pattern (flaky jobs)
SELECT job_name, 
  FIRST_VALUE(conclusion) OVER(
    PARTITION BY job_name
    ORDER BY commit_timestamp DESC ROWS BETWEEN CURRENT ROW AND 2 FOLLOWING
  ) = 0 /*success*/
  AND NTH_VALUE(conclusion, 2) OVER(...) = 1 /*failure*/
  AND LAST_VALUE(conclusion) OVER(...) = 0 /*success*/ AS is_flaky
FROM job_data
```

## Query Tips

1. **Use `FINAL` with caution**: Only needed when you require the latest state of a record (tables use ReplacingMergeTree)

2. **Filter early**: Always filter data before joins or expansions

3. **Use dictionaries**: Access workflow data from job records when possible

4. **Materialized views**: For common query patterns (PR lookups, commit history)

5. **Dot notation for nested fields**: Use consistent quoting `x.'field_name'` when accessing nested fields

6. **DateTime types**: Many timestamps use DateTime64(9) for nanosecond precision