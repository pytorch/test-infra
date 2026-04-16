# MODULE: Upload Outputs
# Uploads outputs as tar.gz archive + logs as individual files to S3

ARCHIVE_PATH="/tmp/task_artifacts_${TASK_ID}.tar.gz"
ARCHIVE_S3_PATH="${ARTIFACTS_PATH}artifacts/${TASK_ID}.tar.gz"
LOG_DIR="${LOG_DIR:-/tmp/work/logs}"
LOGS_S3_PATH="${ARTIFACTS_PATH}logs/${TASK_ID}/"

# 1) Upload outputs as tar.gz
if [[ -d "$OUTPUT_PATH" && "$(ls -A $OUTPUT_PATH 2>/dev/null)" ]]; then
    echo "[Runner] Outputs: $(ls -1 $OUTPUT_PATH | wc -l) file(s) in $OUTPUT_PATH"
    echo "[Runner] Packaging outputs..."
    tar czf "$ARCHIVE_PATH" -C / "${OUTPUT_PATH#/}" 2>&1 | sed 's/^/[Runner] /'
    ARCHIVE_SIZE=$(du -h "$ARCHIVE_PATH" | cut -f1)
    echo "[Runner] Archive: $ARCHIVE_SIZE"

    echo "[Runner] Uploading $ARCHIVE_PATH to $ARCHIVE_S3_PATH"
    if aws s3 cp "$ARCHIVE_PATH" "$ARCHIVE_S3_PATH" 2>&1 | sed 's/^/[Runner] /'; then
        echo "[Runner] ✓ Outputs uploaded to $ARCHIVE_S3_PATH"
    else
        echo "[Runner] Warning: Failed to upload outputs"
    fi
    rm -f "$ARCHIVE_PATH"
else
    echo "[Runner] No outputs to upload (OUTPUT_PATH empty or missing)"
fi

# 2) Upload logs as individual files
if [[ -d "$LOG_DIR" && "$(ls -A $LOG_DIR 2>/dev/null)" ]]; then
    echo "[Runner] Logs: $(ls -1 $LOG_DIR | wc -l) file(s) in $LOG_DIR"
    echo "[Runner] Uploading logs to $LOGS_S3_PATH"
    if aws s3 sync "$LOG_DIR" "$LOGS_S3_PATH" 2>&1 | sed 's/^/[Runner] /'; then
        echo "[Runner] ✓ Logs uploaded to $LOGS_S3_PATH"
    else
        echo "[Runner] Warning: Failed to upload logs"
    fi
else
    echo "[Runner] No logs to upload (LOG_DIR empty or missing)"
fi
