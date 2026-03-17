#!/bin/bash
# Test step: read artifact from previous step and display it

echo "=== Test Step ==="
echo "Reading build artifact from previous step..."

# PREV_STEP_ARTIFACTS is automatically set by runner
echo "PREV_STEP_ARTIFACTS: $PREV_STEP_ARTIFACTS"

CPU_COUNT=$(nproc)
echo "CPU count: $CPU_COUNT"

# Check if artifact exists
if [[ -f "$PREV_STEP_ARTIFACTS/build_result.txt" ]]; then
    echo ""
    echo "Found build artifact! Contents:"
    echo "--------------------------------"
    cat "$PREV_STEP_ARTIFACTS/build_result.txt"
    echo "--------------------------------"
    echo ""
    echo "Test PASSED: Successfully read build output!"
else
    echo "ERROR: build_result.txt not found!"
    echo "Contents of PREV_STEP_ARTIFACTS:"
    ls -la "$PREV_STEP_ARTIFACTS/" 2>/dev/null || echo "(directory empty or not found)"
    exit 1
fi

echo "=== Test Step Done ==="
