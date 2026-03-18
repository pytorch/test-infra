# MODULE: Upload Outputs
# Uploads outputs from OUTPUT_PATH to S3 (per-task directory)

# Upload user outputs
if [[ -d "$OUTPUT_PATH" && "$(ls -A $OUTPUT_PATH 2>/dev/null)" ]]; then
    OUTPUT_S3_PATH="${ARTIFACTS_PATH}outputs/${TASK_ID}/"
    echo "[Runner] Uploading outputs from $OUTPUT_PATH to $OUTPUT_S3_PATH"
    if aws s3 sync "$OUTPUT_PATH/" "$OUTPUT_S3_PATH" 2>&1 | sed 's/^/[Runner] /'; then
        echo "[Runner] ✓ Outputs uploaded to $OUTPUT_S3_PATH"
    else
        echo "[Runner] Warning: Failed to upload outputs"
    fi
else
    echo "[Runner] No outputs to upload (OUTPUT_PATH empty or missing)"
fi

# Upload logs (LOG_DIR set in bootstrap.sh, fallback to /tmp/work/logs)
LOG_DIR="${LOG_DIR:-/tmp/work/logs}"
echo "[Runner] Looking for logs in: $LOG_DIR"
if [[ -d "$LOG_DIR" ]]; then
    echo "[Runner] LOG_DIR contents:"
    ls -la "$LOG_DIR" 2>/dev/null | sed 's/^/[Runner] /' || echo "(empty)"
    if [[ "$(ls -A $LOG_DIR 2>/dev/null)" ]]; then
        LOGS_S3_PATH="${ARTIFACTS_PATH}logs/"
        echo "[Runner] Uploading logs from $LOG_DIR to $LOGS_S3_PATH"
        if aws s3 sync "$LOG_DIR/" "$LOGS_S3_PATH" 2>&1 | sed 's/^/[Runner] /'; then
            echo "[Runner] ✓ Logs uploaded to $LOGS_S3_PATH"
        else
            echo "[Runner] Warning: Failed to upload logs"
        fi
    else
        echo "[Runner] LOG_DIR exists but is empty"
    fi
else
    echo "[Runner] No logs to upload (LOG_DIR does not exist)"
fi

exit $SCRIPT_EXIT_CODE
