#!/bin/bash
set -euo pipefail

# Blast CLI Setup
# Usage: ./setup.sh [--cluster CLUSTER_NAME] [--region REGION]

CLUSTER="${1:-pytorch-re-prod-production}"
REGION="${2:-us-east-2}"
VENV_DIR="$HOME/.blast-venv"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Blast CLI Setup ==="

# 1. Create virtual environment
if [ -d "$VENV_DIR" ]; then
    echo "[skip] Virtual environment already exists at $VENV_DIR"
else
    echo "[1/4] Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# 2. Activate
source "$VENV_DIR/bin/activate"

# 3. Install Blast CLI
echo "[2/4] Installing Blast CLI..."
pip install -e "$SCRIPT_DIR/blast" --quiet

# 4. Configure kubectl
echo "[3/4] Configuring kubectl for $CLUSTER ($REGION)..."
aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION"

# 5. Verify
echo "[4/4] Verifying..."
blast --help > /dev/null 2>&1 && echo "OK: blast CLI is working" || echo "FAIL: blast CLI not found"

echo ""
echo "=== Setup complete ==="
echo ""
echo "To activate in a new shell:"
echo "  source $VENV_DIR/bin/activate"
echo ""
echo "Quick start:"
echo "  blast --help"
echo '  blast run-steps --step build --script "echo hello remote execution!" --type cpu-44 --raw --follow'
echo ""
echo "Demo (two-step build + test):"
echo '  blast run-steps \'
echo '      --step build --script demo_script/simple/build_demo.sh --type cpu-44 \'
echo '      --step test --script demo_script/simple/test_demo.sh --type cpu-44 \'
echo '      --follow'
