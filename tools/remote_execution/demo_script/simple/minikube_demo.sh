#!/bin/bash
# Minikube Demo Script
# Tests log streaming with multiple print statements

set -euxo pipefail

echo "=== Minikube Demo: ${TEST_NAME:-unknown} ==="

for i in $(seq 1 5); do
    echo "[${TEST_NAME:-step}] Step $i: Processing..."
    sleep 2
done

echo "=== ${TEST_NAME:-Test} Complete ==="
