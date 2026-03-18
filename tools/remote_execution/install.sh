#!/usr/bin/env bash
set -euo pipefail

REPO="pytorch/test-infra"

echo "=== Blast CLI Installer ==="
echo ""

# Check Python 3.9+
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found. Please install Python 3.9+."
    exit 1
fi

PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 9 ]; }; then
    echo "ERROR: Python 3.9+ required, found Python $PY_VERSION"
    exit 1
fi
echo "✓ Python $PY_VERSION"

# Install from latest GitHub Release
echo ""
echo "Installing Blast CLI from latest release..."
WHEEL_URL=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=50" | python3 -c "
import json, sys
for r in json.load(sys.stdin):
    if r['tag_name'].startswith('blast-v'):
        for a in r.get('assets', []):
            if a['name'].endswith('.whl'):
                print(a['browser_download_url'])
                sys.exit(0)
sys.exit(1)
")

if [[ -z "$WHEEL_URL" ]]; then
    echo "ERROR: No blast release found on GitHub"
    exit 1
fi

echo "Downloading: $WHEEL_URL"
pip install "$WHEEL_URL"
echo "✓ Blast CLI installed"

# Verify installation
if ! command -v blast &>/dev/null; then
    echo "ERROR: blast command not found after install. Check your PATH."
    exit 1
fi
echo "✓ blast command available"

# Configure kubectl for EKS cluster
echo ""
echo "Configuring kubectl for EKS cluster..."
if command -v aws &>/dev/null; then
    if ! aws eks update-kubeconfig --name pytorch-re-prod-production --region us-east-2; then
        echo ""
        echo "ERROR: Failed to configure kubectl."
        echo "  Make sure your AWS credentials are set up correctly:"
        echo "    aws sso login"
        echo "  Then re-run this script."
        exit 1
    fi
    echo "✓ kubectl configured"
else
    echo "⚠ aws CLI not found — skipping kubectl config."
    echo "  Install AWS CLI and run:"
    echo "    aws eks update-kubeconfig --name pytorch-re-prod-production --region us-east-2"
fi

echo ""
echo "=== Installation complete ==="
echo "Run 'blast --help' to get started."
