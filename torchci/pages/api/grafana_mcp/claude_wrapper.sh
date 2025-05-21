#!/bin/bash

# Debug script for Claude CLI
echo "Claude wrapper script starting" >&2
echo "Query received: $*" >&2 # Print all arguments
echo "HOME: $HOME" >&2
echo "PWD: $(pwd)" >&2

# Combine all arguments back into a single query
QUERY="$*"

# Direct path to the Claude CLI.js
CLAUDE_JS_PATH="/Users/wouterdevriendt/.nvm/versions/node/v20.17.0/lib/node_modules/@anthropic-ai/claude-code/cli.js"
NODE_PATH="/Users/wouterdevriendt/.nvm/versions/node/v20.17.0/bin/node"

echo "Using Node at: $NODE_PATH" >&2
echo "Using Claude JS at: $CLAUDE_JS_PATH" >&2

# list of allowed mcp tools, in the format of mcp__$serverName__$toolName.

ALLOWED_TOOLS=(
    "mcp__grafana__create_time_series_dashboard",
    "mcp__clickhouse__readme_howto_use_clickhouse_tools",
    "mcp__clickhouse__run_clickhouse_query",
    "mcp__clickhouse__get_clickhouse_schema",
    "mcp__clickhouse__get_clickhouse_tables",
    "mcp__clickhouse__semantic_search_docs"
)

# allowed tools string as comma separated values
ALLOWED_TOOLS_STRING=$(
    IFS=,
    echo "${ALLOWED_TOOLS[*]}"
)

# Run Claude command, comma seperated allowedTools
"$NODE_PATH" "$CLAUDE_JS_PATH" -p "$QUERY" --output-format stream-json --allowedTools "$ALLOWED_TOOLS_STRING" 2>/dev/null || {
    echo "Claude command failed with exit code: $?" >&2
    exit 1
}

echo "Claude wrapper script finished" >&2
exit 0
