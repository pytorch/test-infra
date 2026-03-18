# MODULE: Run User Script
# Executes the user's script with proper error handling

echo ""
echo "=========================================="
echo "[Runner] Running: $SCRIPT_NAME"
echo "=========================================="

# Make script executable
chmod +x "$SCRIPT_PATH"

# Change to repo directory if available
if [[ -n "$REPO_DIR" && -d "$REPO_DIR" ]]; then
    cd "$REPO_DIR"
    echo "[Runner] Working directory: $REPO_DIR"
fi

# Run the script
echo "[Runner] Executing script..."
echo ""

set +e
bash "$SCRIPT_PATH"
SCRIPT_EXIT_CODE=$?
set -e

echo ""
echo "[Runner] Script finished with exit code: $SCRIPT_EXIT_CODE"
