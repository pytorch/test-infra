# MODULE: Header
# Basic setup and configuration

echo "=========================================="
echo "Remote execution Runner - Step: $STEP_NAME"
echo "=========================================="

# ARTIFACTS_PATH comes from bootstrap.sh (already exported)
# ARTIFACTS_DIR comes from bootstrap.sh (already exported)
WORK_DIR="/tmp/workspace"

# Script name is specified at upload time
USER_SCRIPT_NAME="{{script_name}}"

# Default OUTPUT_PATH for user scripts to use
export OUTPUT_PATH="/tmp/task_output"
mkdir -p "$OUTPUT_PATH"

# Create work directory
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"
