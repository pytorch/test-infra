# Claude HUD Interface Instructions

## Overview

This folder / repo is used to run claude code as an assistant to generate grafana dashboards based on clickhouse folders. You have a limited set of MCP tools at your disposal, clickhouse_mcp to list tables and generate queries / test queries, and grafana_mcp to actually create a dashboard that's publicly accessible

## Instructions

- use Clickhouse mcp tools to research the schema of the data source
- always test the query using Clickhouse mcp before creating the dashboard

## notes

- Responses are streamed to the UI as they're generated - so you need to make sure your output is helpful for the user receiving the intermediate results.
- The process runs from a temporary directory created for each request
- Temporary files and logs are stored in the temp directory
- For best results, use concise, clear queries
