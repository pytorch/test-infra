# MODULE: Find Script
# Locates and validates the script to execute

if [[ -z "$TASK_ID" ]]; then
    echo "[Runner] Error: TASK_ID not set"
    exit 1
fi

# Debug: List all artifacts
echo "[Runner] Artifacts:"
find "$ARTIFACTS_DIR" -type f 2>/dev/null | sed "s|$ARTIFACTS_DIR/|[Runner]   |" | sort | head -20 || echo "[Runner]   (none)"

# Find the script for this task
SCRIPT_DIR="$ARTIFACTS_DIR/scripts/$TASK_ID"

if [[ ! -d "$SCRIPT_DIR" ]]; then
    echo "[Runner] Error: Script directory not found: $SCRIPT_DIR"
    exit 1
fi

# Use the specified script name directly
if [[ -n "$USER_SCRIPT_NAME" && -f "$SCRIPT_DIR/$USER_SCRIPT_NAME" ]]; then
    SCRIPT_PATH="$SCRIPT_DIR/$USER_SCRIPT_NAME"
    SCRIPT_NAME="$USER_SCRIPT_NAME"
    echo "[Runner] Using specified script: $SCRIPT_PATH"
else
    # Fallback: find user script (excluding runner.sh)
    SCRIPT_PATH=$(find "$SCRIPT_DIR" -name "*.sh" -type f ! -name "runner.sh" | head -1)
    if [[ -z "$SCRIPT_PATH" || ! -f "$SCRIPT_PATH" ]]; then
        echo "[Runner] Error: No script found in $SCRIPT_DIR"
        exit 1
    fi
    SCRIPT_NAME=$(basename "$SCRIPT_PATH")
fi

echo "[Runner] Found script: $SCRIPT_PATH"
