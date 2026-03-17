# MODULE: Bootstrap
# Script for kube command - downloads all artifacts and sources runner.sh

set -e

ARTIFACTS_PATH="{{artifacts_path}}"
TASK_ID="${TASK_ID:-}"
ARTIFACTS_DIR="/tmp/artifacts"
WORK_DIR="/tmp/work"
LOG_DIR="${WORK_DIR}/logs"

# ============================================
# Setup logging - capture ALL output from here
# ============================================
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/task_${TASK_ID}.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "[Bootstrap] Starting..."
echo "[Bootstrap] ARTIFACTS_PATH: $ARTIFACTS_PATH"
echo "[Bootstrap] TASK_ID: $TASK_ID"
echo "[Bootstrap] LOG_FILE: $LOG_FILE"

# Create directories
mkdir -p "$ARTIFACTS_DIR"

# ============================================
# Install git if needed (required for --patch)
# ============================================
if ! command -v git &> /dev/null; then
    echo "[Bootstrap] Installing git..."
    if command -v apt-get &> /dev/null; then
        apt-get update -qq && apt-get install -y -qq git 2>/dev/null
    elif command -v yum &> /dev/null; then
        yum install -y -q git 2>/dev/null
    elif command -v apk &> /dev/null; then
        apk add --quiet git 2>/dev/null
    elif command -v conda &> /dev/null; then
        conda install -y -q git 2>/dev/null
    fi
    command -v git &> /dev/null && echo "[Bootstrap] ✓ git installed" || echo "[Bootstrap] Warning: git not available"
fi

# ============================================
# Install AWS CLI if needed
# ============================================
if ! command -v aws &> /dev/null; then
    echo "[Bootstrap] Installing AWS CLI..."
    AWS_INSTALLED=false

    # Try pip (works on vanilla python images)
    if ! $AWS_INSTALLED; then
        pip install awscli --quiet 2>/dev/null && AWS_INSTALLED=true
    fi
    # Try pip3
    if ! $AWS_INSTALLED; then
        pip3 install awscli --quiet 2>/dev/null && AWS_INSTALLED=true
    fi
    # Try pip with --break-system-packages (PEP 668 managed environments like conda)
    if ! $AWS_INSTALLED; then
        pip install awscli --quiet --break-system-packages 2>/dev/null && AWS_INSTALLED=true
    fi
    if ! $AWS_INSTALLED; then
        pip3 install awscli --quiet --break-system-packages 2>/dev/null && AWS_INSTALLED=true
    fi
    # Fallback: standalone AWS CLI v2 installer (no pip needed)
    if ! $AWS_INSTALLED; then
        echo "[Bootstrap] pip install failed, trying standalone AWS CLI installer..."
        curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip \
            && python3 -c "import zipfile; zipfile.ZipFile('/tmp/awscliv2.zip').extractall('/tmp/')" \
            && /tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli 2>/dev/null \
            && AWS_INSTALLED=true \
            || true
        rm -f /tmp/awscliv2.zip
    fi

    if $AWS_INSTALLED; then
        echo "[Bootstrap] ✓ AWS CLI installed"
    else
        echo "[Bootstrap] Error: Failed to install AWS CLI"
        exit 1
    fi
fi

# ============================================
# Download inputs.zip from S3
# ============================================
echo "[Bootstrap] Downloading inputs.zip..."
ZIP_FILE="/tmp/inputs.zip"

if aws s3 cp "${ARTIFACTS_PATH}inputs.zip" "$ZIP_FILE" --quiet 2>&1; then
    echo "[Bootstrap] ✓ Downloaded inputs.zip"

    # Extract
    if command -v unzip &> /dev/null; then
        unzip -q "$ZIP_FILE" -d "$ARTIFACTS_DIR/"
    else
        python3 -c "import zipfile; zipfile.ZipFile('$ZIP_FILE').extractall('$ARTIFACTS_DIR/')"
    fi
    echo "[Bootstrap] ✓ Extracted inputs"
    rm -f "$ZIP_FILE"
else
    echo "[Bootstrap] Error: Failed to download inputs.zip"
    exit 1
fi

# ============================================
# Download Previous Step Output (if set)
# Job-watcher sets DEPENDENT_ARTIFACTS_PATH for previous step outputs
# ============================================
PREV_ARTIFACTS_PATH="${DEPENDENT_ARTIFACTS_PATH:-}"
if [[ -n "$PREV_ARTIFACTS_PATH" ]]; then
    echo "[Bootstrap] Found PREV_ARTIFACTS_PATH: $PREV_ARTIFACTS_PATH"

    PREV_STEP_DIR="/tmp/prev_step_artifacts"
    mkdir -p "$PREV_STEP_DIR"

    if aws s3 sync "$PREV_ARTIFACTS_PATH" "$PREV_STEP_DIR/" 2>&1; then
        echo "[Bootstrap] ✓ Downloaded previous step artifacts to $PREV_STEP_DIR"
        ls -la "$PREV_STEP_DIR/" 2>/dev/null | head -10 || true
    else
        echo "[Bootstrap] Warning: Failed to download from $PREV_ARTIFACTS_PATH"
    fi

    export PREV_STEP_ARTIFACTS="$PREV_STEP_DIR"
fi

# ============================================
# Download Additional Artifacts (if set)
# ============================================
ADDITIONAL_PATHS="${ADDITIONAL_ARTIFACTS_PATHS:-}"
if [[ -n "$ADDITIONAL_PATHS" ]]; then
    echo "[Bootstrap] Found additional artifact paths"

    IFS=',' read -ra PATHS <<< "$ADDITIONAL_PATHS"

    for i in "${!PATHS[@]}"; do
        ADDITIONAL_DIR="/tmp/additional_artifacts_$i"
        mkdir -p "$ADDITIONAL_DIR"
        echo "[Bootstrap] Downloading ${PATHS[$i]} to $ADDITIONAL_DIR..."
        aws s3 sync "${PATHS[$i]}" "$ADDITIONAL_DIR/" 2>&1 || true
    done
fi

# ============================================
# Find and source runner.sh
# ============================================
RUNNER_PATH="$ARTIFACTS_DIR/scripts/$TASK_ID/runner.sh"

if [[ -f "$RUNNER_PATH" ]]; then
    echo "[Bootstrap] Found runner.sh at $RUNNER_PATH"
    chmod +x "$RUNNER_PATH"

    # Export for runner.sh
    export ARTIFACTS_PATH
    export ARTIFACTS_DIR
    export TASK_ID
    export WORK_DIR
    export LOG_DIR

    echo "[Bootstrap] Sourcing runner.sh..."
    echo ""
    source "$RUNNER_PATH"
else
    echo "[Bootstrap] Error: runner.sh not found at $RUNNER_PATH"
    echo "[Bootstrap] Contents of $ARTIFACTS_DIR/scripts/:"
    ls -la "$ARTIFACTS_DIR/scripts/" 2>/dev/null || echo "(directory not found)"
    exit 1
fi
